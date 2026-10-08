import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeServiceRole, leadingUsers, type FakeServiceRole } from '../operator/membership/fake-service-role';

// POST /api/org/leave の脱退通知メール (#1160)。
//
// 修正前は RPC (leave_org) を呼んで { ok: true } を返すだけで、オーナーにメールを送る処理が無かった。
// 脱退すると、本人は所属先だった組織を RLS で読めなくなる (organizations の SELECT は所属メンバーだけ)。
// また leave_org の戻り値 (更新後の user_profiles) の organization_id は NULL になる。
// そのため組織名とオーナーは RPC の前に読む必要がある (#1209 と同じ落とし穴)。
// このテストの RPC は、脱退後に組織を読めなくなる状況を再現する。
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

// 組織の route は createClient() を同期で呼ぶ
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
    from: mocks.from,
  }),
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

import { POST } from '@/app/api/org/leave/route';

const ORG_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const OTHER_ORG_ID = 'e1eebc99-9c0b-4ef8-bb6d-6bb9bd380a56';
const OWNER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'; // オーナー: 通知を受ける
const OTHER_OWNER_ID = 'a1eebc99-9c0b-4ef8-bb6d-6bb9bd380a12'; // 別の組織のオーナー: 通知されない
const MEMBER_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'; // 一般メンバー: 脱退する
const OTHER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33'; // ほかのメンバー: 通知されない

const OWNER_EMAIL = 'owner@example.com';
const OTHER_OWNER_EMAIL = 'other-owner@example.com';
const MEMBER_EMAIL = 'member@example.com';
const OTHER_EMAIL = 'other@example.com';

type SentEmail = { to: string; subject: string; text: string };

/** 株式会社ほめゴハン: オーナー・一般メンバー・ほかのメンバー。登録ユーザーが 50 人を超えている状態 (#1204) */
function buildFake(): FakeServiceRole {
  return createFakeServiceRole({
    tables: {
      user_profiles: [{ id: MEMBER_ID, organization_id: ORG_ID, org_role: 'member' }],
      organizations: [
        { id: ORG_ID, name: '株式会社ほめゴハン', owner_id: OWNER_ID },
        { id: OTHER_ORG_ID, name: '別の会社', owner_id: OTHER_OWNER_ID },
      ],
    },
    users: [
      ...leadingUsers(60),
      { id: OWNER_ID, email: OWNER_EMAIL },
      { id: OTHER_OWNER_ID, email: OTHER_OWNER_EMAIL },
      { id: MEMBER_ID, email: MEMBER_EMAIL },
      { id: OTHER_ID, email: OTHER_EMAIL },
    ],
  });
}

