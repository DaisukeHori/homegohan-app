/**
 * #1707 POST /api/super-admin/admins/{id}/mfa/reset (運営の別の人 (super_admin) による二段階認証の解除・段 C)。
 * docs/design/cross/12-operator-mfa.md §14.7・§14.8.2・§17・§21.2 (super-admin-mfa-reset-route.test.ts)
 *
 * requireRole は本物 (@/lib/auth/helpers。段 B の AAL2 のゲート) を通し、Supabase の client (本人・service_role) を偽物にする。
 * バックアップコードの表の関数・監査 (recordMfaAudit) は差し替え、呼ぶ順と引数を見る。
 * 全セッションの終了 (endUserSessions) は本物を通し、service_role の client の rpc の呼び出しで見る。
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const state = {
    authUser: null as null | { id: string; email: string; factors: unknown[] },
    profile: null as null | { roles: string[]; organization_id: null; frozen_at: null; unban_at: null },
    session: null as null | { access_token: string; refresh_token: string },
    claims: null as null | Record<string, unknown>,
    /** service_role で読む対象の user_profiles の行 (maybeSingle の戻り) */
    target: { data: null as null | { id: string }, error: null as unknown },
  };
  const userClient = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: state.authUser },
        error: state.authUser ? null : { message: 'Auth session missing!', status: 401 },
      })),
      getSession: vi.fn(async () => ({ data: { session: state.session }, error: null })),
      getClaims: vi.fn(async () => ({ data: state.claims ? { claims: state.claims } : null, error: null })),
    },
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: state.profile, error: state.profile ? null : { message: 'no rows' } }),
        }),
      }),
    })),
  };
  const targetSelect = vi.fn();
  const adminClient = {
    auth: { admin: { signOut: vi.fn(), mfa: { listFactors: vi.fn(), deleteFactor: vi.fn() } } },
    rpc: vi.fn(),
    from: vi.fn((table: string) => {
      order.push(`from:${table}`);
      return {
        select: (columns: string) => ({
          eq: (column: string, value: string) => ({
            maybeSingle: async () => {
              targetSelect(table, columns, column, value);
              return { data: state.target.data, error: state.target.error };
            },
          }),
        }),
      };
    }),
  };
  return {
    order,
    state,
    userClient,
    adminClient,
    targetSelect,
    countRemainingBackupCodes: vi.fn(),
    deleteBackupCodes: vi.fn(),
    recordMfaAudit: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => mocks.userClient,
  getSupabaseAdmin: () => mocks.adminClient,
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));

vi.mock('@/lib/auth/mfa/backup-codes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/mfa/backup-codes')>();
  return {
    ...actual,
    countRemainingBackupCodes: mocks.countRemainingBackupCodes,
    deleteBackupCodes: mocks.deleteBackupCodes,
  };
});

vi.mock('@/lib/auth/mfa/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/mfa/audit')>();
  return { ...actual, recordMfaAudit: mocks.recordMfaAudit };
});

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ ...mocks.logger, withUser: () => mocks.logger }),
  generateRequestId: () => 'req_test',
}));

import { POST as resetPOST } from '@/app/api/super-admin/admins/[id]/mfa/reset/route';
import { MfaResetResponseSchema } from '@/lib/auth/mfa/schemas';

