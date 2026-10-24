import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmailSendError } from '@/lib/emails/send-result';
import { NextRequest } from 'next/server';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';
import { AuthError, ForbiddenError, MfaRequiredError } from '@/lib/auth/errors';
import { createFakeServiceRole, leadingUsers, valueUnder, type FakeServiceRole, type Row } from './fake-service-role';

// 外部との境界はすべてモックにする。通知の宛先・本文を決める本体 (route と renderForceTransferEmail) は実物を通す
const mocks = vi.hoisted(() => ({
  requireSuperAdmin: vi.fn(),
  rpc: vi.fn(),
  auditInsert: vi.fn(),
  createServiceRoleClient: vi.fn(),
  sendEmail: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  withUser: vi.fn(),
}));

vi.mock('@/lib/auth/operator-permissions', () => ({
  requireSuperAdmin: mocks.requireSuperAdmin,
}));

// RPC と監査 (admin_audit_logs への insert) は運営者本人のセッションで実行される (cookies() を使う本物の createClient は使わない)。
// service-role のクライアントは本物の getSupabaseAdmin を通す (#1162。接続情報は env-required の getter で取り出し、
// 下で差し替えた @supabase/supabase-js の createClient で作る)。呼ばれた回数を数える
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return {
    createClient: () => ({
      rpc: mocks.rpc,
      from: (table: string) => {
        if (table !== 'admin_audit_logs') throw new Error(`unexpected table on the session client: ${table}`);
        return { insert: mocks.auditInsert };
      },
    }),
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
import { getSupabaseAdmin } from '@/lib/supabase/server';
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

/**
 * 山田家: 旧代表者 (花子) → 新代表者 (太郎)。ほかに子供 (アカウントあり/なし)、退会済み、別の家族のメンバーがいる。
 * leadingUserCount を指定すると、登録順で先頭にその人数の無関係なユーザーが並ぶ (#1204: 50 人超の登録状況)。
 */
function buildFake(leadingUserCount = 0): FakeServiceRole {
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
      ...leadingUsers(leadingUserCount),
      { id: OLD_REP_ID, email: OLD_EMAIL },
      { id: NEW_REP_ID, email: NEW_EMAIL },
      { id: MEMBER_ID, email: MEMBER_EMAIL },
      { id: LEFT_ID, email: LEFT_EMAIL },
      { id: STRANGER_ID, email: STRANGER_EMAIL },
    ],
  });
}

/** family_groups の行の representative_id を書き換える (ロックの下の書き換え: 旧代表者を adult に、新代表者を representative に)。書き換える前の representative_id を返す */
function reassignRepresentative(fake: FakeServiceRole, family: Row, newRepId: unknown): unknown {
  const previousRepId = family.representative_id;
  for (const m of fake.tables.family_members) {
    if (m.family_id !== family.id || m.status !== 'active') continue;
    if (m.user_id === previousRepId) m.role = 'adult';
    if (m.user_id === newRepId) m.role = 'representative';
  }
  family.representative_id = newRepId;
  return previousRepId;
}

/**
 * operator_force_representative_transfer の挙動 (最新の定義は supabase/migrations/20261023140000_operator_transfer_return_old_owner.sql) を再現する。
 * 家族の行をロックしてから representative_id (旧代表者) を読み、representative_id を新代表者へ書き換え、
 * {"family_group": 書き換えた「後の」行, "old_rep_id": ロックの下で読んだ旧代表者} を返す (#1917)。
 * 書き換えた後の行の representative_id は新代表者なので、それを旧代表者として使う実装は #1209 と同じ理由で壊れる。
 * 新代表者の id は Postgres の uuid と同じく大文字小文字を区別せずに比べ、保存するのは行の user_id (小文字) にする (#1790)。
 * そのため大文字の to_user_id をそのまま RPC に渡しても譲渡は成り立ち、route の側の突き合わせのずれだけがテストに出る
 */
