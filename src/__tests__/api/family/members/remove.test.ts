import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeServiceRole, leadingUsers, type FakeServiceRole } from '../../operator/membership/fake-service-role';

// POST /api/family/members/[member_id]/remove の除名通知メール (#1160)。
//
// 修正前は RPC (remove_family_member) を呼んで JSON を返すだけで、外された本人にメールを送る処理が無かった。
// 外部との境界 (Supabase・メール送信・ログ) はモックにし、宛先と本文を決める route 本体・共通ヘルパー・
// テンプレート・resolveAuthEmails は実物を通す。
// このテストの RPC は本物と同じく、行の status を確かめず (すでに外れた行にも成功し)、行を 'removed' に書き換える。

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

import { POST } from '@/app/api/family/members/[member_id]/remove/route';

const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const REP_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'; // 代表者 (花子): 除名を実行する
const ADULT_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'; // 大人 (太郎): 除名される
const OTHER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33'; // ほかのメンバー (次郎): 通知されない
const LEFT_ID = 'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a34'; // すでに脱退した人 (三郎)

// family_members.id
const REP_ROW_ID = 'd9eebc99-9c0b-4ef8-bb6d-6bb9bd380a40';
const ADULT_ROW_ID = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44'; // 除名される
const OTHER_ROW_ID = 'd2eebc99-9c0b-4ef8-bb6d-6bb9bd380a46';
const CHILD_ROW_ID = 'd1eebc99-9c0b-4ef8-bb6d-6bb9bd380a45'; // アカウントを持たない子供
const LEFT_ROW_ID = 'd3eebc99-9c0b-4ef8-bb6d-6bb9bd380a47'; // すでに脱退した人の行 (status = left)

const REP_EMAIL = 'rep@example.com';
const ADULT_EMAIL = 'taro@example.com';
const OTHER_EMAIL = 'jiro@example.com';
const LEFT_EMAIL = 'saburo@example.com';

const REMOVED_AT = '2026-10-08T00:00:00.000Z';

type SentEmail = { to: string; subject: string; text: string };

/**
 * 山田家: 代表者 (花子)・大人 (太郎)・大人 (次郎)・アカウントを持たない子供・すでに脱退した人 (三郎)。
 * 登録ユーザーが 50 人を超えている状態 (#1204)。
 */
function buildFake(): FakeServiceRole {
  return createFakeServiceRole({
    tables: {
      family_groups: [{ id: FAMILY_ID, name: '山田家', representative_id: REP_ID }],
      family_members: [
        { id: REP_ROW_ID, family_id: FAMILY_ID, user_id: REP_ID, role: 'representative', status: 'active' },
        { id: ADULT_ROW_ID, family_id: FAMILY_ID, user_id: ADULT_ID, role: 'adult', status: 'active' },
        { id: OTHER_ROW_ID, family_id: FAMILY_ID, user_id: OTHER_ID, role: 'adult', status: 'active' },
        { id: CHILD_ROW_ID, family_id: FAMILY_ID, user_id: null, role: 'child', status: 'active' },
        { id: LEFT_ROW_ID, family_id: FAMILY_ID, user_id: LEFT_ID, role: 'adult', status: 'left' },
      ],
    },
    users: [
      ...leadingUsers(60),
      { id: REP_ID, email: REP_EMAIL },
      { id: ADULT_ID, email: ADULT_EMAIL },
      { id: OTHER_ID, email: OTHER_EMAIL },
      { id: LEFT_ID, email: LEFT_EMAIL },
    ],
  });
}

let fake: FakeServiceRole;

beforeEach(() => {
  vi.clearAllMocks();
  fake = buildFake();

  mocks.getUser.mockResolvedValue({ data: { user: { id: REP_ID, email: REP_EMAIL } }, error: null });
  mocks.from.mockImplementation((table: string) => fake.from(table));
  mocks.adminClient.mockImplementation(() => ({ auth: fake.auth }));
  // remove_family_member (supabase/baseline/prod_schema.sql): 行の status は確かめず、'removed' に書き換えて更新後の行を返す
  mocks.rpc.mockImplementation(async (name: string, args: { p_family_id: string; p_member_id: string }) => {
    fake.events.push(`rpc:${name}`);
    const row = fake.tables.family_members.find(
      (candidate) => candidate.id === args.p_member_id && candidate.family_id === args.p_family_id,
    );
    if (!row) return { data: null, error: { message: 'MEMBER_NOT_FOUND', code: 'P0001' } };
    row.status = 'removed';
    row.removed_at = REMOVED_AT;
    return { data: { ...row }, error: null };
  });
  mocks.sendEmail.mockResolvedValue({ id: 'email-1' });
  mocks.withUser.mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.logWarn,
    error: mocks.logError,
  }));
});

