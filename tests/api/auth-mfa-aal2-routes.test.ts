/**
 * #1176 運営ロールの MFA の自己サービス API のうち AAL2 が要る 2 route (段 B) と、段 A の 4 route が段 B の後も aal1 で使えること。
 * docs/design/cross/12-operator-mfa.md §14.4・§14.6・§17.2・§21.2 (auth-mfa-aal2-routes.test.ts)
 *
 * requireRole は本物 (@/lib/auth/helpers。段 B の AAL2 のゲート) を通し、Supabase の client (本人・service_role) を偽物にする。
 * バックアップコードの表の関数と監査 (recordMfaAudit) は差し替え、呼ぶ順と引数を見る。
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
  };
  const userClient = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: state.authUser },
        error: state.authUser ? null : { message: 'Auth session missing!', status: 401 },
      })),
      getSession: vi.fn(async () => ({ data: { session: state.session }, error: null })),
      getClaims: vi.fn(async () => ({ data: state.claims ? { claims: state.claims } : null, error: null })),
      refreshSession: vi.fn(),
      mfa: {
        enroll: vi.fn(),
        unenroll: vi.fn(),
        challengeAndVerify: vi.fn(),
      },
    },
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: state.profile, error: state.profile ? null : { message: 'no rows' } }),
        }),
      }),
    })),
  };
  const adminClient = {
    auth: { admin: { signOut: vi.fn(), mfa: { listFactors: vi.fn(), deleteFactor: vi.fn() } } },
  };
  return {
    order,
    state,
    userClient,
    adminClient,
    issueBackupCodes: vi.fn(),
    consumeBackupCode: vi.fn(),
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
    issueBackupCodes: mocks.issueBackupCodes,
    consumeBackupCode: mocks.consumeBackupCode,
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

import { DELETE as factorDELETE } from '@/app/api/auth/mfa/factors/[id]/route';
import { POST as backupCodesPOST } from '@/app/api/auth/mfa/backup-codes/route';
import { GET as statusGET } from '@/app/api/auth/mfa/status/route';
import { POST as enrollPOST } from '@/app/api/auth/mfa/enroll/route';
import { POST as verifyPOST } from '@/app/api/auth/mfa/verify/route';
import { POST as recoverPOST } from '@/app/api/auth/mfa/recover/route';
import { BACKUP_CODE_COUNT, formatBackupCode } from '@/lib/auth/mfa/backup-codes';
import { MfaBackupCodesResponseSchema, MfaUnenrollResponseSchema } from '@/lib/auth/mfa/schemas';
import { NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER } from '@/lib/native-auth-bridge';

const ORIGIN = 'http://localhost:3000';
const VERIFIED_FACTOR_ID = '55555555-5555-4555-8555-555555555555';
const UNVERIFIED_FACTOR_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_FACTOR_ID = '77777777-7777-4777-8777-777777777777';
const RAW_DB_TEXT = 'relation "operator_mfa_backup_codes" violates constraint secret_detail';
const TEN_CODES = Array.from({ length: BACKUP_CODE_COUNT }, (_, i) => `ABCDEFGH${'JKLMNPQRST'[i]}${'UVWXYZ2345'[i]}`);
const DELETED_CODES = 7;
/** 猶予の日時 (未来) */
const FUTURE_ENFORCE_FROM = '2999-01-01T00:00:00+09:00';

let userSeq = 0;
let userId = '';