function simulateRepresentativeTransfer(fake: FakeServiceRole, args: RpcArgs) {
  fake.events.push(`rpc:${RPC_NAME}`);
  const members = fake.tables.family_members;
  const target = members.find(
    (m) =>
      m.family_id === args.p_family_id &&
      typeof m.user_id === 'string' &&
      m.user_id.toLowerCase() === args.p_new_rep_id.toLowerCase() &&
      m.status === 'active' &&
      (m.role === 'representative' || m.role === 'adult'),
  );
  if (!target) return { data: null, error: { message: 'TARGET_NOT_IN_FAMILY', code: 'P0001' } };

  const family = fake.tables.family_groups.find((f) => f.id === args.p_family_id);
  if (!family) return { data: null, error: { message: 'TARGET_NOT_IN_FAMILY', code: 'P0001' } };

  const oldRepId = reassignRepresentative(fake, family, target.user_id);
  return { data: { family_group: { ...family }, old_rep_id: oldRepId }, error: null };
}

/**
 * #1917 の migration の前の定義 (20261017130000_operator_mfa_db_gate.sql) の RPC: 書き換えた後の行だけを返し、旧代表者を返さない。
 * migration を当てる前の DB に新しい route が当たったときの形
 */
function simulateRepresentativeTransferBeforeMigration(fake: FakeServiceRole, args: RpcArgs) {
  const result = simulateRepresentativeTransfer(fake, args);
  if (result.error) return result;
  return { data: result.data.family_group, error: null };
}

/** admin_audit_logs に書いた行 (recordAdminAudit の insert の引数) */
const auditRows = () => mocks.auditInsert.mock.calls.map(([row]) => row as { details: Record<string, unknown> });
/** renderForceTransferEmail に渡した、宛先ごとの立場 (old_owner / new_owner / member) */
const recipientRoleOf = (address: string) =>
  vi.mocked(renderForceTransferEmail).mock.calls.map(([vars]) => vars).find((vars) => vars.recipient_email === address)?.recipient_role;
const renderedTransferVars = () => vi.mocked(renderForceTransferEmail).mock.calls.map(([vars]) => vars);

let fake: FakeServiceRole;

