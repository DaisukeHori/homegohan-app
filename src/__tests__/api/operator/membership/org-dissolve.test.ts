import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmailSendError } from '@/lib/emails/send-result';
import { NextRequest } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createFakeServiceRole, leadingUsers, type FakeServiceRole } from './fake-service-role';

// POST /api/operator/membership/org/[id]/dissolve の通知メール (#1204)。
//
// 修正前は宛先を auth.admin.listUsers() (引数なしでは先頭 50 件のみ) から探していたため、登録ユーザーが
// 50 人を超えると宛先が見つからず、強制解散の本人通知メールが例外もログもなくスキップされた。
// 外部との境界はすべてモックにする。宛先・本文を決める本体 (route と renderForceDissolveEmail) は実物を通す。

const mocks = vi.hoisted(() => ({
  requireSuperAdmin: vi.fn(),
  rpc: vi.fn(),
  createServiceRoleClient: vi.fn(),
  sendEmail: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  withUser: vi.fn(),
}));

vi.mock('@/lib/auth/operator-permissions', () => ({
  requireSuperAdmin: mocks.requireSuperAdmin,
}));

// RPC は運営者本人のセッションで実行される (cookies() を使う本物の createClient は使わない)。
// service-role のクライアントは本物の getSupabaseAdmin を通す (#1162。接続情報は env-required の getter で取り出し、
// 下で差し替えた @supabase/supabase-js の createClient で作る)。呼ばれた回数を数える
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return {
    createClient: () => ({ rpc: mocks.rpc }),
    getSupabaseAdmin: vi.fn(actual.getSupabaseAdmin),
  };
});

// service-role クライアント (getSupabaseAdmin が作る) の実体
vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createServiceRoleClient,
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

import { POST } from '@/app/api/operator/membership/org/[id]/dissolve/route';
import { getSupabaseAdmin } from '@/lib/supabase/server';

const OPERATOR_ID = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';
const ORG_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const OTHER_ORG_ID = 'e1eebc99-9c0b-4ef8-bb6d-6bb9bd380a56';
const OWNER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const ADMIN_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const MEMBER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
const STRANGER_ID = 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a35';
const NO_ORG_ID = 'c3eebc99-9c0b-4ef8-bb6d-6bb9bd380a36';

const OWNER_EMAIL = 'owner@example.com';
const ADMIN_EMAIL = 'admin@example.com';
const MEMBER_EMAIL = 'member@example.com';
const STRANGER_EMAIL = 'stranger@example.com';
const NO_ORG_EMAIL = 'no-org@example.com';

const REASON = '契約が終了し、利用実態もないため';
const RPC_NAME = 'operator_force_dissolve_org';

type SentEmail = { to: string; subject: string; text: string };

/**
 * ほめゴハン株式会社: オーナー (社長)・管理者 (部長)・一般社員が所属。ほかに別会社の人、どの組織にも属さない人がいる。
 * leadingUserCount を指定すると、登録順で先頭にその人数の無関係なユーザーが並ぶ (#1204: 50 人超の登録状況)。
 */
function buildFake(leadingUserCount = 60): FakeServiceRole {
  return createFakeServiceRole({
    tables: {
      organizations: [
        { id: ORG_ID, name: 'ほめゴハン株式会社', owner_id: OWNER_ID, status: 'active' },
        { id: OTHER_ORG_ID, name: '別の会社', owner_id: STRANGER_ID, status: 'active' },
      ],
      user_profiles: [
        { id: OWNER_ID, nickname: '社長', organization_id: ORG_ID, org_role: 'owner' },
        { id: ADMIN_ID, nickname: '部長', organization_id: ORG_ID, org_role: 'admin' },
        { id: MEMBER_ID, nickname: '社員', organization_id: ORG_ID, org_role: 'member' },
        { id: STRANGER_ID, nickname: '別会社の人', organization_id: OTHER_ORG_ID, org_role: 'owner' },
        { id: NO_ORG_ID, nickname: '無所属', organization_id: null, org_role: null },
      ],
    },
    users: [
      ...leadingUsers(leadingUserCount),
      { id: OWNER_ID, email: OWNER_EMAIL },
      { id: ADMIN_ID, email: ADMIN_EMAIL },
      { id: MEMBER_ID, email: MEMBER_EMAIL },
      { id: STRANGER_ID, email: STRANGER_EMAIL },
      { id: NO_ORG_ID, email: NO_ORG_EMAIL },
    ],
  });
}

/**
 * operator_force_dissolve_org の挙動 (supabase/baseline/prod_schema.sql) を再現する。
 * ★所属していた全員の organization_id を NULL にして、解散済みの組織の行を返す。RPC の後に読み直すと誰も残っていない。
 */
