import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeServiceRole, leadingUsers, type FakeServiceRole } from '../operator/membership/fake-service-role';

// POST /api/family/leave の脱退通知メール (#1160)。
//
// 修正前は RPC (leave_family) を呼んで JSON を返すだけで、代表者にメールを送る処理が無かった。
// 脱退すると、本人は自分の所属先だった家族グループを RLS で読めなくなる (family_groups の SELECT は
// active なメンバーだけ)。そのため家族グループ名と代表者は RPC の前に読む必要がある (#1209 と同じ落とし穴)。
// このテストの RPC は、脱退後に家族グループを読めなくなる状況を再現する。
// 外部との境界 (Supabase・メール送信・ログ) はモックにし、宛先と本文を決める route 本体・共通ヘルパー・
// テンプレート・resolveAuthEmails は実物を通す。

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  adminClient: vi.fn(),
  sendEmail: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  withUser: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
    from: mocks.from,
  })),
  getSupabaseAdmin: () => mocks.adminClient(),
}));

vi.mock('@/lib/emails/send', () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: mocks.withUser,
  }),
  generateRequestId: () => 'req_test',
}));

import { POST } from '@/app/api/family/leave/route';

const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const OLD_FAMILY_ID = 'f1eebc99-9c0b-4ef8-bb6d-6bb9bd380a67';
const REP_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'; // 代表者 (花子): 通知を受ける
const OLD_REP_ID = 'a1eebc99-9c0b-4ef8-bb6d-6bb9bd380a12'; // 以前いた家族の代表者: 通知されない
const LEAVER_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'; // 大人 (太郎): 脱退する
const OTHER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33'; // ほかのメンバー (次郎): 通知されない

const REP_EMAIL = 'rep@example.com';
const OLD_REP_EMAIL = 'old-rep@example.com';
const LEAVER_EMAIL = 'taro@example.com';
const OTHER_EMAIL = 'jiro@example.com';

type SentEmail = { to: string; subject: string; text: string };

/**
 * 山田家: 代表者 (花子)・大人 (太郎)・大人 (次郎)。太郎は以前「旧田家」にもいて、その行は left。
 * 登録ユーザーが 50 人を超えている状態 (#1204)。
 */
function buildFake(): FakeServiceRole {
  return createFakeServiceRole({
    tables: {
      family_groups: [
        { id: FAMILY_ID, name: '山田家', representative_id: REP_ID },
        { id: OLD_FAMILY_ID, name: '旧田家', representative_id: OLD_REP_ID },
      ],
      family_members: [
        { id: 'm-rep', family_id: FAMILY_ID, user_id: REP_ID, role: 'representative', status: 'active' },
        { id: 'm-leaver', family_id: FAMILY_ID, user_id: LEAVER_ID, role: 'adult', status: 'active' },
        { id: 'm-other', family_id: FAMILY_ID, user_id: OTHER_ID, role: 'adult', status: 'active' },
        { id: 'm-old', family_id: OLD_FAMILY_ID, user_id: LEAVER_ID, role: 'adult', status: 'left' },
      ],
    },
    users: [
      ...leadingUsers(60),
      { id: REP_ID, email: REP_EMAIL },
      { id: OLD_REP_ID, email: OLD_REP_EMAIL },
      { id: LEAVER_ID, email: LEAVER_EMAIL },
      { id: OTHER_ID, email: OTHER_EMAIL },
    ],
  });
}

/** leave_family の戻り値 (supabase/baseline/prod_schema.sql): 更新後の family_members の行 */
const leftRow = {
  id: 'm-leaver',
  family_id: FAMILY_ID,
  user_id: LEAVER_ID,
  role: 'adult',
  display_name: '太郎',
  status: 'left',
  removed_at: '2026-10-08T00:00:00.000Z',
};

