/**
 * #1176 運営ロールの MFA の自己サービス API (段 A の 4 route) の route テスト。
 * docs/design/cross/12-operator-mfa.md §14.1・§14.2・§14.3・§14.5・§17.2・§21.2 (auth-mfa-routes.test.ts)
 *
 * 段 A の requireRole はゲートを持たない (AAL を見ない) ので、AAL の 403 の検査は入れない (§0.2・§21.2)。
 * requireRole は本物 (@/lib/auth/helpers) を通し、Supabase の client (本人・service_role) を偽物にする。
 * バックアップコードの表の 4 関数と監査 (recordMfaAudit) は差し替え、呼ぶ順と引数を見る。回数制限は本物 (Upstash 未設定 = in-memory)。
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
    auth: { admin: { mfa: { listFactors: vi.fn(), deleteFactor: vi.fn() } } },
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

vi.mock('@/lib/auth/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/helpers')>();
  return { ...actual, requireRole: vi.fn(actual.requireRole) };
});

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

// 実物のレート制限 (Upstash 未設定 = in-memory) を使い、呼んだかどうかを見られるようにする
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>();
  return { ...actual, checkRateLimit: vi.fn(actual.checkRateLimit) };
});

import { GET as statusGET } from '@/app/api/auth/mfa/status/route';
import { POST as enrollPOST } from '@/app/api/auth/mfa/enroll/route';
import { POST as verifyPOST } from '@/app/api/auth/mfa/verify/route';
import { POST as recoverPOST } from '@/app/api/auth/mfa/recover/route';
import { requireRole } from '@/lib/auth/helpers';
import { BACKUP_CODE_COUNT, formatBackupCode, hashBackupCode } from '@/lib/auth/mfa/backup-codes';
import { MFA_REQUIRED_ROLES } from '@/lib/auth/mfa/policy';
import {
  MFA_RECOVER_NEXT_PATH,
  MfaEnrollResponseSchema,
  MfaRecoverResponseSchema,
  MfaStatusResponseSchema,
  MfaVerifyResponseSchema,
} from '@/lib/auth/mfa/schemas';
import { NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER } from '@/lib/native-auth-bridge';
import { checkRateLimit } from '@/lib/rate-limit';

const ORIGIN = 'http://localhost:3000';
const VERIFIED_FACTOR_ID = '55555555-5555-4555-8555-555555555555';
const UNVERIFIED_FACTOR_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_FACTOR_ID = '77777777-7777-4777-8777-777777777777';
const RAW_DB_TEXT = 'relation "operator_mfa_backup_codes" violates constraint secret_detail';
const TEN_CODES = Array.from({ length: BACKUP_CODE_COUNT }, (_, i) => `ABCDEFGH${'JKLMNPQRST'[i]}${'UVWXYZ2345'[i]}`);

let userSeq = 0;
/** テストごとに別の利用者 (in-memory の回数制限がテストをまたがないように) */
let userId = '';