function factor(id: string, status: 'verified' | 'unverified', factorType: 'totp' | 'phone' = 'totp') {
  return { id, factor_type: factorType, status, friendly_name: 'authenticator', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
}

const VERIFIED = () => factor(VERIFIED_FACTOR_ID, 'verified');
const UNVERIFIED = () => factor(UNVERIFIED_FACTOR_ID, 'unverified');

function signIn(options: { roles?: string[]; factors?: unknown[]; aal?: 'aal1' | 'aal2'; bridged?: boolean } = {}) {
  mocks.state.authUser = { id: userId, email: `${userId}@example.com`, factors: options.factors ?? [] };
  mocks.state.profile = { roles: options.roles ?? ['admin'], organization_id: null, frozen_at: null, unban_at: null };
  mocks.state.session = {
    access_token: 'header.payload.signature',
    refresh_token: options.bridged ? NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER : 'real-refresh-token',
  };
  mocks.state.claims = { sub: userId, aal: options.aal ?? 'aal1', session_id: 'session-1' };
}

function request(path: string, method: 'POST' | 'DELETE', headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'user-agent': 'vitest', ...headers },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
}

async function read(response: Response) {
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, unknown> };
}

const unenroll = async (factorId: string = VERIFIED_FACTOR_ID, headers: Record<string, string> = {}) =>
  read(
    await factorDELETE(request(`/api/auth/mfa/factors/${factorId}`, 'DELETE', headers), {
      params: Promise.resolve({ id: factorId }),
    }),
  );
const regenerate = async (headers: Record<string, string> = {}) =>
  read(await backupCodesPOST(request('/api/auth/mfa/backup-codes', 'POST', headers)));

function auditCalls() {
  return mocks.recordMfaAudit.mock.calls.map(
    ([input]) => input as { action: string; details: Record<string, unknown>; actorId: string; targetUserId: string; routeName: string },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [
    mocks.userClient.auth.mfa.challengeAndVerify,
    mocks.userClient.auth.mfa.unenroll,
    mocks.userClient.auth.mfa.enroll,
    mocks.userClient.auth.refreshSession,
    mocks.adminClient.auth.admin.signOut,
    mocks.adminClient.auth.admin.mfa.listFactors,
    mocks.adminClient.auth.admin.mfa.deleteFactor,
    mocks.issueBackupCodes,
    mocks.consumeBackupCode,
    mocks.countRemainingBackupCodes,
    mocks.deleteBackupCodes,
    mocks.recordMfaAudit,
  ]) {
    fn.mockReset();
  }
  vi.unstubAllEnvs();
  vi.stubEnv('OPERATOR_MFA_ENFORCE_FROM', '');
  mocks.order.length = 0;
  userSeq += 1;
  userId = `22222222-2222-4222-8222-${String(userSeq).padStart(12, '0')}`;
  signIn();
  mocks.userClient.auth.mfa.unenroll.mockImplementation(async ({ factorId }: { factorId: string }) => {
    mocks.order.push(`unenroll:${factorId}`);
    return { data: { id: factorId }, error: null };
  });
  mocks.userClient.auth.refreshSession.mockImplementation(async () => {
    mocks.order.push('refreshSession');
    return { data: { session: { access_token: 'aal1' } }, error: null };
  });
  mocks.userClient.auth.mfa.challengeAndVerify.mockResolvedValue({ data: { access_token: 'aal2' }, error: null });
  mocks.userClient.auth.mfa.enroll.mockResolvedValue({
    data: {
      id: UNVERIFIED_FACTOR_ID,
      type: 'totp',
      friendly_name: 'authenticator',
      totp: { qr_code: 'data:image/svg+xml;utf-8,<svg></svg>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' },
    },
    error: null,
  });
  mocks.adminClient.auth.admin.mfa.listFactors.mockResolvedValue({ data: { factors: [VERIFIED()] }, error: null });
  mocks.adminClient.auth.admin.mfa.deleteFactor.mockResolvedValue({ data: {}, error: null });
  // 回復の route が本人の全セッションを終える (cross/12 §14.5)
  mocks.adminClient.auth.admin.signOut.mockResolvedValue({ data: null, error: null });
  mocks.issueBackupCodes.mockImplementation(async () => {
    mocks.order.push('issueBackupCodes');
    return [...TEN_CODES];
  });
  mocks.consumeBackupCode.mockResolvedValue(true);
  mocks.countRemainingBackupCodes.mockResolvedValue(3);
  mocks.deleteBackupCodes.mockImplementation(async () => {
    mocks.order.push('deleteBackupCodes');
    return DELETED_CODES;
  });
  mocks.recordMfaAudit.mockImplementation(async () => {
    mocks.order.push('audit');
    return { ok: true };
  });
});

