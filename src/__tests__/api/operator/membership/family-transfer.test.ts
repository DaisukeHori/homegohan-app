import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createFakeServiceRole, valueUnder, type FakeServiceRole } from './fake-service-role';

// 外部との境界はすべてモックにする。通知の宛先・本文を決める本体 (route と renderForceTransferEmail) は実物を通す
const mocks = vi.hoisted(() => ({
  requireSuperAdmin: vi.fn(),
  rpc: vi.fn(),
  createServiceRoleClient: vi.fn(),
  sendEmail: vi.fn(),
  logError: vi.fn(),
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

import { POST } from '@/app/api/operator/membership/family/[id]/transfer/route';
import { renderForceTransferEmail } from '@/lib/emails/membership/operator-force-transfer';

const OPERATOR_ID = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';
const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const OTHER_FAMILY_ID = 'f1eebc99-9c0b-4ef8-bb6d-6bb9bd380a67';
const OLD_REP_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const NEW_REP_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const MEMBER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';
const LEFT_ID = 'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a34';
const STRANGER_ID = 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a35';

const OLD_EMAIL = 'old-rep@example.com';
const NEW_EMAIL = 'new-rep@example.com';
const MEMBER_EMAIL = 'member@example.com';
const LEFT_EMAIL = 'left@example.com';
const STRANGER_EMAIL = 'stranger@example.com';

const REASON = '代表者が長期間ログインしておらず、連絡も取れないため';
const RPC_NAME = 'operator_force_representative_transfer';

type RpcArgs = { p_family_id: string; p_new_rep_id: string; p_reason: string };
type SentEmail = { to: string; subject: string; text: string };

/** 山田家: 旧代表者 (花子) → 新代表者 (太郎)。ほかに子供 (アカウントあり/なし)、退会済み、別の家族のメンバーがいる */
function buildFake(): FakeServiceRole {
  return createFakeServiceRole({
    tables: {
      family_groups: [
        { id: FAMILY_ID, name: '山田家', representative_id: OLD_REP_ID },
        { id: OTHER_FAMILY_ID, name: '佐藤家', representative_id: STRANGER_ID },
      ],
      family_members: [
        { family_id: FAMILY_ID, user_id: OLD_REP_ID, role: 'representative', status: 'active' },
        { family_id: FAMILY_ID, user_id: NEW_REP_ID, role: 'adult', status: 'active' },
        { family_id: FAMILY_ID, user_id: MEMBER_ID, role: 'adult', status: 'active' },
        // アカウントを持たない子供 (user_id は NULL)
        { family_id: FAMILY_ID, user_id: null, role: 'child', status: 'active' },
        { family_id: FAMILY_ID, user_id: LEFT_ID, role: 'adult', status: 'left' },
        { family_id: OTHER_FAMILY_ID, user_id: STRANGER_ID, role: 'representative', status: 'active' },
      ],
      user_profiles: [
        { id: OLD_REP_ID, nickname: '花子' },
        { id: NEW_REP_ID, nickname: '太郎' },
        { id: MEMBER_ID, nickname: 'ゆうた' },
        { id: LEFT_ID, nickname: '退会者' },
        { id: STRANGER_ID, nickname: '他の家族の人' },
      ],
    },
    users: [
      { id: OLD_REP_ID, email: OLD_EMAIL },
      { id: NEW_REP_ID, email: NEW_EMAIL },
      { id: MEMBER_ID, email: MEMBER_EMAIL },
      { id: LEFT_ID, email: LEFT_EMAIL },
      { id: STRANGER_ID, email: STRANGER_EMAIL },
    ],
  });
}

/**
 * operator_force_representative_transfer の挙動 (supabase/baseline/prod_schema.sql) を再現する。
 * ★representative_id を新代表者へ書き換えた「後の」行を返す。ここが #1209 の原因そのもの。
 */
function simulateRepresentativeTransfer(fake: FakeServiceRole, args: RpcArgs) {
  fake.events.push(`rpc:${RPC_NAME}`);
  const members = fake.tables.family_members;
  const target = members.find(
    (m) =>
      m.family_id === args.p_family_id &&
      m.user_id === args.p_new_rep_id &&
      m.status === 'active' &&
      (m.role === 'representative' || m.role === 'adult'),
  );
  if (!target) return { data: null, error: { message: 'TARGET_NOT_IN_FAMILY', code: 'P0001' } };

  const family = fake.tables.family_groups.find((f) => f.id === args.p_family_id);
  if (!family) return { data: null, error: { message: 'TARGET_NOT_IN_FAMILY', code: 'P0001' } };

  const oldRepId = family.representative_id;
  for (const m of members) {
    if (m.family_id === args.p_family_id && m.user_id === oldRepId && m.status === 'active') m.role = 'adult';
  }
  target.role = 'representative';
  family.representative_id = args.p_new_rep_id;
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
  mocks.rpc.mockImplementation(async (name: string, args: RpcArgs) => {
    if (name !== RPC_NAME) throw new Error(`unexpected rpc: ${name}`);
    return simulateRepresentativeTransfer(fake, args);
  });
  mocks.sendEmail.mockResolvedValue({ id: 'email-1' });
  mocks.withUser.mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.logError,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const postRequest = (body: unknown) =>
  new NextRequest(`http://localhost/api/operator/membership/family/${FAMILY_ID}/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const validBody = { to_user_id: NEW_REP_ID, reason: REASON };

const call = (body: unknown = validBody, familyId: string = FAMILY_ID) =>
  POST(postRequest(body), { params: { id: familyId } });

/** sendEmail に渡された封筒 (宛先 -> 封筒)。同じ宛先に 2 通送っていたら気づけるよう配列で返す */
const sentEmails = () => mocks.sendEmail.mock.calls.map(([envelope]) => envelope as SentEmail);
const sentTo = (address: string) => sentEmails().filter((envelope) => envelope.to === address);

describe('POST /api/operator/membership/family/[id]/transfer: 通知メールの宛先と本文 (#1209)', () => {
  it('旧代表者には old_owner、新代表者には new_owner、ほかのメンバーには member の通知を送る', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    // 譲渡そのものは実行されている (代表者は新代表者に切り替わった後)
    expect(mocks.rpc).toHaveBeenCalledWith(RPC_NAME, {
      p_family_id: FAMILY_ID,
      p_new_rep_id: NEW_REP_ID,
      p_reason: REASON,
    });
    expect(fake.tables.family_groups[0].representative_id).toBe(NEW_REP_ID);

    const rendered = vi.mocked(renderForceTransferEmail).mock.calls.map(([vars]) => vars);
    const roleOf = (address: string) => rendered.find((vars) => vars.recipient_email === address)?.recipient_role;
    expect(roleOf(OLD_EMAIL)).toBe('old_owner');
    expect(roleOf(NEW_EMAIL)).toBe('new_owner');
    expect(roleOf(MEMBER_EMAIL)).toBe('member');
    expect(rendered).toHaveLength(3);
  });

  it('旧代表者のアドレスと新代表者のアドレスを取り違えずに文面へ渡す', async () => {
    await call();

    for (const vars of vi.mocked(renderForceTransferEmail).mock.calls.map(([v]) => v)) {
      expect(vars).toMatchObject({
        scope: 'family',
        scope_name: '山田家',
        old_owner_email: OLD_EMAIL,
        new_owner_email: NEW_EMAIL,
        reason: REASON,
      });
    }
  });

  it('旧代表者宛の本文には移譲先 (新代表者) が、新代表者宛の本文には旧オーナー (旧代表者) が、メンバー宛には新オーナーが載る', async () => {
    await call();

    const [toOld] = sentTo(OLD_EMAIL);
    const [toNew] = sentTo(NEW_EMAIL);
    const [toMember] = sentTo(MEMBER_EMAIL);

    // 旧代表者: 「あなたの権限が移譲された」本文 (移譲先 = 新代表者)。メンバー向けの本文ではない
    expect(valueUnder(toOld.text, '移譲先')).toBe(NEW_EMAIL);
    expect(valueUnder(toOld.text, '新オーナー')).toBeUndefined();

    // 新代表者: 旧オーナー欄は旧代表者のアドレス。新代表者自身のアドレスが入っていてはいけない
    expect(valueUnder(toNew.text, '旧オーナー')).toBe(OLD_EMAIL);
    expect(toNew.text).not.toContain(`▼ 旧オーナー\n${NEW_EMAIL}`);

    // 一般メンバー: 新オーナー = 新代表者
    expect(valueUnder(toMember.text, '新オーナー')).toBe(NEW_EMAIL);
    expect(valueUnder(toMember.text, '移譲先')).toBeUndefined();

    for (const envelope of [toOld, toNew, toMember]) {
      expect(envelope.text).toContain(REASON);
      expect(envelope.text).toContain('山田家');
    }
  });

  it('宛先は家族の active メンバーだけ (退会済み・別の家族・アカウントなしの子供には送らない)、1 人 1 通', async () => {
    await call();

    expect(sentEmails().map((envelope) => envelope.to).sort()).toEqual(
      [OLD_EMAIL, NEW_EMAIL, MEMBER_EMAIL].sort(),
    );
    expect(sentTo(LEFT_EMAIL)).toHaveLength(0);
    expect(sentTo(STRANGER_EMAIL)).toHaveLength(0);
  });

  it('旧代表者は RPC を実行する前に取得する (RPC の後に family_groups を読み直さない)', async () => {
    await call();

    const rpcAt = fake.events.indexOf(`rpc:${RPC_NAME}`);
    const familyReads = fake.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === 'read:family_groups');

    expect(rpcAt).toBeGreaterThan(-1);
    // 読み取りは RPC より前の 1 回だけ。RPC の後に読むと representative_id は新代表者に変わっている
    expect(familyReads.map(({ index }) => index < rpcAt)).toEqual([true]);
  });

  it('RPC の戻り値 (更新後の家族グループ) はそのままレスポンスの data に返す', async () => {
    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ id: FAMILY_ID, name: '山田家', representative_id: NEW_REP_ID });
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
      family_id: FAMILY_ID,
      to_user_id: NEW_REP_ID,
      failed_count: 1,
    });
    // ログに宛先のメールアドレスを残さない
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('@example.com');
  });

  it('宛先メールの解決で例外が出ても 200 を返し、構造化ログに残す (譲渡は完了済み)', async () => {
    const authError = new Error('auth admin api is down');
    fake.auth.admin.listUsers.mockRejectedValue(authError);
    fake.auth.admin.getUserById.mockRejectedValue(authError);

    const res = await call();

    expect(res.status).toBe(200);
    expect(fake.tables.family_groups[0].representative_id).toBe(NEW_REP_ID);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), authError, {
      family_id: FAMILY_ID,
      to_user_id: NEW_REP_ID,
    });
  });

  it('譲渡前の家族情報を読めなかったときも譲渡は完了させ、誤った宛先・本文を送らずに構造化ログへ残す', async () => {
    const readError = { message: 'connection reset by peer', code: '08006' };
    fake.readErrors.family_groups = readError;

    const res = await call();

    // 通知は best-effort (設計 §8)。通知の都合で運営の緊急操作は止めない
    expect(res.status).toBe(200);
    expect(fake.tables.family_groups[0].representative_id).toBe(NEW_REP_ID);
    // 旧代表者が分からないまま送ると、旧代表者に一般メンバー向けの本文が届いてしまう
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), readError, {
      family_id: FAMILY_ID,
      to_user_id: NEW_REP_ID,
    });
  });

  it('service-role の環境変数が無くても譲渡は止めず、通知だけを省いて構造化ログへ残す', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');

    const res = await call();

    expect(res.status).toBe(200);
    expect(fake.tables.family_groups[0].representative_id).toBe(NEW_REP_ID);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: 'Supabase service role env missing' }),
      { family_id: FAMILY_ID, to_user_id: NEW_REP_ID },
    );
  });
});

describe('POST /api/operator/membership/family/[id]/transfer: RPC のエラー', () => {
  it.each([
    ['TARGET_NOT_IN_FAMILY', 'TARGET_NOT_IN_FAMILY', 400],
    ['NOT_OPERATOR', 'FORBIDDEN', 403],
    ['connection to server was lost', 'INTERNAL_ERROR', 400],
  ])('RPC が %s で失敗: %s (%i) を返し、通知メールは送らない', async (message, code, status) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message, code: 'P0001' } });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(status);
    expect(json.error.code).toBe(code);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('存在しない家族: 事前取得を失敗扱いにせず、RPC のエラー (TARGET_NOT_IN_FAMILY) をそのまま返す', async () => {
    const res = await call(validBody, '00000000-0000-4000-8000-000000000000');
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('TARGET_NOT_IN_FAMILY');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('新代表者に選べない人 (この家族の active な大人でない) を指定: 代表者は変わらず、通知も送らない', async () => {
    const res = await call({ to_user_id: STRANGER_ID, reason: REASON });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('TARGET_NOT_IN_FAMILY');
    expect(fake.tables.family_groups[0].representative_id).toBe(OLD_REP_ID);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/operator/membership/family/[id]/transfer: 認可と入力検証', () => {
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
    ['reason が空', { to_user_id: NEW_REP_ID, reason: '' }],
    ['reason が 1000 文字超', { to_user_id: NEW_REP_ID, reason: 'あ'.repeat(1001) }],
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