const call = (memberId: string = ADULT_ROW_ID, body: unknown = { family_id: FAMILY_ID }) =>
  POST(
    new Request(`http://localhost/api/family/members/${memberId}/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ member_id: memberId }) },
  );

/** sendEmail に渡された封筒。同じ宛先に 2 通送っていたら気づけるよう配列で扱う */
const sentEmails = () => mocks.sendEmail.mock.calls.map(([envelope]) => envelope as SentEmail);
const sentTo = (address: string) => sentEmails().filter((envelope) => envelope.to === address);

/** ログ (警告・エラー) に渡された内容をすべて文字列にする。Error は name / message だけにする */
const loggedText = () =>
  JSON.stringify([...mocks.logWarn.mock.calls, ...mocks.logError.mock.calls], (_key, value) =>
    value instanceof Error ? { name: value.name, message: value.message } : value,
  );

describe('POST /api/family/members/[member_id]/remove: 除名の通知メール (#1160)', () => {
  it('除名が成功したら、外された本人にだけ、家族グループ名つきの通知メールを送る', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('remove_family_member', {
      p_family_id: FAMILY_ID,
      p_member_id: ADULT_ROW_ID,
    });
    expect(sentEmails()).toHaveLength(1);
    const [email] = sentTo(ADULT_EMAIL);
    expect(email.subject).toBe('【ほめゴハン】家族グループ「山田家」から外されました');
    expect(email.text).toContain('家族グループ「山田家」のメンバーから外されました。');
    expect(email.text).toContain('個人アカウントは、引き続きご利用いただけます');
    // 除名を実行した代表者・ほかのメンバー・すでに脱退した人には送らない
    expect(sentTo(REP_EMAIL)).toHaveLength(0);
    expect(sentTo(OTHER_EMAIL)).toHaveLength(0);
    expect(sentTo(LEFT_EMAIL)).toHaveLength(0);
  });

  it('家族グループ名と外される人は除名の前に読み (除名後は status が変わる)、宛先のアドレスは除名のあとに引く', async () => {
    await call();

    const rpcAt = fake.events.indexOf('rpc:remove_family_member');
    const readsBefore = fake.events.slice(0, rpcAt);

    expect(rpcAt).toBeGreaterThan(-1);
    expect(readsBefore).toContain('read:family_groups');
    expect(readsBefore).toContain('read:family_members');
    expect(fake.events.indexOf('auth:getUserById')).toBeGreaterThan(rpcAt);
    // 除名後に行を読み直すと status が 'removed' になっていて通知されない。読み直さないので送れている
    expect(sentTo(ADULT_EMAIL)).toHaveLength(1);
  });

  it('宛先は、除名する行の user_id だけ。ほかのメンバーのアドレスは引かない', async () => {
    await call();

    expect(fake.auth.admin.getUserById.mock.calls.map(([id]) => id)).toEqual([ADULT_ID]);
  });

  it('宛先のアドレスは、Auth ユーザー一覧の先頭 50 件より後ろにいても解決できる (#1204)。listUsers() は使わない', async () => {
    await call();

    expect(sentTo(ADULT_EMAIL)).toHaveLength(1);
    expect(fake.auth.admin.listUsers).not.toHaveBeenCalled();
  });

  it('メールアドレスを user_profiles から読まない (その列は無い)。読むのは家族グループと家族の行だけ', async () => {
    await call();

    expect(fake.selects.map(({ table }) => table).sort()).toEqual(['family_groups', 'family_members']);
    for (const { columns } of fake.selects) {
      expect(columns ?? '').not.toMatch(/\bemail\b/);
    }
  });

  it('レスポンスは今までどおり RPC の戻り値を返し、メールアドレスを含めない', async () => {
    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      data: {
        member: {
          id: ADULT_ROW_ID,
          family_id: FAMILY_ID,
          user_id: ADULT_ID,
          role: 'adult',
          status: 'removed',
          removed_at: REMOVED_AT,
        },
      },
    });
    const body = JSON.stringify(json);
    for (const address of [REP_EMAIL, ADULT_EMAIL, OTHER_EMAIL, LEFT_EMAIL]) {
      expect(body).not.toContain(address);
    }
  });

  it('アカウントを持たない子供メンバー (user_id が NULL) の除名では、メールを送らず、宛先の検索もしない', async () => {
    const res = await call(CHILD_ROW_ID);

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('すでに脱退した人の行を除名しても (RPC は成功する)、メールは送らず、宛先の検索もしない', async () => {
    const res = await call(LEFT_ROW_ID);

    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('同じ行を何度除名しても、通知メールは最初の 1 通だけ (除名の繰り返しで同じ人に送り付けられない)', async () => {
    const first = await call();
    const second = await call();
    const third = await call();

    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
    expect(sentEmails()).toHaveLength(1);
    expect(sentTo(ADULT_EMAIL)).toHaveLength(1);
  });

  it('自分で自分を除名した場合 (実行者 = 外された本人) は、本人に通知しない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: ADULT_ID, email: ADULT_EMAIL } }, error: null });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
  });

  it.each([
    ['IS_FAMILY_REPRESENTATIVE', 409, 'IS_FAMILY_REPRESENTATIVE'],
    ['CANNOT_REMOVE_REPRESENTATIVE', 409, 'CANNOT_REMOVE_REPRESENTATIVE'],
    ['NOT_FAMILY_ADULT', 403, 'NOT_FAMILY_ADULT'],
    ['MEMBER_NOT_FOUND', 404, 'MEMBER_NOT_FOUND'],
    ['connection to server was lost', 500, 'UNKNOWN'],
  ])('RPC が「%s」で失敗: %i を返し、メールは送らず、宛先の検索もしない', async (message, status, code) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message, code: 'P0001' } });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(status);
    expect(json.error.code).toBe(code);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('宛先のアドレスを取得できなくても 200 を返し、警告ログに残す (メールアドレスは残さない)', async () => {
    fake.authFailures.add(ADULT_ID);

    const res = await call();

    expect(res.status).toBe(200);
    expect((await res.json()).data.member.id).toBe(ADULT_ROW_ID);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.withUser).toHaveBeenCalledWith(REP_ID);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 1, failed: 1, failed_user_ids: [ADULT_ID] });
    expect(loggedText()).not.toContain('@example.');
  });

  it('Auth 管理 API の環境変数が無くても除名は成功させ、通知は送れなかったことを警告ログに残す', async () => {
    mocks.adminClient.mockImplementation(() => {
      throw new Error('Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });

  it('宛先のメールアドレスを持たない人 (電話番号のみなど) には送らず、失敗扱いにもしない', async () => {
    fake.users.find((user) => user.id === ADULT_ID)!.email = null;

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
    expect(json.data.member.id).toBe(ADULT_ROW_ID);
    expect(mocks.withUser).toHaveBeenCalledWith(REP_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), sendError, {
      scope: 'family',
      scope_id: FAMILY_ID,
      recipient_user_id: ADULT_ID,
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

  it('家族グループ名を読めなくても除名は成功させ、名前なしの文面で通知し、警告ログに残す', async () => {
    fake.readErrors.family_groups = { message: 'permission denied', code: '42501' };

    const res = await call();

    expect(res.status).toBe(200);
    const [email] = sentTo(ADULT_EMAIL);
    expect(email.subject).toBe('【ほめゴハン】家族グループから外されました');
    expect(email.text).toContain('家族グループのメンバーから外されました。');
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ scope: 'family', scope_id: FAMILY_ID });
    expect(loggedText()).not.toContain('@example.');
  });

  it('除名する行を読めなくても除名は成功させ、初めての除名か確かめられないので送らず、警告ログに残す', async () => {
    fake.readErrors.family_members = { message: 'connection reset by peer', code: '08006' };

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ scope: 'family', scope_id: FAMILY_ID });
    expect(loggedText()).not.toContain('@example.');
  });

  it('未認証: 401 を返し、家族の読み取りも RPC も宛先の検索もメール送信もしない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('NOT_AUTHENTICATED');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(fake.events).toEqual([]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('body が JSON でない / family_id が無い: 400 を返し、RPC もメール送信もしない', async () => {
    const invalid = await call(ADULT_ROW_ID, '{not json');
    const missing = await call(ADULT_ROW_ID, {});

    expect(invalid.status).toBe(400);
    expect(missing.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(fake.events).toEqual([]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