let fake: FakeServiceRole;
let originalBaseUrl: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  fake = buildFake();
  originalBaseUrl = process.env.NEXT_PUBLIC_INVITE_BASE_URL;
  process.env.NEXT_PUBLIC_INVITE_BASE_URL = 'https://app.example.test';

  mocks.getUser.mockResolvedValue({ data: { user: { id: LEAVER_ID, email: LEAVER_EMAIL } }, error: null });
  mocks.from.mockImplementation((table: string) => fake.from(table));
  mocks.adminClient.mockImplementation(() => ({ auth: fake.auth }));
  mocks.rpc.mockImplementation(async (name: string) => {
    fake.events.push(`rpc:${name}`);
    // 脱退したあとは、本人は家族グループもメンバーの行も RLS で読めない
    fake.tables.family_groups = [];
    fake.tables.family_members = [];
    return { data: { ...leftRow }, error: null };
  });
  mocks.sendEmail.mockResolvedValue({ id: 'email-1' });
  mocks.withUser.mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.logWarn,
    error: mocks.logError,
  }));
});

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.NEXT_PUBLIC_INVITE_BASE_URL;
  else process.env.NEXT_PUBLIC_INVITE_BASE_URL = originalBaseUrl;
});

const call = () => POST();

/** sendEmail に渡された封筒。同じ宛先に 2 通送っていたら気づけるよう配列で扱う */
const sentEmails = () => mocks.sendEmail.mock.calls.map(([envelope]) => envelope as SentEmail);
const sentTo = (address: string) => sentEmails().filter((envelope) => envelope.to === address);

/** ログ (警告・エラー) に渡された内容をすべて文字列にする。Error は name / message だけにする */
const loggedText = () =>
  JSON.stringify([...mocks.logWarn.mock.calls, ...mocks.logError.mock.calls], (_key, value) =>
    value instanceof Error ? { name: value.name, message: value.message } : value,
  );

