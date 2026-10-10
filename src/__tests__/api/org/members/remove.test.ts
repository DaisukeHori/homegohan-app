import { describe, it, expect, vi, beforeEach } from 'vitest';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';
import { createFakeServiceRole, leadingUsers, type FakeServiceRole } from '../../operator/membership/fake-service-role';

// POST /api/org/members/[user_id]/remove の除名通知メール (#1160)。
//
// 修正前は RPC (remove_org_member) を呼んで { ok: true } を返すだけで、外された本人にメールを送る処理が無かった。
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

import { POST } from '@/app/api/org/members/[user_id]/remove/route';

const ORG_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const OWNER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'; // オーナー: 除名を実行する
const MEMBER_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'; // 一般メンバー: 除名される
const OTHER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33'; // ほかのメンバー: 通知されない

const OWNER_EMAIL = 'owner@example.com';
const MEMBER_EMAIL = 'member@example.com';
const OTHER_EMAIL = 'other@example.com';

type SentEmail = { to: string; subject: string; text: string };

/** 株式会社ほめゴハン: オーナー・一般メンバー・ほかのメンバー。登録ユーザーが 50 人を超えている状態 (#1204) */
function buildFake(): FakeServiceRole {
  return createFakeServiceRole({
    tables: {
      user_profiles: [{ id: OWNER_ID, organization_id: ORG_ID, org_role: 'owner' }],
      organizations: [{ id: ORG_ID, name: '株式会社ほめゴハン', owner_id: OWNER_ID }],
    },
    users: [
      ...leadingUsers(60),
      { id: OWNER_ID, email: OWNER_EMAIL },
      { id: MEMBER_ID, email: MEMBER_EMAIL },
      { id: OTHER_ID, email: OTHER_EMAIL },
    ],
  });
}

let fake: FakeServiceRole;