function simulateDissolve(fake: FakeServiceRole, args: { p_organization_id: string; p_reason: string }) {
  fake.events.push(`rpc:${RPC_NAME}`);
  const org = fake.tables.organizations.find((o) => o.id === args.p_organization_id);
  if (!org) return { data: null, error: { message: 'ORG_NOT_FOUND', code: 'P0001' } };
  for (const profile of fake.tables.user_profiles) {
    if (profile.organization_id === args.p_organization_id) {
      profile.organization_id = null;
      profile.org_role = null;
    }
  }
  org.status = 'dissolved';
  return { data: { ...org }, error: null };
}

let fake: FakeServiceRole;

beforeEach(() => {
  vi.clearAllMocks();
  // 本物のキーではないダミー値 (getSupabaseAdmin は環境変数の有無だけを見る)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

  fake = buildFake();
  mocks.createServiceRoleClient.mockImplementation(() => fake.client);
  mocks.requireSuperAdmin.mockResolvedValue({ userId: OPERATOR_ID });
  mocks.rpc.mockImplementation(async (name: string, args: { p_organization_id: string; p_reason: string }) => {
    if (name !== RPC_NAME) throw new Error(`unexpected rpc: ${name}`);
    return simulateDissolve(fake, args);
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
  vi.unstubAllEnvs();
});

const postRequest = (body: unknown) =>
  new NextRequest(`http://localhost/api/operator/membership/org/${ORG_ID}/dissolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const validBody = { reason: REASON };

const call = (body: unknown = validBody, orgId: string = ORG_ID) =>
  POST(postRequest(body), { params: Promise.resolve({ id: orgId }) });

/** sendEmail に渡された封筒。同じ宛先に 2 通送っていたら気づけるよう配列で扱う */
const sentEmails = () => mocks.sendEmail.mock.calls.map(([envelope]) => envelope as SentEmail);
const sentTo = (address: string) => sentEmails().filter((envelope) => envelope.to === address);

describe('POST /api/operator/membership/org/[id]/dissolve: 通知メールの宛先と本文 (#1204)', () => {
  it('解散時点の所属メンバー全員 (Auth ユーザー一覧の先頭 50 件の外にいる人を含む) に解散を知らせる', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(RPC_NAME, { p_organization_id: ORG_ID, p_reason: REASON });
    expect(sentEmails().map((envelope) => envelope.to).sort()).toEqual([OWNER_EMAIL, ADMIN_EMAIL, MEMBER_EMAIL].sort());
    for (const envelope of sentEmails()) {
      expect(envelope.subject).toContain('ほめゴハン株式会社');
      expect(envelope.text).toContain('ほめゴハン株式会社');
      expect(envelope.text).toContain(REASON);
    }
    // 宛名は各自のニックネーム
    expect(sentTo(OWNER_EMAIL)[0].text).toContain('社長 様');
    expect(sentTo(ADMIN_EMAIL)[0].text).toContain('部長 様');
    expect(sentTo(MEMBER_EMAIL)[0].text).toContain('社員 様');
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('宛先は解散した組織に所属していた人だけ (別の組織・どこにも属さない人には送らない)、1 人 1 通', async () => {
    await call();

    expect(sentTo(STRANGER_EMAIL)).toHaveLength(0);
    expect(sentTo(NO_ORG_EMAIL)).toHaveLength(0);
    expect(sentEmails()).toHaveLength(3);
  });

  it('通知先の人のメールアドレスだけを 1 人ずつ引く (listUsers は使わない)', async () => {
    await call();

    expect(fake.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById.mock.calls.map(([id]) => id).sort()).toEqual(
      [OWNER_ID, ADMIN_ID, MEMBER_ID].sort(),
    );
  });

  it('メンバーは RPC を実行する前に取得する (RPC の後は誰も組織に所属していない)', async () => {
    await call();

    const rpcAt = fake.events.indexOf(`rpc:${RPC_NAME}`);
    const memberReads = fake.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === 'read:user_profiles');

    expect(rpcAt).toBeGreaterThan(-1);
    expect(memberReads.map(({ index }) => index < rpcAt)).toEqual([true]);
  });

  it('RPC の戻り値 (解散済みの組織) はそのままレスポンスの data に返す', async () => {
    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ id: ORG_ID, name: 'ほめゴハン株式会社', status: 'dissolved' });
  });

  it('一部の人のメールアドレスを取得できなくても、取得できた人には送り、取得できなかった人数を警告ログに残す', async () => {
    fake.authFailures.add(ADMIN_ID);

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((envelope) => envelope.to).sort()).toEqual([OWNER_EMAIL, MEMBER_EMAIL].sort());
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 3, failed: 1, failed_user_ids: [ADMIN_ID] });
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain('@example.com');
  });

  it('メールアドレスを持たない人 (電話番号のみなど) にだけ送らず、失敗扱いにもしない', async () => {
    fake.users.find((user) => user.id === MEMBER_ID)!.email = null;

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((envelope) => envelope.to).sort()).toEqual([OWNER_EMAIL, ADMIN_EMAIL].sort());
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('メールが一部送れなくても 200 を返し、ほかの宛先には送り、失敗の件数を構造化ログに残す', async () => {
    const sendError = new Error('EMAIL_SEND_FAILED: temporarily unavailable');
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === ADMIN_EMAIL) throw sendError;
      return { id: 'email-ok' };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(3);
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), sendError, {
      organization_id: ORG_ID,
      failed_count: 1,
    });
    // ログに宛先のメールアドレスを残さない
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('@example.com');
  });

  it('sendEmail が reject せず ok: false の結果を返した宛先も失敗として数え、200 のまま、ほかの宛先には送り、構造化ログに残す (#1193)', async () => {
    const sendError = new EmailSendError('rate_limit_exceeded', 'EMAIL_SEND_FAILED: Too many requests', 429, 4, true);
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === ADMIN_EMAIL) return { ok: false, id: null, attempts: 4, skipped: false, error: sendError };
      return { ok: true, id: 'email-ok', attempts: 1, skipped: false, error: null };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(3);
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), sendError, {
      organization_id: ORG_ID,
      failed_count: 1,
    });
    // ログに宛先のメールアドレスを残さない
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('@example.com');
  });

  it('reject された宛先と ok: false の宛先が混ざっても、失敗の件数を合計して 1 件のログにまとめる (#1193)', async () => {
    const thrown = new Error('EMAIL_SEND_FAILED: unexpected');
    const resultError = new EmailSendError('application_error', 'EMAIL_SEND_FAILED: Service Unavailable', 503, 4, true);
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === OWNER_EMAIL) throw thrown;
      if (envelope.to === ADMIN_EMAIL) return { ok: false, id: null, attempts: 4, skipped: false, error: resultError };
      return { ok: true, id: 'email-ok', attempts: 1, skipped: false, error: null };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    const [, reason, metadata] = mocks.logError.mock.calls[0];
    expect([thrown, resultError]).toContain(reason);
    expect(metadata).toEqual({
      organization_id: ORG_ID,
      failed_count: 2,
    });
  });

  it('宛先停止リストで止めた (suppressed) 宛先だけなら、意図した動きなので error ではなく warn を残す (#1577 の 7)', async () => {
    const suppressedError = new EmailSendError(
      'suppressed',
      'EMAIL_SUPPRESSED: 宛先停止リストに載っている宛先のため、メールを送信しませんでした',
      null,
      0,
      false,
    );
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === ADMIN_EMAIL) return { ok: false, id: null, attempts: 0, skipped: false, error: suppressedError };
      return { ok: true, id: 'email-ok', attempts: 0, skipped: false, error: null };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(3);
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(expect.any(String), {
      organization_id: ORG_ID,
      failed_count: 1,
      error_code: 'suppressed',
    });
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain('@example.com');
  });

  it('suppressed とほかの失敗が混ざったら、error のまま。渡す理由は suppressed でない方 (#1577 の 7)', async () => {
    const suppressedError = new EmailSendError('suppressed', 'EMAIL_SUPPRESSED', null, 0, false);
    const resultError = new EmailSendError('outbox_failed', 'EMAIL_OUTBOX_FAILED', null, 0, true);
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === OWNER_EMAIL) return { ok: false, id: null, attempts: 0, skipped: false, error: suppressedError };
      if (envelope.to === ADMIN_EMAIL) return { ok: false, id: null, attempts: 0, skipped: false, error: resultError };
      return { ok: true, id: 'email-ok', attempts: 0, skipped: false, error: null };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), resultError, {
      organization_id: ORG_ID,
      failed_count: 2,
    });
    expect(mocks.logWarn).not.toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error_code: 'suppressed' }));
  });

  it('RESEND_API_KEY が無くて送らなかった (skipped) 宛先は、失敗に数えず、エラーログも残さない (#1193)', async () => {
    const skippedError = new EmailSendError('not_configured', 'EMAIL_NOT_CONFIGURED: RESEND_API_KEY が未設定', null, 0, false);
    mocks.sendEmail.mockResolvedValue({ ok: false, id: null, attempts: 0, skipped: true, error: skippedError });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(3);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('解散前のメンバー一覧を読めなかったときも解散は完了させ、メールは送らず、構造化ログに残す', async () => {
    const readError = { message: 'connection reset by peer', code: '08006' };
    fake.readErrors.user_profiles = readError;

    const res = await call();

    // 通知は best-effort (設計 §8)。通知の都合で運営の緊急操作は止めない
    expect(res.status).toBe(200);
    expect(fake.tables.organizations[0].status).toBe('dissolved');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), readError, { organization_id: ORG_ID });
  });
});

describe('POST /api/operator/membership/org/[id]/dissolve: RPC のエラー', () => {
  it('RPC が失敗: 500 INTERNAL_ERROR を返し、通知メールは送らない', async () => {
    // 分からない失敗 (RPC の既知のコードを含まない) は従来どおり 500
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'SOME_UNKNOWN_DB_FAILURE', code: 'XX000' } });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    // DB の生のエラー文は本文に出さない (#1172 / #1434)
    expect(json.error.message).toBe('処理中にエラーが発生しました');
    expect(JSON.stringify(json)).not.toContain('SOME_UNKNOWN_DB_FAILURE');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
  });

  it('RPC が既知のコード (ORG_NOT_FOUND) で止めた: 404 と日本語の固定の文を返し (汎用の 500 にしない。#1917 の続き)、通知メールは送らない', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'ORG_NOT_FOUND', code: 'P0001' } });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toEqual({ code: 'ORG_NOT_FOUND', message: '組織が見つかりません。' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
  });
});

describe('POST /api/operator/membership/org/[id]/dissolve: 認可と入力検証', () => {
  it('未認証: 401 を返し、事前取得も RPC も行わない', async () => {
    mocks.requireSuperAdmin.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED', '認証が必要です'));

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('UNAUTHORIZED');
    expect(fake.events).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('super_admin 以外: 403 を返し、事前取得も RPC も行わない', async () => {
    mocks.requireSuperAdmin.mockRejectedValue(new ForbiddenError('PERM_DENIED', 'super_admin 権限が必要です'));

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('FORBIDDEN');
    expect(fake.events).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['reason が空', { reason: '' }],
    ['reason が 1000 文字超', { reason: 'あ'.repeat(1001) }],
    ['body が空', {}],
  ])('入力が不正 (%s): 400 VALIDATION_ERROR を返し、事前取得も RPC も行わない', async (_label, body) => {
    const res = await call(body);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(fake.events).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/operator/membership/org/[id]/dissolve: service-role のクライアントは canonical の getSupabaseAdmin で作る (#1162)', () => {
  it('同じ鍵・同じ設定 (セッションを保存しない・自動で更新しない) のクライアントを、解散前のメンバー取得と通知で 1 回だけ作る', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(vi.mocked(getSupabaseAdmin)).toHaveBeenCalledTimes(1);
    expect(mocks.createServiceRoleClient).toHaveBeenCalledTimes(1);
    expect(mocks.createServiceRoleClient).toHaveBeenCalledWith('http://127.0.0.1:54321', 'test-service-role-key', {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  it('認可 (requireSuperAdmin) に落ちたら、service-role のクライアントを作らない', async () => {
    mocks.requireSuperAdmin.mockRejectedValue(new ForbiddenError('PERM_DENIED', 'super_admin 権限が必要です'));

    const res = await call();

    expect(res.status).toBe(403);
    expect(vi.mocked(getSupabaseAdmin)).not.toHaveBeenCalled();
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });
});

describe('POST /api/operator/membership/org/[id]/dissolve: 宛名に仮置きの Guest を使わない (#1649)', () => {
  function setNickname(nickname: string) {
    const row = fake.tables.user_profiles.find((r) => r.id === MEMBER_ID);
    if (!row) throw new Error('宛先の user_profiles の行がありません');
    row.nickname = nickname;
  }

  it.each(['Guest', ' Guest ', '   ', ''])('nickname が %j なら、宛名はメールアドレス (Guest を載せない)', async (nickname) => {
    setNickname(nickname);

    const res = await call();

    expect(res.status).toBe(200);
    const [envelope] = sentTo(MEMBER_EMAIL);
    expect(envelope.text.startsWith(`${MEMBER_EMAIL} 様`)).toBe(true);
    expect(envelope.text).not.toContain('Guest');
  });

  it.each([
    ['guest', 'guest'],
    [' 社員 ', '社員'],
  ])('nickname が %j (本人が付けた名前) なら、その名前を宛名にする', async (nickname, expected) => {
    setNickname(nickname);

    await call();

    expect(sentTo(MEMBER_EMAIL)[0].text.startsWith(`${expected} 様`)).toBe(true);
  });
});
