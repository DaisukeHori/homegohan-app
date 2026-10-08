import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmailSendError } from '@/lib/emails/send-result';
import { NextRequest } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createFakeServiceRole, leadingUsers, type FakeServiceRole } from './fake-service-role';

// POST /api/operator/membership/family/[id]/dissolve の通知メール (#1204)。
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

// RPC は運営者本人のセッションで実行される (cookies() を使う本物の createClient は使わない)
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ rpc: mocks.rpc }),
}));

// 通知用の service-role クライアント (route 内の createSupabaseClient)
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

import { POST } from '@/app/api/operator/membership/family/[id]/dissolve/route';

const OPERATOR_ID = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';
const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const OTHER_FAMILY_ID = 'f1eebc99-9c0b-4ef8-bb6d-6bb9bd380a67';
const REP_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const ADULT_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const TEEN_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
const LEFT_ID = 'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a34';
const STRANGER_ID = 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a35';

const REP_EMAIL = 'rep@example.com';
const ADULT_EMAIL = 'adult@example.com';
const TEEN_EMAIL = 'teen@example.com';
const LEFT_EMAIL = 'left@example.com';
const STRANGER_EMAIL = 'stranger@example.com';

const REASON = '家族グループが不正利用に使われていたため';
const RPC_NAME = 'operator_force_dissolve_family';

type SentEmail = { to: string; subject: string; text: string };

/**
 * 山田家: 代表者 (花子)・大人 (太郎)・アカウントを持つ子供 (次郎) が active。
 * ほかにアカウントを持たない子供 (user_id が NULL)、退会済み、別の家族のメンバーがいる。
 * leadingUserCount を指定すると、登録順で先頭にその人数の無関係なユーザーが並ぶ (#1204: 50 人超の登録状況)。
 */
function buildFake(leadingUserCount = 60): FakeServiceRole {
  return createFakeServiceRole({
    tables: {
      family_groups: [
        { id: FAMILY_ID, name: '山田家', representative_id: REP_ID, status: 'active' },
        { id: OTHER_FAMILY_ID, name: '佐藤家', representative_id: STRANGER_ID, status: 'active' },
      ],
      family_members: [
        { family_id: FAMILY_ID, user_id: REP_ID, role: 'representative', status: 'active' },
        { family_id: FAMILY_ID, user_id: ADULT_ID, role: 'adult', status: 'active' },
        { family_id: FAMILY_ID, user_id: TEEN_ID, role: 'child', status: 'active' },
        // アカウントを持たない子供 (user_id は NULL)
        { family_id: FAMILY_ID, user_id: null, role: 'child', status: 'active' },
        { family_id: FAMILY_ID, user_id: LEFT_ID, role: 'adult', status: 'left' },
        { family_id: OTHER_FAMILY_ID, user_id: STRANGER_ID, role: 'representative', status: 'active' },
      ],
      user_profiles: [
        { id: REP_ID, nickname: '花子' },
        { id: ADULT_ID, nickname: '太郎' },
        { id: TEEN_ID, nickname: '次郎' },
        { id: LEFT_ID, nickname: '退会者' },
        { id: STRANGER_ID, nickname: '他の家族の人' },
      ],
    },
    users: [
      ...leadingUsers(leadingUserCount),
      { id: REP_ID, email: REP_EMAIL },
      { id: ADULT_ID, email: ADULT_EMAIL },
      { id: TEEN_ID, email: TEEN_EMAIL },
      { id: LEFT_ID, email: LEFT_EMAIL },
      { id: STRANGER_ID, email: STRANGER_EMAIL },
    ],
  });
}

/**
 * operator_force_dissolve_family の挙動 (supabase/baseline/prod_schema.sql) を再現する。
 * ★active なメンバーを全員 'left' にして解散済みの家族の行を返す。RPC の後に読み直すと誰も残っていない。
 */
function simulateDissolve(fake: FakeServiceRole, args: { p_family_id: string; p_reason: string }) {
  fake.events.push(`rpc:${RPC_NAME}`);
  const family = fake.tables.family_groups.find((f) => f.id === args.p_family_id);
  for (const member of fake.tables.family_members) {
    if (member.family_id === args.p_family_id && member.status === 'active') member.status = 'left';
  }
  if (!family) return { data: null, error: null };
  family.status = 'dissolved';
  return { data: { ...family }, error: null };
}

let fake: FakeServiceRole;