describe('DELETE /api/auth/mfa/factors/{id} (§14.4)', () => {
  it("DELETE /factors/{id}: aal1 + verified → 403 AUTH_2FA_REQUIRED / aal1 + 未登録 + 猶予なし → 403 AUTH_2FA_ENROLLMENT_REQUIRED / 本人でない → 404 / 成功で unenroll → deleteBackupCodes → refreshSession → 監査 admin.mfa.unenroll (details { factor_id, backup_codes_deleted: 消した行の数, failed_step: null }) → 200 { ok: true, aal: 'aal1' }", async () => {
    signIn({ aal: 'aal1', factors: [VERIFIED()] });
    const challenge = await unenroll();
    expect(challenge.status).toBe(403);
    expect(challenge.body.code).toBe('AUTH_2FA_REQUIRED');

    signIn({ aal: 'aal1', factors: [] });
    const enrollment = await unenroll();
    expect(enrollment.status).toBe(403);
    expect(enrollment.body.code).toBe('AUTH_2FA_ENROLLMENT_REQUIRED');
    expect(mocks.userClient.auth.mfa.unenroll).not.toHaveBeenCalled();

    signIn({ aal: 'aal2', factors: [VERIFIED()] });
    const notMine = await unenroll(OTHER_FACTOR_ID);
    expect(notMine.status).toBe(404);
    expect(notMine.body.code).toBe('AUTH_2FA_NOT_ENROLLED');
    expect(mocks.userClient.auth.mfa.unenroll).not.toHaveBeenCalled();

    const ok = await unenroll();
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, aal: 'aal1' });
    expect(MfaUnenrollResponseSchema.safeParse(ok.body).success).toBe(true);
    expect(ok.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.order).toEqual([`unenroll:${VERIFIED_FACTOR_ID}`, 'deleteBackupCodes', 'refreshSession', 'audit']);
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]).toMatchObject({
      action: 'admin.mfa.unenroll',
      actorId: userId,
      targetUserId: userId,
      details: { factor_id: VERIFIED_FACTOR_ID, backup_codes_deleted: DELETED_CODES, failed_step: null },
    });
  });

  it('DELETE /factors/{id}: mfa.unenroll の error は 500 で、deleteBackupCodes・refreshSession・監査を呼ばない', async () => {
    signIn({ aal: 'aal2', factors: [VERIFIED()] });
    mocks.userClient.auth.mfa.unenroll.mockResolvedValueOnce({ data: null, error: { message: RAW_DB_TEXT, status: 500 } });
    const result = await unenroll();
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(mocks.deleteBackupCodes).not.toHaveBeenCalled();
    expect(mocks.userClient.auth.refreshSession).not.toHaveBeenCalled();
    expect(mocks.recordMfaAudit).not.toHaveBeenCalled();
  });

  it("DELETE /factors/{id}: unenroll の後に deleteBackupCodes が投げたら refreshSession を呼ばず、監査を details { factor_id, backup_codes_deleted: null, failed_step: 'delete_backup_codes' } で 1 回書いて 500", async () => {
    signIn({ aal: 'aal2', factors: [VERIFIED()] });
    mocks.deleteBackupCodes.mockRejectedValueOnce(new Error(RAW_DB_TEXT));
    const result = await unenroll();
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain('violates');
    expect(mocks.userClient.auth.refreshSession).not.toHaveBeenCalled();
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0].details).toEqual({ factor_id: VERIFIED_FACTOR_ID, backup_codes_deleted: null, failed_step: 'delete_backup_codes' });
  });

  it("DELETE /factors/{id}: refreshSession が error を返したら 200 { ok: true, aal: 'aal2' } で、監査を details { factor_id, backup_codes_deleted: 消した行の数, failed_step: 'refresh_session' } で 1 回書き、失敗を app_logs に残す", async () => {
    signIn({ aal: 'aal2', factors: [VERIFIED()] });
    mocks.userClient.auth.refreshSession.mockResolvedValueOnce({ data: { session: null }, error: { message: 'refresh failed', status: 400 } });
    const result = await unenroll();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, aal: 'aal2' });
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0].details).toEqual({
      factor_id: VERIFIED_FACTOR_ID,
      backup_codes_deleted: DELETED_CODES,
      failed_step: 'refresh_session',
    });
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
  });

  it('DELETE /factors/{id}: 本人の unverified な TOTP factor の id (猶予中の aal1 と、aal2 の両方) → 404 AUTH_2FA_NOT_ENROLLED で、mfa.unenroll も deleteBackupCodes も refreshSession も監査も呼ばない', async () => {
    vi.stubEnv('OPERATOR_MFA_ENFORCE_FROM', FUTURE_ENFORCE_FROM);
    signIn({ aal: 'aal1', factors: [UNVERIFIED()] });
    const grace = await unenroll(UNVERIFIED_FACTOR_ID);
    expect(grace.status).toBe(404);
    expect(grace.body.code).toBe('AUTH_2FA_NOT_ENROLLED');

    signIn({ aal: 'aal2', factors: [VERIFIED(), UNVERIFIED()] });
    const aal2 = await unenroll(UNVERIFIED_FACTOR_ID);
    expect(aal2.status).toBe(404);
    expect(aal2.body.code).toBe('AUTH_2FA_NOT_ENROLLED');

    // TOTP でない verified な factor も 404
    signIn({ aal: 'aal2', factors: [VERIFIED(), factor(OTHER_FACTOR_ID, 'verified', 'phone')] });
    expect((await unenroll(OTHER_FACTOR_ID)).status).toBe(404);

    expect(mocks.userClient.auth.mfa.unenroll).not.toHaveBeenCalled();
    expect(mocks.deleteBackupCodes).not.toHaveBeenCalled();
    expect(mocks.userClient.auth.refreshSession).not.toHaveBeenCalled();
    expect(mocks.recordMfaAudit).not.toHaveBeenCalled();
  });

  it('DELETE /factors/{id}: アプリの WebView の借り物のセッション (aal2) → 409 AUTH_2FA_NATIVE_SESSION で、mfa.unenroll も refreshSession も呼ばない (S-28)', async () => {
    signIn({ aal: 'aal2', factors: [VERIFIED()], bridged: true });
    const result = await unenroll();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('AUTH_2FA_NATIVE_SESSION');
    expect(mocks.userClient.auth.mfa.unenroll).not.toHaveBeenCalled();
    expect(mocks.userClient.auth.refreshSession).not.toHaveBeenCalled();
    expect(mocks.recordMfaAudit).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/mfa/backup-codes (§14.6)', () => {
  it('POST /backup-codes: aal1 → 403 AUTH_2FA_REQUIRED / aal2 で factor 無し → 409 / 成功で旧行削除 + 10 個 + 監査 (details { backup_codes_issued: 10, failed_step: null })', async () => {
    signIn({ aal: 'aal1', factors: [VERIFIED()] });
    const challenge = await regenerate();
    expect(challenge.status).toBe(403);
    expect(challenge.body.code).toBe('AUTH_2FA_REQUIRED');
    expect(mocks.issueBackupCodes).not.toHaveBeenCalled();

    signIn({ aal: 'aal2', factors: [] });
    const notEnrolled = await regenerate();
    expect(notEnrolled.status).toBe(409);
    expect(notEnrolled.body.code).toBe('AUTH_2FA_NOT_ENROLLED');
    expect(mocks.issueBackupCodes).not.toHaveBeenCalled();

    signIn({ aal: 'aal2', factors: [VERIFIED()] });
    const ok = await regenerate();
    expect(ok.status).toBe(200);
    expect(MfaBackupCodesResponseSchema.safeParse(ok.body).success).toBe(true);
    expect(ok.body.backup_codes).toEqual(TEN_CODES.map(formatBackupCode));
    expect(ok.body.backup_codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(ok.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.issueBackupCodes).toHaveBeenCalledWith(mocks.adminClient, userId);
    expect(mocks.order).toEqual(['issueBackupCodes', 'audit']);
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]).toMatchObject({
      action: 'admin.mfa.backup_codes_regenerate',
      details: { backup_codes_issued: BACKUP_CODE_COUNT, failed_step: null },
    });
  });

  it("POST /backup-codes: issueBackupCodes が投げたら監査 admin.mfa.backup_codes_regenerate を details { backup_codes_issued: null, failed_step: 'issue_backup_codes' } で 1 回書いて 500 (本文に例外の文が無い)", async () => {
    signIn({ aal: 'aal2', factors: [VERIFIED()] });
    mocks.issueBackupCodes.mockRejectedValueOnce(new Error(RAW_DB_TEXT));
    const result = await regenerate();
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]).toMatchObject({
      action: 'admin.mfa.backup_codes_regenerate',
      details: { backup_codes_issued: null, failed_step: 'issue_backup_codes' },
    });
  });

  it('POST /backup-codes: アプリの WebView の借り物のセッション (aal2・verified あり) でも 409 AUTH_2FA_NATIVE_SESSION にせず、成功で旧行削除 + 10 個 + 監査 (§10 の借り物の backup-codes の行)', async () => {
    signIn({ aal: 'aal2', factors: [VERIFIED()], bridged: true });
    const result = await regenerate();
    expect(result.status).toBe(200);
    expect(result.body.backup_codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(auditCalls()).toHaveLength(1);
  });

  it('POST /backup-codes: 猶予中の未登録 (aal1) は認可を通って 409 AUTH_2FA_NOT_ENROLLED', async () => {
    vi.stubEnv('OPERATOR_MFA_ENFORCE_FROM', FUTURE_ENFORCE_FROM);
    signIn({ aal: 'aal1', factors: [] });
    const result = await regenerate();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('AUTH_2FA_NOT_ENROLLED');
  });
});