let fake: FakeServiceRole;
let originalBaseUrl: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  fake = buildFake();
  originalBaseUrl = process.env.NEXT_PUBLIC_INVITE_BASE_URL;
  process.env.NEXT_PUBLIC_INVITE_BASE_URL = 'https://app.example.test';

  mocks.getUser.mockResolvedValue({ data: { user: { id: MEMBER_ID, email: MEMBER_EMAIL } }, error: null });
  mocks.from.mockImplementation((table: string) => fake.from(table));
  mocks.adminClient.mockImplementation(() => ({ auth: fake.auth }));
  mocks.rpc.mockImplementation(async (name: string) => {
    fake.events.push(`rpc:${name}`);
    // 脱退したあとは、本人の所属 (organization_id) が外れ、組織の行も RLS で読めない。
    // leave_org の戻り値 (更新後の user_profiles) の organization_id も NULL
    fake.tables.organizations = [];
    fake.tables.user_profiles = [{ id: MEMBER_ID, organization_id: null, org_role: null }];
    return { data: { id: MEMBER_ID, organization_id: null, org_role: null }, error: null };
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

describe('POST /api/org/leave: 脱退の通知メール (#1160)', () => {
  it('脱退が成功したら、オーナーにだけ、組織名とメンバー管理画面の URL つきの通知メールを送る', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('leave_org');
    expect(sentEmails()).toHaveLength(1);
    const [email] = sentTo(OWNER_EMAIL);
    expect(email.subject).toBe('【ほめゴハン】組織「株式会社ほめゴハン」からメンバーが脱退しました');
    expect(email.text).toContain('組織「株式会社ほめゴハン」のメンバーが 1 人、ご本人の操作で脱退しました。');
    expect(email.text).toContain('このメールは、組織のオーナーにお送りしています。');
    expect(email.text.split('\n')).toContain('https://app.example.test/org/members');
    // 脱退した本人・ほかのメンバー・別の組織のオーナーには送らない
    expect(sentTo(MEMBER_EMAIL)).toHaveLength(0);
    expect(sentTo(OTHER_EMAIL)).toHaveLength(0);
    expect(sentTo(OTHER_OWNER_EMAIL)).toHaveLength(0);
  });

  it('組織名とオーナーは脱退の前に読み (脱退後は読めない)、宛先のアドレスは脱退のあとに引く', async () => {
    await call();

    const rpcAt = fake.events.indexOf('rpc:leave_org');
    const readsBefore = fake.events.slice(0, rpcAt);

    expect(rpcAt).toBeGreaterThan(-1);
    expect(readsBefore).toContain('read:user_profiles');
    expect(readsBefore).toContain('read:organizations');
    expect(fake.events.indexOf('auth:getUserById')).toBeGreaterThan(rpcAt);
    // 脱退後に読み直していたら組織名・オーナーは分からない。読み直さないので名前つきの件名になっている
    expect(sentTo(OWNER_EMAIL)[0].subject).toContain('「株式会社ほめゴハン」');
  });

  it('通知先は、脱退した組織のオーナー (organizations.owner_id) だけ。脱退した本人のアドレスは引かない', async () => {
    await call();

    expect(fake.auth.admin.getUserById.mock.calls.map(([id]) => id)).toEqual([OWNER_ID]);
  });

  it('オーナーのアドレスは、Auth ユーザー一覧の先頭 50 件より後ろにいても解決できる (#1204)。listUsers() は使わない', async () => {
    await call();

    expect(sentTo(OWNER_EMAIL)).toHaveLength(1);
    expect(fake.auth.admin.listUsers).not.toHaveBeenCalled();
  });

  it('メールアドレスを user_profiles から読まない (その列は無い)。読むのは自分の所属と組織だけ', async () => {
    await call();

    expect(fake.selects.map(({ table }) => table)).toEqual(['user_profiles', 'organizations']);
    for (const { columns } of fake.selects) {
      expect(columns ?? '').not.toMatch(/\bemail\b/);
    }
  });

  it('レスポンスは今までどおり { ok: true } で、メールアドレスを含めない', async () => {
    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });
    const body = JSON.stringify(json);
    for (const address of [OWNER_EMAIL, MEMBER_EMAIL, OTHER_EMAIL, OTHER_OWNER_EMAIL]) {
      expect(body).not.toContain(address);
    }
  });

  it('組織にオーナーがいない (owner_id が NULL) ときは、脱退は成功させ、誰にも送らず、宛先の検索もしない', async () => {
    fake.tables.organizations = [{ id: ORG_ID, name: '株式会社ほめゴハン', owner_id: null }];

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it.each([
    ['IS_ORG_OWNER', 409, 'IS_ORG_OWNER'],
    ['NOT_IN_ORG', 403, 'NOT_IN_ORG'],
    ['NOT_AUTHENTICATED', 401, 'NOT_AUTHENTICATED'],
    ['connection to server was lost', 500, 'UNKNOWN'],
  ])('RPC が「%s」で失敗: %i と今までの形式を返し、メールは送らず、宛先の検索もしない', async (message, status, code) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message, code: 'P0001' } });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(status);
    expect(json).toEqual({ error: { code, message } });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('どの組織にも所属していない (RPC は NOT_IN_ORG): 403 を返し、メールは送らず、警告も出さない', async () => {
    fake.tables.user_profiles = [{ id: MEMBER_ID, organization_id: null, org_role: null }];
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'NOT_IN_ORG', code: 'P0001' } });

    const res = await call();

    expect(res.status).toBe(403);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('組織を読めなくても脱退は成功させ、オーナーが分からないので誰にも送らず、警告ログに残す', async () => {
    fake.readErrors.organizations = { message: 'permission denied', code: '42501' };

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ scope: 'organization', scope_id: ORG_ID });
    expect(loggedText()).not.toContain('@example.');
  });

  it('自分の所属を読めなくても脱退は成功させ、誰にも送らず、警告ログに残す', async () => {
    fake.readErrors.user_profiles = { message: 'connection reset by peer', code: '08006' };

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ scope: 'organization' });
  });

  it('オーナーのアドレスを取得できなくても { ok: true } を返し、警告ログに残す (メールアドレスは残さない)', async () => {
    fake.authFailures.add(OWNER_ID);

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.withUser).toHaveBeenCalledWith(MEMBER_ID);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 1, failed: 1, failed_user_ids: [OWNER_ID] });
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

  it('オーナーがメールアドレスを持たない (電話番号のみなど) ときは送らず、失敗扱いにもしない', async () => {
    fake.users.find((user) => user.id === OWNER_ID)!.email = null;

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('メール送信に失敗しても { ok: true } を返し、構造化ログに残す (メールアドレスは残さない)', async () => {
    const sendError = new Error('EMAIL_SEND_FAILED: temporarily unavailable');
    mocks.sendEmail.mockRejectedValue(sendError);

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.withUser).toHaveBeenCalledWith(MEMBER_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), sendError, {
      scope: 'organization',
      scope_id: ORG_ID,
      recipient_user_id: OWNER_ID,
    });
    expect(loggedText()).not.toContain('@example.');
  });

  it('メール送信が同期的に例外を投げても { ok: true } を返す', async () => {
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