const ORIGIN = 'http://localhost:3000';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
/** 16 進の英字を含む実行者の id (#1707。ACTOR_ID は数字だけで大文字にしても変わらないので、大文字の自分の判定はこちらで見る) */
const HEX_ACTOR_ID = 'fedcba98-7654-4fed-8cba-9876543210fe';
const HEX_ACTOR_ID_MIXED = 'FEDcba98-7654-4FeD-8cBA-9876543210Fe';
/** 16 進の英字を含む対象の id (小文字が DB・auth の形。大文字は利用者がパスに入れうる形) #1707 */
const TARGET_ID_LOWER = 'abcdef12-3456-4abc-8def-0123456789ab';
const TARGET_ID_UPPER = TARGET_ID_LOWER.toUpperCase();
const ACTOR_FACTOR_ID = '55555555-5555-4555-8555-555555555555';
const TARGET_FACTOR_ID = '66666666-6666-4666-8666-666666666666';
const TARGET_UNVERIFIED_FACTOR_ID = '77777777-7777-4777-8777-777777777777';
const RAW_DB_TEXT = 'relation "auth.sessions" violates constraint secret_detail';
/** 対象の未使用のバックアップコードの残数 (監査の backup_codes_before) */
const REMAINING_CODES = 3;
/** 使用済みを含めて消した行の数 (応答の backup_codes_deleted。使用済みの行があるので REMAINING_CODES と違う値) */
const DELETED_CODES = 7;
/** endUserSessions の RPC が返す、終えたセッションの数 (応答にも監査にも入らない Q-19) */
const ENDED_SESSIONS = 2;
const VALID_BODY = { reason: '端末の紛失。ビデオ通話で本人を確認した', identity_check: 'video_call', identity_confirmed: true };

function factor(id: string, status: 'verified' | 'unverified') {
  return { id, factor_type: 'totp', status, friendly_name: 'authenticator', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
}

/** 実行者のセッション (既定 = 登録済みの super_admin の aal2) */
function signIn(options: { roles?: string[]; aal?: 'aal1' | 'aal2'; actorId?: string } = {}) {
  const actorId = options.actorId ?? ACTOR_ID;
  mocks.state.authUser = { id: actorId, email: 'actor@example.com', factors: [factor(ACTOR_FACTOR_ID, 'verified')] };
  mocks.state.profile = { roles: options.roles ?? ['super_admin'], organization_id: null, frozen_at: null, unban_at: null };
  mocks.state.session = { access_token: 'header.payload.signature', refresh_token: 'real-refresh-token' };
  mocks.state.claims = { sub: actorId, aal: options.aal ?? 'aal2', session_id: 'session-1' };
}

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}/api/super-admin/admins/${TARGET_ID}/mfa/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'user-agent': 'vitest', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function reset(options: { id?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await resetPOST(request(options.body ?? VALID_BODY, options.headers), {
    params: Promise.resolve({ id: options.id ?? TARGET_ID }),
  });
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, unknown> };
}

function auditCalls() {
  return mocks.recordMfaAudit.mock.calls.map(
    ([input]) =>
      input as { action: string; details: Record<string, unknown>; actorId: string; targetUserId: string; routeName: string },
  );
}

/** 監査も、全セッションの終了も、削除も起きていない */
function expectNothingChanged() {
  expect(mocks.recordMfaAudit).not.toHaveBeenCalled();
  expect(mocks.adminClient.rpc).not.toHaveBeenCalled();
  expect(mocks.adminClient.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
  expect(mocks.deleteBackupCodes).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [
    mocks.adminClient.rpc,
    mocks.adminClient.auth.admin.signOut,
    mocks.adminClient.auth.admin.mfa.listFactors,
    mocks.adminClient.auth.admin.mfa.deleteFactor,
    mocks.countRemainingBackupCodes,
    mocks.deleteBackupCodes,
    mocks.recordMfaAudit,
  ]) {
    fn.mockReset();
  }
  vi.unstubAllEnvs();
  vi.stubEnv('OPERATOR_MFA_ENFORCE_FROM', '');
  mocks.order.length = 0;
  signIn();
  mocks.state.target = { data: { id: TARGET_ID }, error: null };
  mocks.adminClient.auth.admin.mfa.listFactors.mockImplementation(async () => {
    mocks.order.push('listFactors');
    return { data: { factors: [factor(TARGET_FACTOR_ID, 'verified'), factor(TARGET_UNVERIFIED_FACTOR_ID, 'unverified')] }, error: null };
  });
  mocks.adminClient.auth.admin.mfa.deleteFactor.mockImplementation(async ({ id }: { id: string }) => {
    mocks.order.push(`deleteFactor:${id}`);
    return { data: { id }, error: null };
  });
  mocks.adminClient.rpc.mockImplementation(async (fn: string) => {
    mocks.order.push(`rpc:${fn}`);
    return { data: ENDED_SESSIONS, error: null };
  });
  mocks.countRemainingBackupCodes.mockImplementation(async () => {
    mocks.order.push('countRemainingBackupCodes');
    return REMAINING_CODES;
  });
  mocks.deleteBackupCodes.mockImplementation(async () => {
    mocks.order.push('deleteBackupCodes');
    return DELETED_CODES;
  });
  mocks.recordMfaAudit.mockImplementation(async () => {
    mocks.order.push('audit');
    return { ok: true };
  });
});