function factor(id: string, status: 'verified' | 'unverified', factorType: 'totp' | 'phone' = 'totp') {
  return { id, factor_type: factorType, status, friendly_name: 'authenticator', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
}

function signIn(options: { roles?: string[]; factors?: unknown[]; aal?: 'aal1' | 'aal2'; bridged?: boolean } = {}) {
  mocks.state.authUser = { id: userId, email: `${userId}@example.com`, factors: options.factors ?? [] };
  mocks.state.profile = { roles: options.roles ?? ['admin'], organization_id: null, frozen_at: null, unban_at: null };
  mocks.state.session = {
    access_token: 'header.payload.signature',
    refresh_token: options.bridged ? NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER : 'real-refresh-token',
  };
  mocks.state.claims = { sub: userId, aal: options.aal ?? 'aal1', session_id: 'session-1' };
}

function signOut() {
  mocks.state.authUser = null;
  mocks.state.profile = null;
  mocks.state.session = null;
  mocks.state.claims = null;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'user-agent': 'vitest', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function read(response: Response) {
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, unknown> };
}

const verify = async (body: unknown = { factor_id: VERIFIED_FACTOR_ID, code: '123456' }, headers: Record<string, string> = {}) =>
  read(await verifyPOST(post('/api/auth/mfa/verify', body, headers)));
const recover = async (body: unknown = { code: 'abcde-fghjk' }, headers: Record<string, string> = {}) =>
  read(await recoverPOST(post('/api/auth/mfa/recover', body, headers)));
const enroll = async (headers: Record<string, string> = {}) => read(await enrollPOST(post('/api/auth/mfa/enroll', '', headers)));
const status = async () => read(await statusGET());

function auditCalls() {
  return mocks.recordMfaAudit.mock.calls.map(([input]) => input as { action: string; details: Record<string, unknown>; actorId: string; targetUserId: string; routeName: string });
}

beforeEach(() => {
  vi.clearAllMocks();
  // 前のテストで使い残した mockResolvedValueOnce を持ち越さない (下で実装を入れ直す)
  for (const fn of [
    mocks.userClient.auth.mfa.challengeAndVerify,
    mocks.userClient.auth.mfa.unenroll,
    mocks.userClient.auth.mfa.enroll,
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
  mocks.order.length = 0;
  userSeq += 1;
  userId = `11111111-1111-4111-8111-${String(userSeq).padStart(12, '0')}`;
  signIn();
  mocks.userClient.auth.mfa.challengeAndVerify.mockImplementation(async () => {
    mocks.order.push('challengeAndVerify');
    return { data: { access_token: 'aal2' }, error: null };
  });
  mocks.userClient.auth.mfa.unenroll.mockImplementation(async ({ factorId }: { factorId: string }) => {
    mocks.order.push(`unenroll:${factorId}`);
    return { data: { id: factorId }, error: null };
  });
  mocks.userClient.auth.mfa.enroll.mockImplementation(async () => {
    mocks.order.push('enroll');
    return {
      data: {
        id: UNVERIFIED_FACTOR_ID,
        type: 'totp',
        friendly_name: 'authenticator',
        // auth-js (2.105.3) は Supabase の応答の SVG に data URL の前置きを付けて返す (GoTrueClient._enroll)
        totp: { qr_code: 'data:image/svg+xml;utf-8,<svg></svg>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' },
      },
      error: null,
    };
  });
  mocks.adminClient.auth.admin.mfa.listFactors.mockImplementation(async () => {
    mocks.order.push('listFactors');
    return { data: { factors: [factor(VERIFIED_FACTOR_ID, 'verified'), factor(UNVERIFIED_FACTOR_ID, 'unverified')] }, error: null };
  });
  mocks.adminClient.auth.admin.mfa.deleteFactor.mockImplementation(async ({ id }: { id: string }) => {
    mocks.order.push(`deleteFactor:${id}`);
    return { data: { id }, error: null };
  });
  mocks.issueBackupCodes.mockImplementation(async () => {
    mocks.order.push('issueBackupCodes');
    return [...TEN_CODES];
  });
  mocks.consumeBackupCode.mockImplementation(async () => {
    mocks.order.push('consumeBackupCode');
    return true;
  });
  mocks.countRemainingBackupCodes.mockResolvedValue(9);
  mocks.deleteBackupCodes.mockImplementation(async () => {
    mocks.order.push('deleteBackupCodes');
    return 9;
  });
  mocks.recordMfaAudit.mockImplementation(async () => {
    mocks.order.push('audit');
    return { ok: true };
  });
});

describe('段 A の route の認可', () => {
  it('4 route とも requireRole を MFA_REQUIRED_ROLES の引数 1 つで呼ぶ (段 A の requireRole は今のまま。{ assurance } は段 B)', async () => {
    signIn({ factors: [factor(VERIFIED_FACTOR_ID, 'verified')] });
    await status();
    await enroll();
    await verify();
    await recover();
    expect(vi.mocked(requireRole)).toHaveBeenCalledTimes(4);
    for (const call of vi.mocked(requireRole).mock.calls) {
      expect(call).toEqual([MFA_REQUIRED_ROLES]);
    }
  });
});

describe('GET /api/auth/mfa/status', () => {
  it('GET /status: 対象ロールでない → 403 PERM_DENIED / 未認証 → 401 / 登録済み aal1 → enrolled:true aal:\'aal1\' / 猶予中 → grace:true', async () => {
    signIn({ roles: ['support'] });
    const denied = await status();
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PERM_DENIED');
    expect(mocks.userClient.auth.getClaims).not.toHaveBeenCalled();

    signOut();
    const anonymous = await status();
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe('AUTH_UNAUTHENTICATED');

    signIn({ roles: ['finance'], factors: [factor(VERIFIED_FACTOR_ID, 'verified'), factor(UNVERIFIED_FACTOR_ID, 'unverified')] });
    const enrolled = await status();
    expect(enrolled.status).toBe(200);
    expect(enrolled.headers.get('Cache-Control')).toBe('private, no-store');
    expect(MfaStatusResponseSchema.parse(enrolled.body)).toEqual({
      ok: true,
      required: true,
      enrolled: true,
      aal: 'aal1',
      factor: { id: VERIFIED_FACTOR_ID, friendly_name: 'authenticator', created_at: '2026-10-01T00:00:00Z' },
      backup_codes_remaining: 9,
      enforce_from: null,
      grace: false,
    });
    expect(mocks.countRemainingBackupCodes).toHaveBeenCalledWith(mocks.adminClient, userId);

    vi.stubEnv('OPERATOR_MFA_ENFORCE_FROM', '2999-01-01T00:00:00+09:00');
    signIn({ roles: ['admin'], factors: [factor(UNVERIFIED_FACTOR_ID, 'unverified')], aal: 'aal2' });
    const grace = await status();
    expect(grace.status).toBe(200);
    expect(grace.body).toMatchObject({
      enrolled: false,
      factor: null,
      aal: 'aal2',
      enforce_from: '2998-12-31T15:00:00.000Z',
      grace: true,
    });

    vi.stubEnv('OPERATOR_MFA_ENFORCE_FROM', '2000-01-01T00:00:00Z');
    const expired = await status();
    expect(expired.body).toMatchObject({ enforce_from: '2000-01-01T00:00:00.000Z', grace: false });
  });

  it('GET /status: claims を読めない (sub の不一致) は 401、残数を読めない (DB の失敗) は 500 で本文に DB の文が無い', async () => {
    mocks.state.claims = { sub: 'someone-else', aal: 'aal2' };
    const mismatch = await status();
    expect(mismatch.status).toBe(401);
    expect(mismatch.body.code).toBe('AUTH_UNAUTHENTICATED');

    signIn();
    mocks.countRemainingBackupCodes.mockRejectedValueOnce(new Error(RAW_DB_TEXT));
    const failed = await status();
    expect(failed.status).toBe(500);
    expect(failed.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(failed.body)).not.toContain('operator_mfa_backup_codes');
    expect(failed.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('POST /api/auth/mfa/enroll', () => {
  it('POST /enroll: verified あり → 409 / unverified を先に unenroll してから enroll / 応答に secret と qr_code_svg', async () => {
    signIn({ factors: [factor(VERIFIED_FACTOR_ID, 'verified')] });
    const conflict = await enroll();
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('AUTH_2FA_ALREADY_ENROLLED');
    expect(mocks.userClient.auth.mfa.enroll).not.toHaveBeenCalled();
    expect(mocks.userClient.auth.mfa.unenroll).not.toHaveBeenCalled();

    signIn({ factors: [factor('old-1', 'unverified'), factor('phone-x', 'unverified', 'phone'), factor('old-2', 'unverified')] });
    const ok = await enroll();
    expect(ok.status).toBe(200);
    expect(mocks.order).toEqual(['unenroll:old-1', 'unenroll:old-2', 'enroll']);
    expect(mocks.userClient.auth.mfa.enroll).toHaveBeenCalledWith({
      factorType: 'totp',
      issuer: 'ほめゴハン 運営',
      friendlyName: 'authenticator',
    });
    expect(MfaEnrollResponseSchema.parse(ok.body)).toEqual({
      ok: true,
      factor_id: UNVERIFIED_FACTOR_ID,
      qr_code_svg: '<svg></svg>',
      secret: 'JBSWY3DPEHPK3PXP',
      uri: 'otpauth://totp/x',
    });
    expect(ok.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.recordMfaAudit).not.toHaveBeenCalled();
  });

  it('POST /enroll: unenroll・enroll の失敗は 500 (本文に Supabase の文が無い)', async () => {
    signIn({ factors: [factor('old-1', 'unverified')] });
    mocks.userClient.auth.mfa.unenroll.mockResolvedValueOnce({ data: null, error: { message: RAW_DB_TEXT, status: 500 } });
    const unenrollFailed = await enroll();
    expect(unenrollFailed.status).toBe(500);
    expect(mocks.userClient.auth.mfa.enroll).not.toHaveBeenCalled();
    expect(JSON.stringify(unenrollFailed.body)).not.toContain('violates');

    signIn();
    mocks.userClient.auth.mfa.enroll.mockResolvedValueOnce({ data: null, error: { message: RAW_DB_TEXT, status: 500 } });
    const enrollFailed = await enroll();
    expect(enrollFailed.status).toBe(500);
    expect(JSON.stringify(enrollFailed.body)).not.toContain('violates');
  });

  it('POST /enroll: qr_code_svg は素の SVG (auth-js が付けた data URL の前置きを外す。画面の前置きと 2 重にしない #1707)', async () => {
    signIn();
    const prefixed = await enroll();
    expect(prefixed.status).toBe(200);
    expect(prefixed.body.qr_code_svg).toBe('<svg></svg>');
    expect(String(prefixed.body.qr_code_svg)).not.toContain('data:');

    // auth-js が前置きを付けない版でも素の SVG のまま返す (外し過ぎない)
    signIn();
    mocks.userClient.auth.mfa.enroll.mockResolvedValueOnce({
      data: {
        id: UNVERIFIED_FACTOR_ID,
        type: 'totp',
        friendly_name: 'authenticator',
        totp: { qr_code: '<svg></svg>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' },
      },
      error: null,
    });
    const bare = await enroll();
    expect(bare.status).toBe(200);
    expect(bare.body.qr_code_svg).toBe('<svg></svg>');
  });
});

describe('POST /api/auth/mfa/verify', () => {
  it('POST /verify: 未認証 (セッション切れ) → 401 AUTH_UNAUTHENTICATED で、mfa.challengeAndVerify も checkRateLimit も呼ばない (S-19)', async () => {
    signOut();
    const result = await verify();
    expect(result.status).toBe(401);
    expect(result.body.code).toBe('AUTH_UNAUTHENTICATED');
    expect(mocks.userClient.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(vi.mocked(checkRateLimit)).not.toHaveBeenCalled();
  });

  it('POST /verify: アプリの WebView の借り物のセッション (getSession の refresh_token が NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER) → 409 AUTH_2FA_NATIVE_SESSION で、checkRateLimit も mfa.challengeAndVerify も呼ばない (S-28)', async () => {
    signIn({ factors: [factor(VERIFIED_FACTOR_ID, 'verified')], bridged: true });
    const result = await verify();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('AUTH_2FA_NATIVE_SESSION');
    expect(vi.mocked(checkRateLimit)).not.toHaveBeenCalled();
    expect(mocks.userClient.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(mocks.issueBackupCodes).not.toHaveBeenCalled();
  });

  it('POST /verify: 本文の形 → 400 VALIDATION_ERROR / 他人の factor_id → 404 / 不一致 → 400 AUTH_2FA_INVALID / 6 回目 → 429 + Retry-After / unverified の verify はコード 10 個を返し監査 admin.mfa.enroll / verified の verify はコードを返さない', async () => {
    signIn({ factors: [factor(VERIFIED_FACTOR_ID, 'verified')] });
    for (const bad of [{}, { factor_id: 'not-a-uuid', code: '123456' }, { factor_id: VERIFIED_FACTOR_ID, code: '12345' }, { factor_id: VERIFIED_FACTOR_ID, code: '12345\u0000' }, 'not json']) {
      const result = await verify(bad);
      expect(result.status, JSON.stringify(bad)).toBe(400);
      expect(result.body.code).toBe('VALIDATION_ERROR');
    }
    expect(vi.mocked(checkRateLimit)).not.toHaveBeenCalled();
    expect(mocks.userClient.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();

    const notMine = await verify({ factor_id: OTHER_FACTOR_ID, code: '123456' });
    expect(notMine.status).toBe(404);
    expect(notMine.body.code).toBe('AUTH_2FA_NOT_ENROLLED');
    expect(mocks.userClient.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();

    mocks.userClient.auth.mfa.challengeAndVerify.mockResolvedValueOnce({
      data: null,
      error: { code: 'mfa_verification_failed', status: 422, message: 'Invalid TOTP code entered' },
    });
    const wrong = await verify();
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('AUTH_2FA_INVALID');

    const verified = await verify();
    expect(verified.status).toBe(200);
    expect(MfaVerifyResponseSchema.parse(verified.body)).toEqual({ ok: true, aal: 'aal2' });
    expect(mocks.issueBackupCodes).not.toHaveBeenCalled();
    expect(mocks.recordMfaAudit).not.toHaveBeenCalled();

    // 回数制限を数えたのは 404・不一致・成功の 3 回 (本文の形の 400 は数える前に返す)。4・5 回目は通り、6 回目で 429
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(userId, 'auth-mfa-verify');
    await verify();
    await verify();
    const limited = await verify();
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(mocks.userClient.auth.mfa.challengeAndVerify).toHaveBeenCalledTimes(4);

    // 登録 (unverified の factor) の verify はコード 10 個 (formatBackupCode 済み) を返し、監査 admin.mfa.enroll を書く
    userSeq += 1;
    userId = `11111111-1111-4111-8111-${String(userSeq).padStart(12, '0')}`;
    signIn({ factors: [factor(UNVERIFIED_FACTOR_ID, 'unverified')] });
    const enrolled = await verify({ factor_id: UNVERIFIED_FACTOR_ID, code: '654321' });
    expect(enrolled.status).toBe(200);
    expect(enrolled.body).toEqual({ ok: true, aal: 'aal2', backup_codes: TEN_CODES.map(formatBackupCode) });
    expect((enrolled.body.backup_codes as string[])).toHaveLength(BACKUP_CODE_COUNT);
    expect(auditCalls().map((c) => c.action)).toEqual(['admin.mfa.enroll']);
  });

  it("POST /verify: unverified の verify の成功は issueBackupCodes → 監査 admin.mfa.enroll (details { factor_id, backup_codes_issued: 10, failed_step: null }) の順で、監査は 1 回。challengeAndVerify の不一致・429・それ以外の error では issueBackupCodes も監査も呼ばない", async () => {
    signIn({ factors: [factor(UNVERIFIED_FACTOR_ID, 'unverified')] });
    const failures = [
      { code: 'mfa_verification_failed', status: 400, message: 'x' },
      { code: 'over_request_rate_limit', status: 429, message: 'x' },
      { code: 'unexpected_failure', status: 500, message: RAW_DB_TEXT },
    ];
    const expectedStatus = [400, 429, 500];
    for (const [i, error] of failures.entries()) {
      mocks.userClient.auth.mfa.challengeAndVerify.mockResolvedValueOnce({ data: null, error });
      const result = await verify({ factor_id: UNVERIFIED_FACTOR_ID, code: '123456' });
      expect(result.status, error.code).toBe(expectedStatus[i]);
      expect(JSON.stringify(result.body)).not.toContain('violates');
    }
    expect(mocks.issueBackupCodes).not.toHaveBeenCalled();
    expect(mocks.recordMfaAudit).not.toHaveBeenCalled();

    mocks.order.length = 0;
    const ok = await verify({ factor_id: UNVERIFIED_FACTOR_ID, code: '123456' });
    expect(ok.status).toBe(200);
    expect(mocks.order).toEqual(['challengeAndVerify', 'issueBackupCodes', 'audit']);
    expect(mocks.issueBackupCodes).toHaveBeenCalledWith(mocks.adminClient, userId);
    expect(mocks.recordMfaAudit).toHaveBeenCalledTimes(1);
    const [input] = mocks.recordMfaAudit.mock.calls[0] as [Record<string, unknown>];
    expect(input).toMatchObject({
      admin: mocks.adminClient,
      actorId: userId,
      targetUserId: userId,
      action: 'admin.mfa.enroll',
      details: { factor_id: UNVERIFIED_FACTOR_ID, backup_codes_issued: 10, failed_step: null },
      routeName: 'POST /api/auth/mfa/verify',
    });
    expect((input.request as Request).headers.get('user-agent')).toBe('vitest');
  });

  it("POST /verify: unverified の verify で issueBackupCodes が投げても 200 { ok: true, aal: 'aal2' } (backup_codes が無い) で、監査 admin.mfa.enroll を details { factor_id, backup_codes_issued: null, failed_step: 'issue_backup_codes' } で 1 回書き、失敗を app_logs に残す (本文に例外の文が無い)", async () => {
    signIn({ factors: [factor(UNVERIFIED_FACTOR_ID, 'unverified')] });
    mocks.issueBackupCodes.mockRejectedValueOnce(new Error(RAW_DB_TEXT));
    const result = await verify({ factor_id: UNVERIFIED_FACTOR_ID, code: '123456' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, aal: 'aal2' });
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]).toMatchObject({
      action: 'admin.mfa.enroll',
      details: { factor_id: UNVERIFIED_FACTOR_ID, backup_codes_issued: null, failed_step: 'issue_backup_codes' },
    });
    expect(mocks.logger.error).toHaveBeenCalledWith('バックアップコードの発行に失敗しました', expect.any(Error));
    expect(JSON.stringify(result.body)).not.toContain('violates');
  });
});

describe('POST /api/auth/mfa/recover', () => {
  it('POST /recover: 形の違うコードは DB に触れず 400 / 無いコード → 400 / verified な factor が無い → 409 / 消費できたら全 factor を admin で消し、残りの行を消し、監査 warn (details { factors_deleted: 消した数, backup_codes_deleted: 消した行の数, failed_step: null })、next を返す / 4 回目 → 429', async () => {
    signIn({ factors: [factor(VERIFIED_FACTOR_ID, 'verified')] });
    for (const bad of ['ABCDE-FGHJ', 'ABCDE-FGHJ0', 'IIIII-OOOOO']) {
      const result = await recover({ code: bad });
      expect(result.status, bad).toBe(400);
      expect(result.body.code).toBe('AUTH_2FA_INVALID');
    }
    expect(mocks.consumeBackupCode).not.toHaveBeenCalled();
    expect(mocks.adminClient.auth.admin.mfa.listFactors).not.toHaveBeenCalled();
    // 3 回で分の上限 (3 回/分) に達したので、4 回目は 429
    const limited = await recover();
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(userId, 'auth-mfa-recover');

    const nextUser = () => {
      userSeq += 1;
      userId = `11111111-1111-4111-8111-${String(userSeq).padStart(12, '0')}`;
    };

    nextUser();
    signIn({ factors: [factor(VERIFIED_FACTOR_ID, 'verified')] });
    mocks.consumeBackupCode.mockResolvedValueOnce(false);
    const unknown = await recover();
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('AUTH_2FA_INVALID');
    expect(mocks.adminClient.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
    expect(mocks.recordMfaAudit).not.toHaveBeenCalled();

    nextUser();
    signIn({ factors: [factor(UNVERIFIED_FACTOR_ID, 'unverified')] });
    const notEnrolled = await recover();
    expect(notEnrolled.status).toBe(409);
    expect(notEnrolled.body.code).toBe('AUTH_2FA_NOT_ENROLLED');

    nextUser();
    signIn({ factors: [factor(VERIFIED_FACTOR_ID, 'verified')] });
    mocks.order.length = 0;
    vi.mocked(mocks.consumeBackupCode).mockClear();
    const ok = await recover({ code: 'abcde-fghjk' });
    expect(ok.status).toBe(200);
    expect(MfaRecoverResponseSchema.parse(ok.body)).toEqual({ ok: true, next: MFA_RECOVER_NEXT_PATH });
    expect(ok.body.next).toBe('/login?next=%2Fsettings%2Fsecurity%2Fmfa%2Fsetup');
    expect(mocks.consumeBackupCode).toHaveBeenCalledWith(mocks.adminClient, userId, 'ABCDEFGHJK');
    expect(mocks.order).toEqual([
      'listFactors',
      'consumeBackupCode',
      `deleteFactor:${VERIFIED_FACTOR_ID}`,
      `deleteFactor:${UNVERIFIED_FACTOR_ID}`,
      'deleteBackupCodes',
      'audit',
    ]);
    expect(mocks.adminClient.auth.admin.mfa.listFactors).toHaveBeenCalledWith({ userId });
    expect(mocks.adminClient.auth.admin.mfa.deleteFactor).toHaveBeenCalledWith({ id: VERIFIED_FACTOR_ID, userId });
    expect(auditCalls()).toEqual([
      expect.objectContaining({
        action: 'admin.mfa.recover',
        actorId: userId,
        targetUserId: userId,
        details: { factors_deleted: 2, backup_codes_deleted: 9, failed_step: null },
      }),
    ]);
    // 監査の details にコードの値もハッシュも入れない
    expect(JSON.stringify(mocks.recordMfaAudit.mock.calls[0][0].details)).not.toContain('ABCDE');
    expect(JSON.stringify(mocks.recordMfaAudit.mock.calls[0][0].details)).not.toContain(hashBackupCode(userId, 'ABCDEFGHJK'));
  });

  it('POST /recover: listFactors は consumeBackupCode より先に呼び、listFactors の error と consumeBackupCode の例外は 500 で、consumeBackupCode (listFactors の error のとき)・deleteFactor・deleteBackupCodes・監査を呼ばない', async () => {
    signIn({ factors: [factor(VERIFIED_FACTOR_ID, 'verified')] });
    mocks.adminClient.auth.admin.mfa.listFactors.mockResolvedValueOnce({ data: null, error: { message: RAW_DB_TEXT, status: 500 } });
    const listFailed = await recover();
    expect(listFailed.status).toBe(500);
    expect(listFailed.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(listFailed.body)).not.toContain('violates');
    expect(mocks.consumeBackupCode).not.toHaveBeenCalled();

    mocks.consumeBackupCode.mockRejectedValueOnce(new Error(RAW_DB_TEXT));
    const consumeFailed = await recover();
    expect(consumeFailed.status).toBe(500);
    expect(JSON.stringify(consumeFailed.body)).not.toContain('violates');
    expect(mocks.adminClient.auth.admin.mfa.deleteFactor).not.toHaveBeenCalled();
    expect(mocks.deleteBackupCodes).not.toHaveBeenCalled();
    expect(mocks.recordMfaAudit).not.toHaveBeenCalled();
  });

  it("POST /recover: 消費の後に deleteFactor が error なら残りの deleteFactor と deleteBackupCodes を呼ばず、監査を details { factors_deleted: それまでに消せた数, backup_codes_deleted: null, failed_step: 'delete_factor' } で 1 回書いて 500。deleteBackupCodes が投げたら監査を { factors_deleted: 消した数, backup_codes_deleted: null, failed_step: 'delete_backup_codes' } で書いて 500", async () => {
    signIn({ factors: [factor(VERIFIED_FACTOR_ID, 'verified')] });
    mocks.adminClient.auth.admin.mfa.listFactors.mockResolvedValueOnce({
      data: { factors: [factor('f-1', 'verified'), factor('f-2', 'verified'), factor('f-3', 'unverified')] },
      error: null,
    });
    mocks.adminClient.auth.admin.mfa.deleteFactor
      .mockResolvedValueOnce({ data: { id: 'f-1' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: RAW_DB_TEXT, status: 500 } });
    const factorFailed = await recover();
    expect(factorFailed.status).toBe(500);
    expect(JSON.stringify(factorFailed.body)).not.toContain('violates');
    expect(mocks.adminClient.auth.admin.mfa.deleteFactor).toHaveBeenCalledTimes(2);
    expect(mocks.deleteBackupCodes).not.toHaveBeenCalled();
    expect(auditCalls()).toEqual([
      expect.objectContaining({
        action: 'admin.mfa.recover',
        details: { factors_deleted: 1, backup_codes_deleted: null, failed_step: 'delete_factor' },
      }),
    ]);

    mocks.recordMfaAudit.mockClear();
    mocks.deleteBackupCodes.mockRejectedValueOnce(new Error(RAW_DB_TEXT));
    const codesFailed = await recover();
    expect(codesFailed.status).toBe(500);
    expect(auditCalls()).toEqual([
      expect.objectContaining({
        details: { factors_deleted: 2, backup_codes_deleted: null, failed_step: 'delete_backup_codes' },
      }),
    ]);

    // 監査の記録の失敗 (fail-open) は応答を変えない
    mocks.recordMfaAudit.mockResolvedValueOnce({ ok: false, error: 'insert failed' });
    const auditFailed = await recover();
    expect(auditFailed.status).toBe(200);
  });
});

describe('route の共通', () => {
  it('POST /enroll・/recover: アプリの WebView の借り物のセッション (getSession の refresh_token が NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER) でも 409 AUTH_2FA_NATIVE_SESSION にせず、借り物でないときと同じ応答 (enroll は unverified を消して 200・recover は消費できたら全 factor を admin で消す。§10 の借り物の enroll / recover の行)', async () => {
    signIn({ factors: [factor('old-1', 'unverified')], bridged: true });
    const enrolled = await enroll();
    expect(enrolled.status).toBe(200);
    expect(mocks.order).toEqual(['unenroll:old-1', 'enroll']);

    signIn({ factors: [factor(VERIFIED_FACTOR_ID, 'verified')], bridged: true });
    const recovered = await recover();
    expect(recovered.status).toBe(200);
    expect(recovered.body.next).toBe(MFA_RECOVER_NEXT_PATH);
    expect(mocks.adminClient.auth.admin.mfa.deleteFactor).toHaveBeenCalledTimes(2);
  });

  it('POST は別オリジンを 403 FORBIDDEN_ORIGIN', async () => {
    signIn({ factors: [factor(VERIFIED_FACTOR_ID, 'verified')] });
    const evil = { origin: 'https://evil.example' };
    for (const result of [await enroll(evil), await verify(undefined, evil), await recover(undefined, evil)]) {
      expect(result.status).toBe(403);
      expect(result.body.code).toBe('FORBIDDEN_ORIGIN');
      expect(result.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(vi.mocked(requireRole)).not.toHaveBeenCalled();
    expect(mocks.userClient.auth.mfa.enroll).not.toHaveBeenCalled();
    expect(mocks.userClient.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(mocks.consumeBackupCode).not.toHaveBeenCalled();
  });

  it('500 の本文に Supabase / DB の生のエラー文が無い (internalError 経由)', async () => {
    signIn({ factors: [factor(VERIFIED_FACTOR_ID, 'verified')] });
    mocks.userClient.auth.mfa.challengeAndVerify.mockResolvedValueOnce({
      data: null,
      error: { code: 'unexpected_failure', status: 500, message: RAW_DB_TEXT },
    });
    mocks.countRemainingBackupCodes.mockRejectedValueOnce(new Error(RAW_DB_TEXT));
    mocks.adminClient.auth.admin.mfa.listFactors.mockResolvedValueOnce({ data: null, error: { message: RAW_DB_TEXT, status: 500 } });
    const results = [await verify(), await status(), await recover()];
    for (const result of results) {
      expect(result.status).toBe(500);
      expect(result.body).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
      expect(result.headers.get('Cache-Control')).toBe('private, no-store');
    }
  });
});