describe('POST /api/family/leave: 脱退の通知メール (#1160)', () => {
  it('脱退が成功したら、代表者にだけ、家族グループ名とメンバー管理画面の URL つきの通知メールを送る', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('leave_family');
    expect(sentEmails()).toHaveLength(1);
    const [email] = sentTo(REP_EMAIL);
    expect(email.subject).toBe('【ほめゴハン】家族グループ「山田家」からメンバーが脱退しました');
    expect(email.text).toContain('家族グループ「山田家」のメンバーが 1 人、ご本人の操作で脱退しました。');
    expect(email.text).toContain('このメールは、家族グループの代表者にお送りしています。');
    expect(email.text.split('\n')).toContain('https://app.example.test/family/members');
    // 脱退した本人・ほかのメンバー・以前いた家族の代表者には送らない
    expect(sentTo(LEAVER_EMAIL)).toHaveLength(0);
    expect(sentTo(OTHER_EMAIL)).toHaveLength(0);
    expect(sentTo(OLD_REP_EMAIL)).toHaveLength(0);
  });

  it('家族グループ名と代表者は脱退の前に読み (脱退後は読めない)、宛先のアドレスは脱退のあとに引く', async () => {
    await call();

    const rpcAt = fake.events.indexOf('rpc:leave_family');
    const readsBefore = fake.events.slice(0, rpcAt);

    expect(rpcAt).toBeGreaterThan(-1);
    expect(readsBefore).toContain('read:family_members');
    expect(readsBefore).toContain('read:family_groups');
    expect(fake.events.indexOf('auth:getUserById')).toBeGreaterThan(rpcAt);
    // 脱退後に読み直していたら家族グループ名は空になる。読み直さないので名前つきの件名になっている
    expect(sentTo(REP_EMAIL)[0].subject).toContain('「山田家」');
  });

  it('通知先は、今 active な所属先 (山田家) の代表者。過去に left になった家族の代表者には送らない', async () => {
    await call();

    expect(fake.auth.admin.getUserById.mock.calls.map(([id]) => id)).toEqual([REP_ID]);
  });

  it('代表者のアドレスは、Auth ユーザー一覧の先頭 50 件より後ろにいても解決できる (#1204)。listUsers() は使わない', async () => {
    await call();

    expect(sentTo(REP_EMAIL)).toHaveLength(1);
    expect(fake.auth.admin.listUsers).not.toHaveBeenCalled();
  });

  it('メールアドレスを user_profiles から読まない (その列は無い)。読むのは family_members と family_groups だけ', async () => {
    await call();

    expect(fake.selects.map(({ table }) => table)).toEqual(['family_members', 'family_groups']);
    for (const { columns } of fake.selects) {
      expect(columns ?? '').not.toMatch(/\bemail\b/);
    }
  });

  it('レスポンスは今までどおり RPC の戻り値を返し、メールアドレスを含めない', async () => {
    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ data: leftRow });
    const body = JSON.stringify(json);
    for (const address of [REP_EMAIL, LEAVER_EMAIL, OTHER_EMAIL, OLD_REP_EMAIL]) {
      expect(body).not.toContain(address);
    }
  });

  it.each([
    [
      'IS_FAMILY_REPRESENTATIVE',
      409,
      'IS_FAMILY_REPRESENTATIVE',
      '代表者は脱退できません。先に代表者を他のメンバーに譲渡してください。',
    ],
    ['NOT_IN_FAMILY', 403, 'NOT_IN_FAMILY', '家族グループからの脱退に失敗しました'],
    ['NOT_AUTHENTICATED', 401, 'NOT_AUTHENTICATED', '家族グループからの脱退に失敗しました'],
    ['connection to server was lost', 500, 'UNKNOWN', '家族グループからの脱退に失敗しました'],
  ])('RPC が「%s」で失敗: %i と今までの文言を返し、メールは送らず、宛先の検索もしない', async (message, status, code, text) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message, code: 'P0001' } });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(status);
    expect(json.error).toEqual({ code, message: text });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('どの家族にも所属していない (RPC は NOT_IN_FAMILY): 403 を返し、メールは送らず、警告も出さない', async () => {
    fake.tables.family_members = [];
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'NOT_IN_FAMILY', code: 'P0001' } });

    const res = await call();

    expect(res.status).toBe(403);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('家族グループを読めなくても脱退は成功させ、代表者が分からないので誰にも送らず、警告ログに残す', async () => {
    fake.readErrors.family_groups = { message: 'permission denied', code: '42501' };

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ scope: 'family', scope_id: FAMILY_ID });
    expect(loggedText()).not.toContain('@example.');
  });

  it('所属の行を読めなくても脱退は成功させ、誰にも送らず、警告ログに残す', async () => {
    fake.readErrors.family_members = { message: 'connection reset by peer', code: '08006' };

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ scope: 'family' });
  });

  it('代表者のアドレスを取得できなくても 200 を返し、警告ログに残す (メールアドレスは残さない)', async () => {
    fake.authFailures.add(REP_ID);

    const res = await call();

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(leftRow);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.withUser).toHaveBeenCalledWith(LEAVER_ID);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 1, failed: 1, failed_user_ids: [REP_ID] });
    expect(loggedText()).not.toContain('@example.');
  });

  it('Auth 管理 API の環境変数が無くても脱退は成功させ、通知は送れなかったことを警告ログに残す', async () => {
    mocks.adminClient.mockImplementation(() => {
      throw new Error('Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });

  it('代表者がメールアドレスを持たない (電話番号のみなど) ときは送らず、失敗扱いにもしない', async () => {
    fake.users.find((user) => user.id === REP_ID)!.email = null;

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('メール送信に失敗しても 200 を返し、構造化ログに残す (メールアドレスは残さない)', async () => {
    const sendError = new Error('EMAIL_SEND_FAILED: temporarily unavailable');
    mocks.sendEmail.mockRejectedValue(sendError);

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ data: leftRow });
    expect(mocks.withUser).toHaveBeenCalledWith(LEAVER_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), sendError, {
      scope: 'family',
      scope_id: FAMILY_ID,
      recipient_user_id: REP_ID,
    });
    expect(loggedText()).not.toContain('@example.');
  });

  it('メール送信が同期的に例外を投げても 200 を返す', async () => {
    mocks.sendEmail.mockImplementation(() => {
      throw new Error('boom');
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it('未認証: 401 を返し、所属の読み取りも RPC も宛先の検索もメール送信もしない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('NOT_AUTHENTICATED');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(fake.events).toEqual([]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
