import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmailSendError } from '@/lib/emails/send-result';
import { NextRequest } from 'next/server';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createFakeServiceRole, leadingUsers, valueUnder, type FakeServiceRole } from './fake-service-role';

// 外部との境界はすべてモックにする。通知の宛先・本文を決める本体 (route と renderForceTransferEmail) は実物を通す
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

// 構造化ログ。エラーは createLogger(...).withUser(operatorId).error(...) で記録される
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

// 文面生成は実装をそのまま通し、呼び出し引数 (受信者の立場・旧/新オーナーのアドレス) を観測できるようスパイにする
vi.mock('@/lib/emails/membership/operator-force-transfer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/emails/membership/operator-force-transfer')>();
  return { ...actual, renderForceTransferEmail: vi.fn(actual.renderForceTransferEmail) };
});

import { POST } from '@/app/api/operator/membership/org/[id]/transfer/route';
import { renderForceTransferEmail } from '@/lib/emails/membership/operator-force-transfer';

const OPERATOR_ID = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';
const ORG_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const OTHER_ORG_ID = 'e1eebc99-9c0b-4ef8-bb6d-6bb9bd380a56';
const OLD_OWNER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const NEW_OWNER_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const MEMBER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
const STRANGER_ID = 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a35';
const NO_ORG_ID = 'c3eebc99-9c0b-4ef8-bb6d-6bb9bd380a36';

const OLD_EMAIL = 'old-owner@example.com';
const NEW_EMAIL = 'new-owner@example.com';
const MEMBER_EMAIL = 'member@example.com';
const STRANGER_EMAIL = 'stranger@example.com';
const NO_ORG_EMAIL = 'no-org@example.com';

const REASON = 'オーナーが退職済みで、連絡も取れないため';
const RPC_NAME = 'operator_force_owner_transfer';

type RpcArgs = { p_organization_id: string; p_new_owner_id: string; p_reason: string };
type SentEmail = { to: string; subject: string; text: string };

/**
 * ほめゴハン株式会社: 旧オーナー (社長) → 新オーナー (部長)。ほかに一般社員、別会社の人、どの組織にも属さない人がいる。
 * leadingUserCount を指定すると、登録順で先頭にその人数の無関係なユーザーが並ぶ (#1204: 50 人超の登録状況)。
 */
function buildFake(leadingUserCount = 0): FakeServiceRole {
  return createFakeServiceRole({
    tables: {
      organizations: [
        { id: ORG_ID, name: 'ほめゴハン株式会社', owner_id: OLD_OWNER_ID },
        { id: OTHER_ORG_ID, name: '別の会社', owner_id: STRANGER_ID },
      ],
      user_profiles: [
        { id: OLD_OWNER_ID, nickname: '社長', organization_id: ORG_ID, org_role: 'owner' },
        { id: NEW_OWNER_ID, nickname: '部長', organization_id: ORG_ID, org_role: 'admin' },
        { id: MEMBER_ID, nickname: '社員', organization_id: ORG_ID, org_role: 'member' },
        { id: STRANGER_ID, nickname: '別会社の人', organization_id: OTHER_ORG_ID, org_role: 'owner' },
        { id: NO_ORG_ID, nickname: '無所属', organization_id: null, org_role: null },
      ],
    },
    users: [
      ...leadingUsers(leadingUserCount),
      { id: OLD_OWNER_ID, email: OLD_EMAIL },
      { id: NEW_OWNER_ID, email: NEW_EMAIL },
      { id: MEMBER_ID, email: MEMBER_EMAIL },
      { id: STRANGER_ID, email: STRANGER_EMAIL },
      { id: NO_ORG_ID, email: NO_ORG_EMAIL },
    ],
  });
}

/**
 * operator_force_owner_transfer の挙動 (supabase/baseline/prod_schema.sql) を再現する。
 * ★organizations.owner_id を新オーナーへ書き換えた「後の」行を返す。ここが #1209 の原因そのもの。
 */