beforeEach(() => {
  vi.clearAllMocks();
  // 本物のキーではないダミー値 (getSupabaseAdmin は環境変数の有無だけを見る)
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
  mocks.auditInsert.mockResolvedValue({ error: null });
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
  new NextRequest(`http://localhost/api/operator/membership/family/${FAMILY_ID}/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const validBody = { to_user_id: NEW_REP_ID, reason: REASON };

const call = (body: unknown = validBody, familyId: string = FAMILY_ID) =>
  POST(postRequest(body), { params: Promise.resolve({ id: familyId }) });

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

  it('family_groups の読み取りは RPC の前の控えの 1 回だけ (旧代表者は RPC の戻り値を使い、RPC の後に読み直さない)', async () => {
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
      family_id: FAMILY_ID,
      to_user_id: NEW_REP_ID,
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
      family_id: FAMILY_ID,
      to_user_id: NEW_REP_ID,
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
    expect(fake.tables.family_groups[0].representative_id).toBe(NEW_REP_ID);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    // 取得に失敗したことを黙って握りつぶさない (#1204)。通知先の 3 人 (旧代表者・新代表者・メンバー) の件数を残す
    expect(mocks.withUser).toHaveBeenCalledWith(OPERATOR_ID);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 3, failed: 3 });
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain('@example.com');
  });

  it('通知先のメンバー一覧を読めなくても 200 を返し、メールは送らず、構造化ログに残す (譲渡は完了済み)', async () => {
    const readError = { message: 'connection reset by peer', code: '08006' };
    fake.readErrors.family_members = readError;

    const res = await call();

    expect(res.status).toBe(200);
    expect(fake.tables.family_groups[0].representative_id).toBe(NEW_REP_ID);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), readError, {
      family_id: FAMILY_ID,
      to_user_id: NEW_REP_ID,
    });
  });

  it('RPC の前の控えを読めなくても、RPC が返した旧代表者・家族名で、旧代表者・新代表者・メンバーに通知し、監査にも残す (#1917)', async () => {
    fake.readErrors.family_groups = { message: 'connection reset by peer', code: '08006' };

    const res = await call();

    expect(res.status).toBe(200);
    expect(recipientRoleOf(OLD_EMAIL)).toBe('old_owner');
    expect(recipientRoleOf(NEW_EMAIL)).toBe('new_owner');
    expect(recipientRoleOf(MEMBER_EMAIL)).toBe('member');
    expect(renderedTransferVars().every((vars) => vars.scope_name === '山田家')).toBe(true);
    expect(auditRows().map((row) => row.details.from_user_id)).toEqual([OLD_REP_ID]);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('戻り値が古い形 (migration の前の DB) で、譲渡前の家族情報も読めなかったときは、譲渡は完了させ、誤った宛先・本文を送らずに構造化ログへ残す', async () => {
    const readError = { message: 'connection reset by peer', code: '08006' };
    fake.readErrors.family_groups = readError;
    mocks.rpc.mockImplementation(async (_name: string, args: RpcArgs) => simulateRepresentativeTransferBeforeMigration(fake, args));

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
    // 旧代表者が分からないので、監査の from_user_id は null (推測で埋めない)
    expect(auditRows().map((row) => row.details.from_user_id)).toEqual([null]);
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
      // 接続情報は env-required の getter で取り出す (#1434)。変数名は envName にだけ入り、message は固定の文
      expect.objectContaining({ name: 'MissingEnvError', envName: 'SUPABASE_SERVICE_ROLE_KEY' }),
      { family_id: FAMILY_ID, to_user_id: NEW_REP_ID },
    );
  });
});

describe('POST /api/operator/membership/family/[id]/transfer: 監査の from_user_id と旧代表者への知らせは、RPC が家族の行のロックの下で読んだ旧代表者 (#1917)', () => {
  /**
   * 運営 A が RPC の前に家族を読んだ (representative_id = OLD_REP_ID) あと、A の RPC が家族の行のロックを取る前に、運営 B の譲渡
   * (OLD_REP_ID → MEMBER_ID) が commit した状況。A の RPC はロックの下で MEMBER_ID を旧代表者として読み、MEMBER_ID → NEW_REP_ID に譲渡する。
   * makeRpc で、戻り値の形 (新しい定義 / migration の前の定義) を選ぶ
   */
  function racedByAnotherOperator(makeRpc: (fake: FakeServiceRole, args: RpcArgs) => unknown) {
    mocks.rpc.mockImplementation(async (_name: string, args: RpcArgs) => {
      const family = fake.tables.family_groups.find((f) => f.id === FAMILY_ID);
      if (!family) throw new Error('家族の行が無い');
      reassignRepresentative(fake, family, MEMBER_ID);
      return makeRpc(fake, args);
    });
  }

  it('監査 (admin_audit_logs) の details は reason・to_user_id と、RPC が返した旧代表者の from_user_id', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.auditInsert).toHaveBeenCalledTimes(1);
    expect(auditRows()[0]).toMatchObject({
      actor_id: OPERATOR_ID,
      action_type: 'super_admin.family.transfer_representative',
      target_id: FAMILY_ID,
      target_type: 'family_group',
      severity: 'warn',
      details: { reason: REASON, to_user_id: NEW_REP_ID, from_user_id: OLD_REP_ID },
    });
  });

  it('RPC の前に読んだあとで別の運営が先に譲渡していたら、監査の from_user_id は RPC がロックの下で読んだ直前の代表者 (先に読んだ人ではない)', async () => {
    racedByAnotherOperator(simulateRepresentativeTransfer);

    const res = await call();

    expect(res.status).toBe(200);
    expect(fake.tables.family_groups[0].representative_id).toBe(NEW_REP_ID);
    expect(auditRows().map((row) => row.details.from_user_id)).toEqual([MEMBER_ID]);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('同じ状況で、旧代表者向けの知らせは直前の代表者 (MEMBER_ID) に送り、先に読んだ人 (OLD_REP_ID) には一般メンバー向けを送る。新代表者宛の「旧オーナー」欄も直前の代表者', async () => {
    racedByAnotherOperator(simulateRepresentativeTransfer);

    await call();

    expect(recipientRoleOf(MEMBER_EMAIL)).toBe('old_owner');
    expect(recipientRoleOf(OLD_EMAIL)).toBe('member');
    expect(recipientRoleOf(NEW_EMAIL)).toBe('new_owner');
    expect(renderedTransferVars().every((vars) => vars.old_owner_email === MEMBER_EMAIL)).toBe(true);
    expect(sentTo(MEMBER_EMAIL)).toHaveLength(1);
    expect(sentTo(OLD_EMAIL)).toHaveLength(1);
  });

  it('応答の data は更新した後の家族の行だけ (RPC の戻り値の old_rep_id は載せない)', async () => {
    const res = await call();
    const json = await res.json();

    expect(json.data).toEqual({ id: FAMILY_ID, name: '山田家', representative_id: NEW_REP_ID });
  });

  it('家族名は RPC が返した行の名前を使う (RPC の前の控えと違っていても)', async () => {
    mocks.rpc.mockImplementation(async (_name: string, args: RpcArgs) => {
      const family = fake.tables.family_groups.find((f) => f.id === FAMILY_ID);
      if (!family) throw new Error('家族の行が無い');
      family.name = '山田家 (改称後)';
      return simulateRepresentativeTransfer(fake, args);
    });

    await call();

    expect(renderedTransferVars().length).toBeGreaterThan(0);
    expect(renderedTransferVars().every((vars) => vars.scope_name === '山田家 (改称後)')).toBe(true);
  });

  it('戻り値が古い形 (migration の前の DB): 譲渡は 200 のまま、RPC の前に読んだ旧代表者で監査と知らせを出し、食い違いうることを構造化ログに残す', async () => {
    mocks.rpc.mockImplementation(async (_name: string, args: RpcArgs) => simulateRepresentativeTransferBeforeMigration(fake, args));

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ id: FAMILY_ID, representative_id: NEW_REP_ID });
    expect(auditRows().map((row) => row.details.from_user_id)).toEqual([OLD_REP_ID]);
    expect(recipientRoleOf(OLD_EMAIL)).toBe('old_owner');
    expect(recipientRoleOf(NEW_EMAIL)).toBe('new_owner');
    expect(recipientRoleOf(MEMBER_EMAIL)).toBe('member');
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining('old_rep_id'), expect.any(Error), {
      family_id: FAMILY_ID,
      to_user_id: NEW_REP_ID,
    });
  });

  it('戻り値が古い形で別の運営と競ったときは、先に読んだ人で記録する (#1917 の前の動き。migration を当てれば直る食い違いで、ログに残る)', async () => {
    racedByAnotherOperator(simulateRepresentativeTransferBeforeMigration);

    const res = await call();

    expect(res.status).toBe(200);
    expect(auditRows().map((row) => row.details.from_user_id)).toEqual([OLD_REP_ID]);
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining('old_rep_id'), expect.any(Error), {
      family_id: FAMILY_ID,
      to_user_id: NEW_REP_ID,
    });
  });

  it.each([
    ['family_group のキーが無い', { old_rep_id: OLD_REP_ID }],
    ['old_rep_id のキーが無い', { family_group: { id: FAMILY_ID, name: '山田家', representative_id: NEW_REP_ID } }],
    ['old_rep_id が文字列でない', { family_group: { id: FAMILY_ID, name: '山田家', representative_id: NEW_REP_ID }, old_rep_id: 1 }],
    ['null', null],
  ])('戻り値の形が合わない (%s) ときも 500 にせず、RPC の前の控えで記録する', async (_label, data) => {
    mocks.rpc.mockImplementation(async (_name: string, args: RpcArgs) => {
      simulateRepresentativeTransfer(fake, args);
      return { data, error: null };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(auditRows().map((row) => row.details.from_user_id)).toEqual([OLD_REP_ID]);
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining('old_rep_id'), expect.any(Error), {
      family_id: FAMILY_ID,
      to_user_id: NEW_REP_ID,
    });
  });
});

describe('POST /api/operator/membership/family/[id]/transfer: 登録ユーザーが 50 人を超えているとき (#1204)', () => {
  // auth.admin.listUsers() は page / perPage を渡さないと先頭 50 件しか返さない。
  // 修正前は宛先が先頭 50 件の外にいると emailMap に載らず、通知メールが例外もログもなくスキップされた。
  beforeEach(() => {
    fake = buildFake(60);
    mocks.createServiceRoleClient.mockImplementation(() => fake.client);
  });

  it('旧代表者・新代表者・メンバーが Auth ユーザー一覧の先頭 50 件より後ろにいても、全員に通知する', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((envelope) => envelope.to).sort()).toEqual([OLD_EMAIL, NEW_EMAIL, MEMBER_EMAIL].sort());
    const roleOf = (address: string) =>
      vi.mocked(renderForceTransferEmail).mock.calls.map(([vars]) => vars).find((v) => v.recipient_email === address)
        ?.recipient_role;
    expect(roleOf(OLD_EMAIL)).toBe('old_owner');
    expect(roleOf(NEW_EMAIL)).toBe('new_owner');
    expect(roleOf(MEMBER_EMAIL)).toBe('member');
    // 旧オーナー / 新オーナー欄のアドレスも解決できている (空にならない)
    for (const [vars] of vi.mocked(renderForceTransferEmail).mock.calls) {
      expect(vars).toMatchObject({ old_owner_email: OLD_EMAIL, new_owner_email: NEW_EMAIL });
    }
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('通知先の人のメールアドレスだけを 1 人ずつ引く (listUsers は使わない・同じ人を二重に引かない)', async () => {
    await call();

    expect(fake.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById.mock.calls.map(([id]) => id).sort()).toEqual(
      [OLD_REP_ID, NEW_REP_ID, MEMBER_ID].sort(),
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

describe('POST /api/operator/membership/family/[id]/transfer: RPC のエラー', () => {
  it.each([
    ['TARGET_NOT_IN_FAMILY', 'TARGET_NOT_IN_FAMILY', 400, '譲渡先のユーザーはこの家族グループに所属していません'],
    // 認可の失敗 (catch の authFailureNested) の 403 と同じ日本語の固定の文 (#1917)
    ['NOT_OPERATOR', 'FORBIDDEN', 403, 'この操作を行う権限がありません'],
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

  // RPC のエラーのコードの判定は src/lib/errors/db-raised-code.ts の関数で行う (#1917。route では `.message` を読まない)
  it('譲渡先が退会の手続き中 (トリガーが P0001 + REPRESENTATIVE_ACCOUNT_DELETING で止めた): 409 と固定の文を返し、通知メールは送らない', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'REPRESENTATIVE_ACCOUNT_DELETING', code: 'P0001' } });

    const res = await call();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: 'REPRESENTATIVE_ACCOUNT_DELETING', message: '譲渡先のユーザーは退会の手続き中です' },
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('文面が REPRESENTATIVE_ACCOUNT_DELETING でも P0001 でなければ 409 にせず、汎用の 500 にして構造化ログに残す', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'REPRESENTATIVE_ACCOUNT_DELETING', code: '23505' } });

    const res = await call();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE } });
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ERROR: TARGET_NOT_IN_FAMILY', 400, 'TARGET_NOT_IN_FAMILY'],
    ['ERROR: NOT_OPERATOR', 403, 'FORBIDDEN'],
  ])('RPC の文面 (%s) の前に何かが付いていても、コードを語として含めば同じ応答 (%i %s)', async (message, status, code) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message, code: 'P0001' } });

    const res = await call();

    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
  });
});

describe('POST /api/operator/membership/family/[id]/transfer: 認可と入力検証', () => {
  // 401 / 403 の本文は例外の文面 (err.message) を入れず、日本語の固定の文にする (#1917)。
  // requireRole が投げる ForbiddenError の文面は英語 ('Requires one of: super_admin') なので、そのまま返すと画面に英語が出る。
  // code (UNAUTHORIZED / FORBIDDEN) と nested の形は従来のまま
  it.each([
    ['未ログイン (英語の文面)', new AuthError('AUTH_UNAUTHENTICATED', 'Not authenticated'), 401, 'UNAUTHORIZED', 'ログインが必要です'],
    ['プロフィールが無い (英語の文面)', new AuthError('AUTH_PROFILE_NOT_FOUND', 'Profile not found'), 401, 'UNAUTHORIZED', 'ログインが必要です'],
    ['super_admin 以外 (requireRole の英語の文面)', new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin'), 403, 'FORBIDDEN', 'この操作を行う権限がありません'],
    ['凍結 (英語の文面)', new ForbiddenError('AUTH_ACCOUNT_FROZEN', 'Account frozen'), 403, 'FORBIDDEN', 'アカウントが凍結されています'],
    ['二段階認証の確認が要る (MfaRequiredError)', new MfaRequiredError('AUTH_2FA_REQUIRED', 'MFA verification required'), 403, 'FORBIDDEN', '二段階認証の確認が必要です'],
    ['二段階認証の登録が要る (MfaRequiredError)', new MfaRequiredError('AUTH_2FA_ENROLLMENT_REQUIRED', 'MFA enrollment required'), 403, 'FORBIDDEN', '二段階認証の登録が必要です'],
  ])('認可の失敗 (%s): 従来の code と日本語の固定の文を返し、例外の文面を入れない', async (_label, err, status, code, message) => {
    mocks.requireSuperAdmin.mockRejectedValue(err);

    const res = await call();
    const text = await res.text();

    expect(res.status).toBe(status);
    expect(JSON.parse(text)).toEqual({ error: { code, message } });
    expect(text).not.toContain(err.message);
    expect(fake.events).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

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

describe('POST /api/operator/membership/family/[id]/transfer: service-role のクライアントは canonical の getSupabaseAdmin で作る (#1162)', () => {
  it('同じ鍵・同じ設定 (セッションを保存しない・自動で更新しない) のクライアントを、RPC 前の事前取得で 1 回・通知で 1 回だけ作る', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(vi.mocked(getSupabaseAdmin)).toHaveBeenCalledTimes(2);
    expect(mocks.createServiceRoleClient).toHaveBeenCalledTimes(2);
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

describe('POST /api/operator/membership/family/[id]/transfer: 宛名に仮置きの Guest を使わない (#1649)', () => {
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
    [' ゆうた ', 'ゆうた'],
  ])('nickname が %j (本人が付けた名前) なら、その名前を宛名にする', async (nickname, expected) => {
    setNickname(nickname);

    await call();

    expect(sentTo(MEMBER_EMAIL)[0].text.startsWith(`${expected} 様`)).toBe(true);
  });
});

describe('POST /api/operator/membership/family/[id]/transfer: 大文字の to_user_id でも新代表者の通知と宛先がずれない (#1790)', () => {
  // 16 進の英字を含む NEW_REP_ID を、すべて大文字・大文字小文字の混在にした値 (どちらも小文字にすると NEW_REP_ID)
  const NEW_REP_ID_UPPER = 'B0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A22';
  const NEW_REP_ID_MIXED = 'B0eeBC99-9c0B-4Ef8-bB6d-6Bb9bD380a22';
  const renderedVars = () => vi.mocked(renderForceTransferEmail).mock.calls.map(([vars]) => vars);

  it.each([
    ['すべて大文字', NEW_REP_ID_UPPER],
    ['大文字小文字の混在', NEW_REP_ID_MIXED],
  ])('to_user_id が%s: 新代表者には new_owner の通知、全員の新オーナー欄は新代表者のアドレス、RPC には小文字の id', async (_label, toUserId) => {
    expect(toUserId).not.toBe(NEW_REP_ID);
    expect(toUserId.toLowerCase()).toBe(NEW_REP_ID);

    const res = await call({ to_user_id: toUserId, reason: REASON });

    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(RPC_NAME, {
      p_family_id: FAMILY_ID,
      p_new_rep_id: NEW_REP_ID,
      p_reason: REASON,
    });
    expect(fake.tables.family_groups[0].representative_id).toBe(NEW_REP_ID);

    const roleOf = (address: string) => renderedVars().find((vars) => vars.recipient_email === address)?.recipient_role;
    expect(roleOf(NEW_EMAIL)).toBe('new_owner');
    expect(roleOf(OLD_EMAIL)).toBe('old_owner');
    expect(roleOf(MEMBER_EMAIL)).toBe('member');
    expect(renderedVars()).toHaveLength(3);
    for (const vars of renderedVars()) {
      expect(vars).toMatchObject({ old_owner_email: OLD_EMAIL, new_owner_email: NEW_EMAIL });
    }
    expect(valueUnder(sentTo(MEMBER_EMAIL)[0].text, '新オーナー')).toBe(NEW_EMAIL);

    // 宛先は小文字の id で 1 人 1 回だけ引く (大文字の id で同じ人を二重に引かない)
    expect(fake.auth.admin.getUserById.mock.calls.map(([id]) => id).sort()).toEqual(
      [OLD_REP_ID, NEW_REP_ID, MEMBER_ID].sort(),
    );
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(JSON.stringify([mocks.rpc.mock.calls, fake.auth.admin.getUserById.mock.calls])).not.toContain(toUserId);
  });

  it('通知の失敗のログに残す to_user_id も小文字にそろえた値', async () => {
    const sendError = new Error('EMAIL_SEND_FAILED: temporarily unavailable');
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === OLD_EMAIL) throw sendError;
      return { id: 'email-ok' };
    });

    const res = await call({ to_user_id: NEW_REP_ID_UPPER, reason: REASON });

    expect(res.status).toBe(200);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), sendError, {
      family_id: FAMILY_ID,
      to_user_id: NEW_REP_ID,
      failed_count: 1,
    });
  });
});