describe('段 A の 4 route は段 B の後も aal1 で使える', () => {
  it("status / enroll / verify / recover は aal1 の登録済み・未登録 (猶予なし) でも 403 にならない ({ assurance: 'session' })", async () => {
    const post = (path: string, body: unknown) =>
      new NextRequest(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, 'user-agent': 'vitest' },
        body: JSON.stringify(body),
      });
    for (const factors of [[VERIFIED()], [UNVERIFIED()]]) {
      signIn({ aal: 'aal1', factors });
      const factorId = factors[0].id;
      const results = [
        await statusGET(),
        await enrollPOST(post('/api/auth/mfa/enroll', {})),
        await verifyPOST(post('/api/auth/mfa/verify', { factor_id: factorId, code: '123456' })),
        await recoverPOST(post('/api/auth/mfa/recover', { code: 'ABCDE-FGHJK' })),
      ];
      for (const response of results) {
        expect(response.status, `${response.url} (${factors[0].status})`).not.toBe(403);
      }
    }
  });
});

describe('別オリジン', () => {
  it('DELETE / POST は別オリジンを 403 FORBIDDEN_ORIGIN', async () => {
    signIn({ aal: 'aal2', factors: [VERIFIED()] });
    const evil = { origin: 'https://evil.example' };
    for (const result of [await unenroll(VERIFIED_FACTOR_ID, evil), await regenerate(evil)]) {
      expect(result.status).toBe(403);
      expect(result.body.code).toBe('FORBIDDEN_ORIGIN');
      expect(result.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(mocks.userClient.auth.mfa.unenroll).not.toHaveBeenCalled();
    expect(mocks.issueBackupCodes).not.toHaveBeenCalled();
  });
});