describe('POST /api/super-admin/admins/{id}/mfa/reset (§14.7)', () => {
  it('reset: super_admin 以外 → 403 / aal1 → 403 / 自分 → 403 OP_SELF_MODIFY / 対象無し → 404 / 本文 → 400 OP_INVALID_INPUT (identity_confirmed:false も) / 監査の記録に失敗 → 500 で endUserSessions も factor の削除も呼ばない', async () => {
    // super_admin でない (admin だけ・aal2)
    signIn({ roles: ['admin'] });
    let res = await reset();
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: 'FORBIDDEN', message: expect.any(String) } });
    expectNothingChanged();
    expect(mocks.adminClient.auth.admin.mfa.listFactors).not.toHaveBeenCalled();

    // aal1 (登録済みの super_admin) → MfaRequiredError も 403 FORBIDDEN (err.code は本文に出さない)
    signIn({ aal: 'aal1' });
    res = await reset();
    expect(res.status).toBe(403);
    expect((res.body.error as { code: string }).code).toBe('FORBIDDEN');
    expect(JSON.stringify(res.body)).not.toContain('AUTH_2FA_REQUIRED');
    expectNothingChanged();

    // 未認証 → 401 UNAUTHORIZED
    mocks.state.authUser = null;
    res = await reset();
    expect(res.status).toBe(401);
    expect((res.body.error as { code: string }).code).toBe('UNAUTHORIZED');
    expectNothingChanged();

    // 自分 → 403 OP_SELF_MODIFY (本文の検証より前に断る: 本文が壊れていても OP_SELF_MODIFY)
    signIn();
    res = await reset({ id: ACTOR_ID, body: 'not json' });
    expect(res.status).toBe(403);
    expect((res.body.error as { code: string }).code).toBe('OP_SELF_MODIFY');
    expect(mocks.adminClient.from).not.toHaveBeenCalled();
    expectNothingChanged();

    // 本文 → 400 OP_INVALID_INPUT (JSON でない・identity_confirmed:false・理由が空白だけ・理由が長すぎる・本人確認の方法が列挙の外)
    for (const body of [
      'not json',
      { ...VALID_BODY, identity_confirmed: false },
      { ...VALID_BODY, reason: '   ' },
      { ...VALID_BODY, reason: 'あ'.repeat(501) },
      { ...VALID_BODY, identity_check: 'photo_upload' },
      { reason: VALID_BODY.reason },
    ]) {
      res = await reset({ body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((res.body.error as { code: string }).code).toBe('OP_INVALID_INPUT');
    }
    expect(mocks.adminClient.from).not.toHaveBeenCalled();
    expectNothingChanged();

    // 対象無し → 404 (行が無い・id が UUID の形でない)
    mocks.state.target = { data: null, error: null };
    res = await reset();
    expect(res.status).toBe(404);
    expect((res.body.error as { code: string }).code).toBe('NOT_FOUND');
    expect(mocks.targetSelect).toHaveBeenCalledWith('user_profiles', 'id', 'id', TARGET_ID);
    res = await reset({ id: 'not-a-uuid' });
    expect(res.status).toBe(404);
    expect((res.body.error as { code: string }).code).toBe('NOT_FOUND');
    expect(mocks.adminClient.auth.admin.mfa.listFactors).not.toHaveBeenCalled();
    expectNothingChanged();

    // 対象の user_profiles の読み取りの失敗 → 500 (監査を書かない)
    mocks.state.target = { data: null, error: { message: RAW_DB_TEXT } };
    res = await reset();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret_detail');
    expectNothingChanged();

    // 監査の記録に失敗 → 500 で endUserSessions も factor の削除も呼ばない (fail-closed)
    mocks.state.target = { data: { id: TARGET_ID }, error: null };
    mocks.recordMfaAudit.mockResolvedValueOnce({ ok: false, error: new Error(RAW_DB_TEXT) });
    res = await reset();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: expect.any(String) } });
    expect(JSON.stringify(res.body)).not.toContain('secret_detail');
    expect(mocks.recordMfaAudit).toHaveBeenCalledTimes(1);
    expect(mocks.adminClient.rpc).not.toHaveBeenCalled();
    expect(mocks.adminClient.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
    expect(mocks.deleteBackupCodes).not.toHaveBeenCalled();

    // 別オリジン → 403 FORBIDDEN_ORIGIN (認可より前)
    mocks.recordMfaAudit.mockClear();
    res = await reset({ headers: { origin: 'https://evil.example.com' } });
    expect(res.status).toBe(403);
    expect((res.body.error as { code: string }).code).toBe('FORBIDDEN_ORIGIN');
    expect(mocks.recordMfaAudit).not.toHaveBeenCalled();
  });

  it('reset: 自分の UUID を大文字 (と大文字小文字の混在) にしても 403 OP_SELF_MODIFY で、対象の読み取りも監査も RPC も削除もしない (#1707。Postgres の uuid 比較は大文字小文字を区別しない)', async () => {
    // auth.getUser() の id は小文字 (HEX_ACTOR_ID)。パスにはその大文字・混在の形を入れる
    signIn({ actorId: HEX_ACTOR_ID });
    for (const selfId of [HEX_ACTOR_ID.toUpperCase(), HEX_ACTOR_ID_MIXED]) {
      expect(selfId).not.toBe(HEX_ACTOR_ID);
      expect(selfId.toLowerCase()).toBe(HEX_ACTOR_ID);
      // 本文の検証より前に断る (本文が正しくても壊れていても OP_SELF_MODIFY)
      for (const body of [VALID_BODY, 'not json']) {
        const res = await reset({ id: selfId, body });
        expect(res.status, `${selfId} ${JSON.stringify(body)}`).toBe(403);
        expect(res.body).toEqual({ error: { code: 'OP_SELF_MODIFY', message: expect.any(String) } });
      }
    }
    expect(mocks.adminClient.from).not.toHaveBeenCalled();
    expect(mocks.adminClient.auth.admin.mfa.listFactors).not.toHaveBeenCalled();
    expect(mocks.countRemainingBackupCodes).not.toHaveBeenCalled();
    expectNothingChanged();
  });

  it('reset: 対象の UUID が大文字なら小文字にそろえた 1 つの値で、user_profiles の読み取り・listFactors・countRemainingBackupCodes・監査の targetUserId・endUserSessions の RPC・deleteFactor・deleteBackupCodes・応答の user_id を扱う (#1707)', async () => {
    const res = await reset({ id: TARGET_ID_UPPER });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { user_id: TARGET_ID_LOWER, factors_deleted: 2, backup_codes_deleted: DELETED_CODES } });
    expect(mocks.targetSelect).toHaveBeenCalledWith('user_profiles', 'id', 'id', TARGET_ID_LOWER);
    expect(mocks.adminClient.auth.admin.mfa.listFactors).toHaveBeenCalledWith({ userId: TARGET_ID_LOWER });
    expect(mocks.countRemainingBackupCodes).toHaveBeenCalledWith(mocks.adminClient, TARGET_ID_LOWER);
    expect(auditCalls()).toEqual([expect.objectContaining({ actorId: ACTOR_ID, targetUserId: TARGET_ID_LOWER })]);
    expect(mocks.adminClient.rpc).toHaveBeenCalledWith('operator_mfa_end_sessions', { p_user_id: TARGET_ID_LOWER });
    expect(mocks.adminClient.auth.admin.mfa.deleteFactor.mock.calls.map(([arg]) => arg)).toEqual([
      { id: TARGET_FACTOR_ID, userId: TARGET_ID_LOWER },
      { id: TARGET_UNVERIFIED_FACTOR_ID, userId: TARGET_ID_LOWER },
    ]);
    expect(mocks.deleteBackupCodes).toHaveBeenCalledWith(mocks.adminClient, TARGET_ID_LOWER);
    // 大文字の値はどこにも渡らない
    expect(JSON.stringify([
      mocks.targetSelect.mock.calls,
      mocks.adminClient.auth.admin.mfa.listFactors.mock.calls,
      mocks.countRemainingBackupCodes.mock.calls.map(([, id]) => id),
      auditCalls().map((call) => call.targetUserId),
      mocks.adminClient.rpc.mock.calls,
      mocks.adminClient.auth.admin.mfa.deleteFactor.mock.calls,
      mocks.deleteBackupCodes.mock.calls.map(([, id]) => id),
      res.body,
    ])).not.toContain(TARGET_ID_UPPER);
  });

  it("reset: 成功は listFactors → countRemainingBackupCodes → 監査 (critical・details = { reason, identity_check, factors_before: 読んだ factor の数, backup_codes_before: 未使用の残数}) → endUserSessions (rpc('operator_mfa_end_sessions', { p_user_id: 対象の id }) を 1 回) → 読んだ factor ごとに deleteFactor → deleteBackupCodes の順で、200 の data は { user_id, factors_deleted, backup_codes_deleted } (使用済みの行があれば backup_codes_before と backup_codes_deleted は違う値。終えたセッションの数は本文に無い)", async () => {
    const res = await reset();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(MfaResetResponseSchema.parse(res.body)).toEqual({
      data: { user_id: TARGET_ID, factors_deleted: 2, backup_codes_deleted: DELETED_CODES },
    });
    expect(Object.keys(res.body.data as Record<string, unknown>).sort()).toEqual(['backup_codes_deleted', 'factors_deleted', 'user_id']);
    expect(mocks.order).toEqual([
      'from:user_profiles',
      'listFactors',
      'countRemainingBackupCodes',
      'audit',
      'rpc:operator_mfa_end_sessions',
      `deleteFactor:${TARGET_FACTOR_ID}`,
      `deleteFactor:${TARGET_UNVERIFIED_FACTOR_ID}`,
      'deleteBackupCodes',
    ]);
    expect(mocks.adminClient.auth.admin.mfa.listFactors).toHaveBeenCalledWith({ userId: TARGET_ID });
    expect(mocks.countRemainingBackupCodes).toHaveBeenCalledWith(mocks.adminClient, TARGET_ID);
    expect(mocks.adminClient.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.adminClient.rpc).toHaveBeenCalledWith('operator_mfa_end_sessions', { p_user_id: TARGET_ID });
    expect(mocks.adminClient.auth.admin.mfa.deleteFactor.mock.calls.map(([arg]) => arg)).toEqual([
      { id: TARGET_FACTOR_ID, userId: TARGET_ID },
      { id: TARGET_UNVERIFIED_FACTOR_ID, userId: TARGET_ID },
    ]);
    expect(mocks.deleteBackupCodes).toHaveBeenCalledWith(mocks.adminClient, TARGET_ID);
    // admin.signOut (回復の手段) は使わない (§7.1)
    expect(mocks.adminClient.auth.admin.signOut).not.toHaveBeenCalled();

    expect(auditCalls()).toEqual([
      expect.objectContaining({
        action: 'super_admin.mfa.reset',
        actorId: ACTOR_ID,
        targetUserId: TARGET_ID,
        routeName: 'POST /api/super-admin/admins/[id]/mfa/reset',
        details: {
          reason: VALID_BODY.reason,
          identity_check: 'video_call',
          factors_before: 2,
          backup_codes_before: REMAINING_CODES,
        },
      }),
    ]);
    // 終えたセッションの数 (ENDED_SESSIONS) は本文にも監査にも入らない (Q-19)
    expect(JSON.stringify(res.body)).not.toMatch(/session/i);
    expect(JSON.stringify(auditCalls()[0].details)).not.toMatch(/session/i);
  });

  it('reset: 理由は trim した値を監査に書く', async () => {
    const res = await reset({ body: { ...VALID_BODY, reason: `  ${VALID_BODY.reason}  ` } });
    expect(res.status).toBe(200);
    expect(auditCalls()[0].details.reason).toBe(VALID_BODY.reason);
  });

  it('reset: listFactors の error・countRemainingBackupCodes の例外 → 500 で、監査を書かず endUserSessions も deleteFactor も deleteBackupCodes も呼ばない', async () => {
    mocks.adminClient.auth.admin.mfa.listFactors.mockResolvedValueOnce({ data: null, error: { message: RAW_DB_TEXT } });
    let res = await reset();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret_detail');
    expect(mocks.countRemainingBackupCodes).not.toHaveBeenCalled();
    expectNothingChanged();

    mocks.countRemainingBackupCodes.mockRejectedValueOnce(new Error(RAW_DB_TEXT));
    res = await reset();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: expect.any(String) } });
    expect(JSON.stringify(res.body)).not.toContain('secret_detail');
    expectNothingChanged();
  });

  it('reset: endUserSessions が投げる (rpc の error) → 500 で、監査は 1 行書いた後、deleteFactor も deleteBackupCodes も呼ばない (本文に生のエラー文が無い。S-33)', async () => {
    mocks.adminClient.rpc.mockResolvedValueOnce({ data: null, error: { message: RAW_DB_TEXT, code: '42501' } });
    const res = await reset();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: expect.any(String) } });
    expect(JSON.stringify(res.body)).not.toContain('secret_detail');
    expect(mocks.recordMfaAudit).toHaveBeenCalledTimes(1);
    expect(mocks.adminClient.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.adminClient.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
    expect(mocks.deleteBackupCodes).not.toHaveBeenCalled();

    // 数でない戻り (型の生成物と食い違う応答) も同じ
    mocks.recordMfaAudit.mockClear();
    mocks.adminClient.rpc.mockResolvedValueOnce({ data: 'two', error: null });
    const second = await reset();
    expect(second.status).toBe(500);
    expect(mocks.adminClient.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
    expect(mocks.deleteBackupCodes).not.toHaveBeenCalled();
  });

  it('reset: deleteFactor の error → 500 で、endUserSessions と監査は済んだ後 (要求の記録は残る)', async () => {
    mocks.adminClient.auth.admin.mfa.deleteFactor.mockImplementationOnce(async ({ id }: { id: string }) => {
      mocks.order.push(`deleteFactor:${id}`);
      return { data: null, error: { message: RAW_DB_TEXT } };
    });
    const res = await reset();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret_detail');
    expect(mocks.order).toEqual([
      'from:user_profiles',
      'listFactors',
      'countRemainingBackupCodes',
      'audit',
      'rpc:operator_mfa_end_sessions',
      `deleteFactor:${TARGET_FACTOR_ID}`,
    ]);
    expect(mocks.deleteBackupCodes).not.toHaveBeenCalled();

    // deleteBackupCodes が投げる → 500 (factor の削除とセッションの終了は済んだ後)
    mocks.order.length = 0;
    mocks.deleteBackupCodes.mockRejectedValueOnce(new Error(RAW_DB_TEXT));
    const second = await reset();
    expect(second.status).toBe(500);
    expect(JSON.stringify(second.body)).not.toContain('secret_detail');
    expect(mocks.order).toEqual([
      'from:user_profiles',
      'listFactors',
      'countRemainingBackupCodes',
      'audit',
      'rpc:operator_mfa_end_sessions',
      `deleteFactor:${TARGET_FACTOR_ID}`,
      `deleteFactor:${TARGET_UNVERIFIED_FACTOR_ID}`,
    ]);
    expect(mocks.deleteBackupCodes).toHaveBeenCalledTimes(1);
  });

  it('reset: 対象の factor が 0 でも endUserSessions を呼び、200 { factors_deleted: 0 } (S-35)', async () => {
    mocks.adminClient.auth.admin.mfa.listFactors.mockResolvedValueOnce({ data: { factors: [] }, error: null });
    mocks.adminClient.rpc.mockResolvedValueOnce({ data: 0, error: null });
    const res = await reset();
    expect(res.status).toBe(200);
    expect((res.body.data as Record<string, unknown>).factors_deleted).toBe(0);
    expect(mocks.adminClient.rpc).toHaveBeenCalledWith('operator_mfa_end_sessions', { p_user_id: TARGET_ID });
    expect(mocks.adminClient.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
    expect(auditCalls()[0].details).toMatchObject({ factors_before: 0 });
  });

  it('reset: 対象が必須ロールでない (U0。user_profiles の roles に MFA_REQUIRED_ROLES のどれも無い) でも 403 にせず同じ手順で、endUserSessions を 1 回呼び、factor とコードが 0 なら 200 { factors_deleted: 0, backup_codes_deleted: 0 }。factor とコードが残っていれば (ロールの剥奪の後 Q-4) deleteFactor と deleteBackupCodes で消して、その数を返す (§10 の (U0, S*) の reset の行・§14.7)', async () => {
    // route は対象のロールを読まない (user_profiles は id だけを読む)
    mocks.adminClient.auth.admin.mfa.listFactors.mockResolvedValueOnce({ data: { factors: [] }, error: null });
    mocks.countRemainingBackupCodes.mockResolvedValueOnce(0);
    mocks.deleteBackupCodes.mockResolvedValueOnce(0);
    mocks.adminClient.rpc.mockResolvedValueOnce({ data: 0, error: null });
    let res = await reset();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { user_id: TARGET_ID, factors_deleted: 0, backup_codes_deleted: 0 } });
    expect(mocks.targetSelect).toHaveBeenCalledWith('user_profiles', 'id', 'id', TARGET_ID);
    expect(mocks.adminClient.rpc).toHaveBeenCalledTimes(1);
    expect(auditCalls()[0].details).toMatchObject({ factors_before: 0, backup_codes_before: 0 });

    // ロールの剥奪の後に残った factor とコードは消える
    mocks.adminClient.rpc.mockClear();
    mocks.adminClient.auth.admin.mfa.listFactors.mockResolvedValueOnce({ data: { factors: [factor(TARGET_FACTOR_ID, 'verified')] }, error: null });
    res = await reset();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { user_id: TARGET_ID, factors_deleted: 1, backup_codes_deleted: DELETED_CODES } });
    expect(mocks.adminClient.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.adminClient.auth.admin.mfa.deleteFactor).toHaveBeenLastCalledWith({ id: TARGET_FACTOR_ID, userId: TARGET_ID });
  });

  it('reset: reason に NULL 文字 (U+0000) → 400 OP_INVALID_INPUT で、監査も factor の削除もしない (§14.7。jsonb に U+0000 を渡さない)', async () => {
    const res = await reset({ body: { ...VALID_BODY, reason: '紛失\u0000の対応' } });
    expect(res.status).toBe(400);
    expect((res.body.error as { code: string; message: string }).code).toBe('OP_INVALID_INPUT');
    expect((res.body.error as { code: string; message: string }).message).toBe('使用できない文字 (NULL 文字) が含まれています');
    expect(mocks.adminClient.from).not.toHaveBeenCalled();
    expectNothingChanged();
  });
});