beforeEach(() => {
  vi.clearAllMocks();
  // 本物のキーではないダミー値 (getServiceRoleClient が環境変数の有無だけを見る)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

  fake = buildFake();
  mocks.createServiceRoleClient.mockImplementation(() => fake.client);
  mocks.requireSuperAdmin.mockResolvedValue({ userId: OPERATOR_ID });
  mocks.rpc.mockImplementation(async (name: string, args: { p_family_id: string; p_reason: string }) => {
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
  new NextRequest(`http://localhost/api/operator/membership/family/${FAMILY_ID}/dissolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const validBody = { reason: REASON };

const call = (body: unknown = validBody, familyId: string = FAMILY_ID) =>
  POST(postRequest(body), { params: { id: familyId } });

/** sendEmail に渡された封筒。同じ宛先に 2 通送っていたら気づけるよう配列で扱う */
const sentEmails = () => mocks.sendEmail.mock.calls.map(([envelope]) => envelope as SentEmail);
const sentTo = (address: string) => sentEmails().filter((envelope) => envelope.to === address);

describe('POST /api/operator/membership/family/[id]/dissolve: 通知メールの宛先と本文 (#1204)', () => {
  it('解散時点の active なメンバー全員 (Auth ユーザー一覧の先頭 50 件の外にいる人を含む) に解散を知らせる', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(RPC_NAME, { p_family_id: FAMILY_ID, p_reason: REASON });
    expect(sentEmails().map((envelope) => envelope.to).sort()).toEqual([REP_EMAIL, ADULT_EMAIL, TEEN_EMAIL].sort());
    for (const envelope of sentEmails()) {
      expect(envelope.subject).toContain('山田家');
      expect(envelope.text).toContain('山田家');
      expect(envelope.text).toContain(REASON);
    }
    // 宛名は各自のニックネーム
    expect(sentTo(REP_EMAIL)[0].text).toContain('花子 様');
    expect(sentTo(ADULT_EMAIL)[0].text).toContain('太郎 様');
    expect(sentTo(TEEN_EMAIL)[0].text).toContain('次郎 様');
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('宛先は解散した家族の active なメンバーだけ (退会済み・別の家族・アカウントなしの子供には送らない)、1 人 1 通', async () => {
    await call();

    expect(sentTo(LEFT_EMAIL)).toHaveLength(0);
    expect(sentTo(STRANGER_EMAIL)).toHaveLength(0);
    expect(sentEmails()).toHaveLength(3);
  });

  it('通知先の人のメールアドレスだけを 1 人ずつ引く (listUsers は使わない)', async () => {
    await call();

    expect(fake.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById.mock.calls.map(([id]) => id).sort()).toEqual(
      [REP_ID, ADULT_ID, TEEN_ID].sort(),
    );
  });

  it('メンバーは RPC を実行する前に取得する (RPC の後は全員 left になっている)', async () => {
    await call();

    const rpcAt = fake.events.indexOf(`rpc:${RPC_NAME}`);
    const memberReads = fake.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === 'read:family_members');

    expect(rpcAt).toBeGreaterThan(-1);
    expect(memberReads.map(({ index }) => index < rpcAt)).toEqual([true]);
  });

  it('RPC の戻り値 (解散済みの家族) はそのままレスポンスの data に返す', async () => {
    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ id: FAMILY_ID, name: '山田家', status: 'dissolved' });
  });

  it('一部の人のメールアドレスを取得できなくても、取得できた人には送り、取得できなかった人数を警告ログに残す', async () => {
    fake.authFailures.add(ADULT_ID);

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((envelope) => envelope.to).sort()).toEqual([REP_EMAIL, TEEN_EMAIL].sort());
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 3, failed: 1, failed_user_ids: [ADULT_ID] });
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain('@example.com');
  });

  it('メールアドレスを持たない人 (電話番号のみなど) にだけ送らず、失敗扱いにもしない', async () => {
    fake.users.find((user) => user.id === TEEN_ID)!.email = null;

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((envelope) => envelope.to).sort()).toEqual([REP_EMAIL, ADULT_EMAIL].sort());
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('メールが一部送れなくても 200 を返し、ほかの宛先には送り、失敗の件数を構造化ログに残す', async () => {
    const sendError = new Error('EMAIL_SEND_FAILED: temporarily unavailable');
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === ADULT_EMAIL) throw sendError;
      return { id: 'email-ok' };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(3);
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), sendError, {
      family_id: FAMILY_ID,
      failed_count: 1,
    });
    // ログに宛先のメールアドレスを残さない
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('@example.com');
  });

  it('sendEmail が reject せず ok: false の結果を返した宛先も失敗として数え、200 のまま、ほかの宛先には送り、構造化ログに残す (#1193)', async () => {
    const sendError = new EmailSendError('rate_limit_exceeded', 'EMAIL_SEND_FAILED: Too many requests', 429, 4, true);
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === ADULT_EMAIL) return { ok: false, id: null, attempts: 4, skipped: false, error: sendError };
      return { ok: true, id: 'email-ok', attempts: 1, skipped: false, error: null };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(3);
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), sendError, {
      family_id: FAMILY_ID,
      failed_count: 1,
    });
    // ログに宛先のメールアドレスを残さない
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('@example.com');
  });

  it('reject された宛先と ok: false の宛先が混ざっても、失敗の件数を合計して 1 件のログにまとめる (#1193)', async () => {
    const thrown = new Error('EMAIL_SEND_FAILED: unexpected');
    const resultError = new EmailSendError('application_error', 'EMAIL_SEND_FAILED: Service Unavailable', 503, 4, true);
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === REP_EMAIL) throw thrown;
      if (envelope.to === ADULT_EMAIL) return { ok: false, id: null, attempts: 4, skipped: false, error: resultError };
      return { ok: true, id: 'email-ok', attempts: 1, skipped: false, error: null };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    const [, reason, metadata] = mocks.logError.mock.calls[0];
    expect([thrown, resultError]).toContain(reason);
    expect(metadata).toEqual({
      family_id: FAMILY_ID,
      failed_count: 2,
    });
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
    fake.readErrors.family_members = readError;

    const res = await call();

    // 通知は best-effort (設計 §8)。通知の都合で運営の緊急操作は止めない
    expect(res.status).toBe(200);
    expect(fake.tables.family_groups[0].status).toBe('dissolved');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), readError, { family_id: FAMILY_ID });
  });
});

describe('POST /api/operator/membership/family/[id]/dissolve: RPC のエラー', () => {
  it('RPC が失敗: 500 INTERNAL_ERROR を返し、通知メールは送らない', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'NOT_OPERATOR', code: 'P0001' } });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
  });
});

describe('POST /api/operator/membership/family/[id]/dissolve: 認可と入力検証', () => {
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