beforeEach(() => {
  vi.clearAllMocks();
  fake = buildFake();

  mocks.getUser.mockResolvedValue({ data: { user: { id: OWNER_ID, email: OWNER_EMAIL } }, error: null });
  mocks.from.mockImplementation((table: string) => fake.from(table));
  mocks.adminClient.mockImplementation(() => ({ auth: fake.auth }));
  mocks.rpc.mockImplementation(async (name: string) => {
    fake.events.push(`rpc:${name}`);
    // remove_org_member の戻り値: 更新後の user_profiles の行 (所属は外れている)
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

const call = (userId: string = MEMBER_ID) =>
  POST(new Request(`http://localhost/api/org/members/${userId}/remove`, { method: 'POST' }), {
    params: { user_id: userId },
  });

/** sendEmail に渡された封筒。同じ宛先に 2 通送っていたら気づけるよう配列で扱う */
const sentEmails = () => mocks.sendEmail.mock.calls.map(([envelope]) => envelope as SentEmail);
const sentTo = (address: string) => sentEmails().filter((envelope) => envelope.to === address);

/** ログ (警告・エラー) に渡された内容をすべて文字列にする。Error は name / message だけにする */
const loggedText = () =>
  JSON.stringify([...mocks.logWarn.mock.calls, ...mocks.logError.mock.calls], (_key, value) =>
    value instanceof Error ? { name: value.name, message: value.message } : value,
  );

describe('POST /api/org/members/[user_id]/remove: 除名の通知メール (#1160)', () => {
  it('除名が成功したら、外された本人にだけ、組織名つきの通知メールを送る', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('remove_org_member', {
      p_organization_id: ORG_ID,
      p_user_id: MEMBER_ID,
    });
    expect(sentEmails()).toHaveLength(1);
    const [email] = sentTo(MEMBER_EMAIL);
    expect(email.subject).toBe('【ほめゴハン】組織「株式会社ほめゴハン」から外されました');
    expect(email.text).toContain('組織「株式会社ほめゴハン」のメンバーから外されました。');
    expect(email.text).toContain('組織で記録した個人データも、あなたのアカウントに残ります');
    // 除名を実行したオーナー・ほかのメンバーには送らない
    expect(sentTo(OWNER_EMAIL)).toHaveLength(0);
    expect(sentTo(OTHER_EMAIL)).toHaveLength(0);
  });

  it('管理者 (admin) が除名したときも、外された本人にだけ送る', async () => {
    fake.tables.user_profiles = [{ id: OWNER_ID, organization_id: ORG_ID, org_role: 'admin' }];

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((envelope) => envelope.to)).toEqual([MEMBER_EMAIL]);
  });

  it('組織名は除名の前に読み、宛先のアドレスは除名のあとに引く', async () => {
    await call();

    const readAt = fake.events.indexOf('read:organizations');
    const rpcAt = fake.events.indexOf('rpc:remove_org_member');
    const lookupAt = fake.events.indexOf('auth:getUserById');

    expect(readAt).toBeGreaterThan(-1);
    expect(rpcAt).toBeGreaterThan(readAt);
    expect(lookupAt).toBeGreaterThan(rpcAt);
  });

  it('宛先は URL の user_id (RPC が組織の所属を確認した人) だけ。アドレスは先頭 50 件より後ろでも解決でき、listUsers() は使わない (#1204)', async () => {
    await call();

    expect(sentTo(MEMBER_EMAIL)).toHaveLength(1);
    expect(fake.auth.admin.getUserById.mock.calls.map(([id]) => id)).toEqual([MEMBER_ID]);
    expect(fake.auth.admin.listUsers).not.toHaveBeenCalled();
  });

  it('メールアドレスを user_profiles から読まない (その列は無い)', async () => {
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
    for (const address of [OWNER_EMAIL, MEMBER_EMAIL, OTHER_EMAIL]) {
      expect(body).not.toContain(address);
    }
  });

  it.each([
    ['USER_NOT_IN_ORG', 404, 'USER_NOT_IN_ORG'],
    ['CANNOT_REMOVE_OWNER', 409, 'CANNOT_REMOVE_OWNER'],
    ['NOT_ORG_OWNER', 403, 'NOT_ORG_OWNER'],
    ['NOT_ORG_ADMIN', 403, 'NOT_ORG_ADMIN'],
  ])('RPC が「%s」で失敗: %i とコード、固定の文を返し、メールは送らず、宛先の検索もしない', async (message, status, code) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message, code: 'P0001' } });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(status);
    // RPC の文面ではなく、こちらで決めた文を返す (#1172)。画面はコードで出し分けるか、この文を出す
    expect(json).toEqual({ error: { code, message: 'メンバーの除名に失敗しました' } });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('RPC が分からないエラー (接続の切断など) で失敗: 汎用の 500 を返し、生のエラー文は構造化ログにだけ残す (#1172)', async () => {
    const rawMessage = 'connection to server was lost (secret_host_xyz)';
    mocks.rpc.mockResolvedValue({ data: null, error: { message: rawMessage, code: '08006' } });

    const res = await call();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE } });
    expect(text).not.toContain('secret_host_xyz');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect((mocks.logError.mock.calls[0][1] as Error).message).toBe(rawMessage);
  });

  it('owner / admin 以外は 403 を返し、組織の読み取りも RPC もメール送信もしない', async () => {
    fake.tables.user_profiles = [{ id: OWNER_ID, organization_id: ORG_ID, org_role: 'member' }];

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('INSUFFICIENT_PERMISSION');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(fake.events).toEqual(['read:user_profiles']);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('user_id が空: 400 を返し、RPC もメール送信もしない', async () => {
    const res = await call('');

    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('宛先のアドレスを取得できなくても { ok: true } を返し、警告ログに残す (メールアドレスは残さない)', async () => {
    fake.authFailures.add(MEMBER_ID);

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.withUser).toHaveBeenCalledWith(OWNER_ID);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 1, failed: 1, failed_user_ids: [MEMBER_ID] });
    expect(loggedText()).not.toContain('@example.');
  });

  it('Auth 管理 API の環境変数が無くても除名は成功させ、通知は送れなかったことを警告ログに残す', async () => {
    mocks.adminClient.mockImplementation(() => {
      throw new Error('Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });

  it('宛先のメールアドレスを持たない人 (電話番号のみなど) には送らず、失敗扱いにもしない', async () => {
    fake.users.find((user) => user.id === MEMBER_ID)!.email = null;

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
    expect(mocks.withUser).toHaveBeenCalledWith(OWNER_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), sendError, {
      scope: 'organization',
      scope_id: ORG_ID,
      recipient_user_id: MEMBER_ID,
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

  it('組織名を読めなくても除名は成功させ、名前なしの文面で通知し、警告ログに残す', async () => {
    fake.readErrors.organizations = { message: 'permission denied', code: '42501' };

    const res = await call();

    expect(res.status).toBe(200);
    const [email] = sentTo(MEMBER_EMAIL);
    expect(email.subject).toBe('【ほめゴハン】組織から外されました');
    expect(email.text).toContain('組織のメンバーから外されました。');
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ scope: 'organization', scope_id: ORG_ID });
    expect(loggedText()).not.toContain('@example.');
  });

  it('未認証: 401 を返し、プロフィールの読み取りも RPC も宛先の検索もメール送信もしない', async () => {
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