function simulateOwnerTransfer(fake: FakeServiceRole, args: RpcArgs) {
  fake.events.push(`rpc:${RPC_NAME}`);
  const profiles = fake.tables.user_profiles;
  const target = profiles.find((p) => p.id === args.p_new_owner_id && p.organization_id === args.p_organization_id);
  const org = fake.tables.organizations.find((o) => o.id === args.p_organization_id);
  if (!target || !org) return { data: null, error: { message: 'TARGET_NOT_IN_ORG', code: 'P0001' } };

  const oldOwner = profiles.find((p) => p.id === org.owner_id);
  if (oldOwner) oldOwner.org_role = 'admin';
  target.org_role = 'owner';
  org.owner_id = args.p_new_owner_id;
  return { data: { ...org }, error: null };
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
  mocks.rpc.mockImplementation(async (name: string, args: RpcArgs) => {
    if (name !== RPC_NAME) throw new Error(`unexpected rpc: ${name}`);
    return simulateOwnerTransfer(fake, args);
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
  new NextRequest(`http://localhost/api/operator/membership/org/${ORG_ID}/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const validBody = { to_user_id: NEW_OWNER_ID, reason: REASON };

const call = (body: unknown = validBody, orgId: string = ORG_ID) =>
  POST(postRequest(body), { params: { id: orgId } });

/** sendEmail に渡された封筒。同じ宛先に 2 通送っていたら気づけるよう配列で扱う */
const sentEmails = () => mocks.sendEmail.mock.calls.map(([envelope]) => envelope as SentEmail);
const sentTo = (address: string) => sentEmails().filter((envelope) => envelope.to === address);
const renderedVars = () => vi.mocked(renderForceTransferEmail).mock.calls.map(([vars]) => vars);

describe('POST /api/operator/membership/org/[id]/transfer: 通知メールの宛先と本文 (#1209)', () => {
  it('旧オーナーには old_owner、新オーナーには new_owner、ほかのメンバーには member の通知を送る', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    // 譲渡そのものは実行されている (オーナーは新オーナーに切り替わった後)
    expect(mocks.rpc).toHaveBeenCalledWith(RPC_NAME, {
      p_organization_id: ORG_ID,
      p_new_owner_id: NEW_OWNER_ID,
      p_reason: REASON,
    });
    expect(fake.tables.organizations[0].owner_id).toBe(NEW_OWNER_ID);

    const roleOf = (address: string) => renderedVars().find((vars) => vars.recipient_email === address)?.recipient_role;
    expect(roleOf(OLD_EMAIL)).toBe('old_owner');
    expect(roleOf(NEW_EMAIL)).toBe('new_owner');
    expect(roleOf(MEMBER_EMAIL)).toBe('member');
    expect(renderedVars()).toHaveLength(3);
  });

  it('旧オーナーのアドレスと新オーナーのアドレスを取り違えずに文面へ渡す', async () => {
    await call();

    for (const vars of renderedVars()) {
      expect(vars).toMatchObject({
        scope: 'organization',
        scope_name: 'ほめゴハン株式会社',
        old_owner_email: OLD_EMAIL,
        new_owner_email: NEW_EMAIL,
        reason: REASON,
      });
    }
  });

  it('旧オーナー宛の本文には移譲先 (新オーナー) が、新オーナー宛の本文には旧オーナーが、メンバー宛には新オーナーが載る', async () => {
    await call();

    const [toOld] = sentTo(OLD_EMAIL);
    const [toNew] = sentTo(NEW_EMAIL);
    const [toMember] = sentTo(MEMBER_EMAIL);

    // 旧オーナー: 「あなたの権限が移譲された」本文 (移譲先 = 新オーナー)。メンバー向けの本文ではない
    expect(valueUnder(toOld.text, '移譲先')).toBe(NEW_EMAIL);
    expect(valueUnder(toOld.text, '新オーナー')).toBeUndefined();

    // 新オーナー: 旧オーナー欄は旧オーナーのアドレス。新オーナー自身のアドレスが入っていてはいけない
    expect(valueUnder(toNew.text, '旧オーナー')).toBe(OLD_EMAIL);
    expect(toNew.text).not.toContain(`▼ 旧オーナー\n${NEW_EMAIL}`);

    // 一般メンバー: 新オーナー = 新オーナー
    expect(valueUnder(toMember.text, '新オーナー')).toBe(NEW_EMAIL);
    expect(valueUnder(toMember.text, '移譲先')).toBeUndefined();

    for (const envelope of [toOld, toNew, toMember]) {
      expect(envelope.text).toContain(REASON);
      expect(envelope.text).toContain('ほめゴハン株式会社');
    }
  });

  it('宛先はその組織に所属する人だけ (別の組織・どこにも属さない人には送らない)、1 人 1 通', async () => {
    await call();

    expect(sentEmails().map((envelope) => envelope.to).sort()).toEqual(
      [OLD_EMAIL, NEW_EMAIL, MEMBER_EMAIL].sort(),
    );
    expect(sentTo(STRANGER_EMAIL)).toHaveLength(0);
    expect(sentTo(NO_ORG_EMAIL)).toHaveLength(0);
  });

  it('旧オーナーは RPC を実行する前に取得する (RPC の戻り値や、RPC の後の読み直しに頼らない)', async () => {
    await call();

    const rpcAt = fake.events.indexOf(`rpc:${RPC_NAME}`);
    const orgReads = fake.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === 'read:organizations');

    expect(rpcAt).toBeGreaterThan(-1);
    // organizations の読み取りは RPC より前の 1 回だけ。RPC の後は owner_id が新オーナーに変わっている
    expect(orgReads.map(({ index }) => index < rpcAt)).toEqual([true]);
  });

  it('RPC の戻り値 (更新後の組織) はそのままレスポンスの data に返す', async () => {
    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ id: ORG_ID, name: 'ほめゴハン株式会社', owner_id: NEW_OWNER_ID });
  });

  it('旧オーナーがいない組織 (owner_id が NULL) に新オーナーを割り当てる: 通知は送り、旧オーナー扱いの人は作らない', async () => {
    fake.tables.organizations[0].owner_id = null;

    const res = await call();

    expect(res.status).toBe(200);
    expect(fake.tables.organizations[0].owner_id).toBe(NEW_OWNER_ID);
    expect(renderedVars().map((vars) => vars.recipient_role).sort()).toEqual(['member', 'member', 'new_owner']);
    // 旧オーナーがいないので、新オーナー宛の「旧オーナー」欄も空 (新オーナー自身のアドレスにはしない)
    expect(renderedVars().every((vars) => vars.old_owner_email === '')).toBe(true);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('メールが一部送れなくても 200 を返し、ほかの宛先には送り、失敗の件数を構造化ログに残す', async () => {
    const sendError = new Error('EMAIL_SEND_FAILED: temporarily unavailable');
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === OLD_EMAIL) throw sendError;
      return { id: 'email-ok' };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(3);
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), sendError, {
      organization_id: ORG_ID,
      to_user_id: NEW_OWNER_ID,
      failed_count: 1,
    });
    // ログに宛先のメールアドレスを残さない
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('@example.com');
  });

  it('sendEmail が reject せず ok: false の結果を返した宛先も失敗として数え、200 のまま、ほかの宛先には送り、構造化ログに残す (#1193)', async () => {
    const sendError = new EmailSendError('rate_limit_exceeded', 'EMAIL_SEND_FAILED: Too many requests', 429, 4, true);
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === OLD_EMAIL) return { ok: false, id: null, attempts: 4, skipped: false, error: sendError };
      return { ok: true, id: 'email-ok', attempts: 1, skipped: false, error: null };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(3);
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), sendError, {
      organization_id: ORG_ID,
      to_user_id: NEW_OWNER_ID,
      failed_count: 1,
    });
    // ログに宛先のメールアドレスを残さない
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('@example.com');
  });

  it('reject された宛先と ok: false の宛先が混ざっても、失敗の件数を合計して 1 件のログにまとめる (#1193)', async () => {
    const thrown = new Error('EMAIL_SEND_FAILED: unexpected');
    const resultError = new EmailSendError('application_error', 'EMAIL_SEND_FAILED: Service Unavailable', 503, 4, true);
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === OLD_EMAIL) throw thrown;
      if (envelope.to === NEW_EMAIL) return { ok: false, id: null, attempts: 4, skipped: false, error: resultError };
      return { ok: true, id: 'email-ok', attempts: 1, skipped: false, error: null };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    const [, reason, metadata] = mocks.logError.mock.calls[0];
    expect([thrown, resultError]).toContain(reason);
    expect(metadata).toEqual({
      organization_id: ORG_ID,
      to_user_id: NEW_OWNER_ID,
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

  it('宛先メールの取得がすべて失敗しても 200 を返し、取得できなかった人数を警告ログに残す (譲渡は完了済み)', async () => {
    const authError = new Error('auth admin api is down');
    fake.auth.admin.listUsers.mockRejectedValue(authError);
    fake.auth.admin.getUserById.mockRejectedValue(authError);

    const res = await call();

    expect(res.status).toBe(200);
    expect(fake.tables.organizations[0].owner_id).toBe(NEW_OWNER_ID);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    // 取得に失敗したことを黙って握りつぶさない (#1204)。通知先の 3 人 (旧オーナー・新オーナー・メンバー) の件数を残す
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 3, failed: 3 });
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain('@example.com');
  });

  it('通知先のメンバー一覧を読めなくても 200 を返し、メールは送らず、構造化ログに残す (譲渡は完了済み)', async () => {
    const readError = { message: 'connection reset by peer', code: '08006' };
    fake.readErrors.user_profiles = readError;

    const res = await call();

    expect(res.status).toBe(200);
    expect(fake.tables.organizations[0].owner_id).toBe(NEW_OWNER_ID);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), readError, {
      organization_id: ORG_ID,
      to_user_id: NEW_OWNER_ID,
    });
  });

  it('譲渡前の組織情報を読めなかったときも譲渡は完了させ、誤った宛先・本文を送らずに構造化ログへ残す', async () => {
    const readError = { message: 'connection reset by peer', code: '08006' };
    fake.readErrors.organizations = readError;

    const res = await call();

    // 通知は best-effort (設計 §8)。通知の都合で運営の緊急操作は止めない
    expect(res.status).toBe(200);
    expect(fake.tables.organizations[0].owner_id).toBe(NEW_OWNER_ID);
    // 旧オーナーが分からないまま送ると、旧オーナーに一般メンバー向けの本文が届いてしまう
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), readError, {
      organization_id: ORG_ID,
      to_user_id: NEW_OWNER_ID,
    });
  });

  it('service-role の環境変数が無くても譲渡は止めず、通知だけを省いて構造化ログへ残す', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');

    const res = await call();

    expect(res.status).toBe(200);
    expect(fake.tables.organizations[0].owner_id).toBe(NEW_OWNER_ID);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: 'Supabase service role env missing' }),
      { organization_id: ORG_ID, to_user_id: NEW_OWNER_ID },
    );
  });
});

describe('POST /api/operator/membership/org/[id]/transfer: 登録ユーザーが 50 人を超えているとき (#1204)', () => {
  // auth.admin.listUsers() は page / perPage を渡さないと先頭 50 件しか返さない。
  // 修正前は宛先が先頭 50 件の外にいると emailMap に載らず、通知メールが例外もログもなくスキップされた。
  beforeEach(() => {
    fake = buildFake(60);
    mocks.createServiceRoleClient.mockImplementation(() => fake.client);
  });

  it('旧オーナー・新オーナー・メンバーが Auth ユーザー一覧の先頭 50 件より後ろにいても、全員に通知する', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((envelope) => envelope.to).sort()).toEqual([OLD_EMAIL, NEW_EMAIL, MEMBER_EMAIL].sort());
    const roleOf = (address: string) => renderedVars().find((vars) => vars.recipient_email === address)?.recipient_role;
    expect(roleOf(OLD_EMAIL)).toBe('old_owner');
    expect(roleOf(NEW_EMAIL)).toBe('new_owner');
    expect(roleOf(MEMBER_EMAIL)).toBe('member');
    // 旧オーナー / 新オーナー欄のアドレスも解決できている (空にならない)
    for (const vars of renderedVars()) {
      expect(vars).toMatchObject({ old_owner_email: OLD_EMAIL, new_owner_email: NEW_EMAIL });
    }
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('通知先の人のメールアドレスだけを 1 人ずつ引く (listUsers は使わない・同じ人を二重に引かない)', async () => {
    await call();

    expect(fake.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById.mock.calls.map(([id]) => id).sort()).toEqual(
      [OLD_OWNER_ID, NEW_OWNER_ID, MEMBER_ID].sort(),
    );
  });

  it('一部の人のメールアドレスを取得できなくても、取得できた人には送り、取得できなかった人数を警告ログに残す', async () => {
    fake.authFailures.add(MEMBER_ID);

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((envelope) => envelope.to).sort()).toEqual([OLD_EMAIL, NEW_EMAIL].sort());
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 3, failed: 1, failed_user_ids: [MEMBER_ID] });
    // 取得に失敗した人のアドレスも、取得できた人のアドレスもログに残さない
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain('@example.com');
  });
});

describe('POST /api/operator/membership/org/[id]/transfer: RPC のエラー', () => {
  it.each([
    ['TARGET_NOT_IN_ORG', 'TARGET_NOT_IN_ORG', 400, '譲渡先のユーザーはこの組織に所属していません'],
    ['NOT_OPERATOR', 'FORBIDDEN', 403, '権限がありません'],
  ])('RPC が %s で失敗: %s (%i) と固定の文を返し、通知メールは送らない', async (message, code, status, fixedMessage) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message, code: 'P0001' } });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(status);
    // RPC の文面ではなく、こちらで決めた文を返す (#1172)
    expect(json).toEqual({ error: { code, message: fixedMessage } });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('RPC が分からないエラー (接続の切断など) で失敗: 汎用の 500 を返し、生のエラー文は構造化ログにだけ残す (#1172)', async () => {
    const rawMessage = 'connection to server was lost (secret_host_xyz)';
    mocks.rpc.mockResolvedValue({ data: null, error: { message: rawMessage, code: '08006' } });

    const res = await call();
    const text = await res.text();

    // 以前は 400 + 生の文面を返していた
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE } });
    expect(text).not.toContain('secret_host_xyz');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect((mocks.logError.mock.calls[0][1] as Error).message).toBe(rawMessage);
  });

  it('存在しない組織: 事前取得を失敗扱いにせず、RPC のエラー (TARGET_NOT_IN_ORG) をそのまま返す', async () => {
    const res = await call(validBody, '00000000-0000-4000-8000-000000000000');
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('TARGET_NOT_IN_ORG');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('新オーナーにその組織の所属者ではない人を指定: オーナーは変わらず、通知も送らない', async () => {
    const res = await call({ to_user_id: STRANGER_ID, reason: REASON });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('TARGET_NOT_IN_ORG');
    expect(fake.tables.organizations[0].owner_id).toBe(OLD_OWNER_ID);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/operator/membership/org/[id]/transfer: 認可と入力検証', () => {
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
    ['to_user_id が UUID でない', { to_user_id: 'not-a-uuid', reason: REASON }],
    ['reason が空', { to_user_id: NEW_OWNER_ID, reason: '' }],
    ['reason が 1000 文字超', { to_user_id: NEW_OWNER_ID, reason: 'あ'.repeat(1001) }],
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
