/**
 * #1198 パスワードの変更・再設定の API (段 C の 2 route) の route テスト。
 * 設計 docs/design/cross/16-auth-history-sessions.md §14.6・§14.7・§19・§20.2
 *
 * requireSessionUser・performPasswordChange・updatePasswordWithAccessToken は本物を通し、
 * Supabase の client (本人 = createClient()・service_role = getSupabaseAdmin() の RPC)、GoTrue (global fetch)、回数制限を偽物にする。
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const COOKIE_TOKEN = 'cookie.access.token';
const BEARER_TOKEN = 'bearer.access.token';
const CURRENT_PASSWORD = 'CurrentPass2026x';
const NEW_PASSWORD = 'NewPass2026x';
const SUPABASE_URL = 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = 'test-anon-key';

const mocks = vi.hoisted(() => {
  const state = {
    authUser: null as null | { id: string },
    cookieSession: null as null | { access_token: string },
    /** getClaims に渡された token ごとの claims */
    claimsByToken: {} as Record<string, Record<string, unknown>>,
    profile: null as null | Record<string, unknown>,
    /** auth_password_check の戻り (data) と error */
    rpcData: 'ok' as unknown,
    rpcError: null as null | { code: string; message: string },
    rateLimitSuccess: true,
  };
  return {
    state,
    userSignOut: vi.fn(),
    userUpdateUser: vi.fn(),
    userFrom: vi.fn(),
    adminRpc: vi.fn(),
    adminSignOut: vi.fn(),
    createClient: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    checkRateLimit: vi.fn(),
    fetch: vi.fn(),
    loggerError: vi.fn(),
  };
});

type QueryResult = { data: unknown; error: unknown };
function profileChain(result: () => QueryResult) {
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'eq']) builder[name] = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => result());
  return builder;
}

function makeUserClient() {
  const { state } = mocks;
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: state.authUser },
        error: state.authUser ? null : { message: 'Auth session missing!', status: 401 },
      })),
      getSession: vi.fn(async () => ({ data: { session: state.cookieSession } })),
      getClaims: vi.fn(async (jwt?: string) => {
        const claims = jwt ? state.claimsByToken[jwt] : undefined;
        return claims ? { data: { claims }, error: null } : { data: null, error: { message: 'invalid jwt' } };
      }),
      signOut: mocks.userSignOut,
      updateUser: mocks.userUpdateUser,
    },
    from: (table: string) => {
      mocks.userFrom(table);
      if (table !== 'user_profiles') throw new Error(`unexpected table ${table}`);
      return profileChain(() => ({ data: state.profile, error: null }));
    },
  };
}

function makeAdminClient() {
  return {
    auth: { admin: { signOut: mocks.adminSignOut } },
    rpc: (name: string, args: unknown) => mocks.adminRpc(name, args),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));
vi.mock('@/lib/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rate-limit')>('@/lib/rate-limit');
  return { ...actual, checkRateLimit: mocks.checkRateLimit };
});
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.loggerError };
    return { ...logger, withUser: () => logger };
  },
  generateRequestId: () => 'req_test',
}));

const { POST: changePassword } = await import('@/app/api/auth/password/change/route');
const { POST: resetPassword } = await import('@/app/api/auth/password/reset/route');

const BASE_URL = 'http://localhost';
function request(path: string, init: { body?: unknown; bearer?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return new NextRequest(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? {}),
  });
}
const changeRequest = (overrides: Record<string, unknown> = {}, bearer?: string) =>
  request('/api/auth/password/change', {
    body: { current_password: CURRENT_PASSWORD, new_password: NEW_PASSWORD, ...overrides },
    bearer,
  });
const resetRequest = (overrides: Record<string, unknown> = {}, bearer?: string) =>
  request('/api/auth/password/reset', { body: { new_password: NEW_PASSWORD, ...overrides }, bearer });

const nowSeconds = () => Math.floor(Date.now() / 1000);
const recoveryClaims = (method: string, ageMinutes = 1) => ({
  sub: USER_ID,
  session_id: SESSION_ID,
  amr: [{ method, timestamp: nowSeconds() - ageMinutes * 60 }],
});

function gotrueOk() {
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function gotrueError(status: number, code: string) {
  return new Response(JSON.stringify({ code, message: `GoTrue raw english message ${code}` }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
/** GoTrue に送った要求 (PUT /auth/v1/user) の 1 回目 */
function gotrueCall() {
  const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
  return {
    url,
    init,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  };
}
/** RPC auth_password_check に渡した引数 (1 回目) */
const rpcArgs = () => mocks.adminRpc.mock.calls[0][1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', SUPABASE_ANON_KEY);
  const { state } = mocks;
  state.authUser = { id: USER_ID };
  state.cookieSession = { access_token: COOKIE_TOKEN };
  state.claimsByToken = {
    [COOKIE_TOKEN]: { sub: USER_ID, session_id: SESSION_ID, amr: [{ method: 'password', timestamp: nowSeconds() }] },
    [BEARER_TOKEN]: { sub: USER_ID, session_id: SESSION_ID, amr: [{ method: 'password', timestamp: nowSeconds() }] },
  };
  state.profile = { roles: ['user'], frozen_at: null, unban_at: null };
  state.rpcData = 'ok';
  state.rpcError = null;
  state.rateLimitSuccess = true;
  mocks.createClient.mockImplementation(async () => makeUserClient());
  mocks.getSupabaseAdmin.mockImplementation(() => makeAdminClient());
  mocks.adminRpc.mockImplementation(async () => ({ data: state.rpcData, error: state.rpcError }));
  mocks.checkRateLimit.mockImplementation(async () =>
    state.rateLimitSuccess
      ? { success: true, limit: 5, remaining: 4, reset: Date.now() + 600_000, windowSec: 600 }
      : { success: false, limit: 5, remaining: 0, reset: Date.now() + 120_000, windowSec: 600 },
  );
  mocks.fetch.mockImplementation(async () => gotrueOk());
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function bodyOf(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe('POST /api/auth/password/change (§14.6)', () => {
  it('change: 入力の検証で弾くときは RPC も GoTrue も回数制限も呼ばない', async () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ current_password: '' }, 400, 'VALIDATION_ERROR'],
      [{ new_password: undefined }, 400, 'VALIDATION_ERROR'],
      [{ new_password: 'x'.repeat(1025) }, 400, 'VALIDATION_ERROR'],
      [{ new_password: 12345678 }, 400, 'VALIDATION_ERROR'],
      [{ new_password: 'short1' }, 422, 'VALID_PASSWORD_WEAK'],
      [{ new_password: 'abcdefghij' }, 422, 'VALID_PASSWORD_WEAK'],
      [{ new_password: CURRENT_PASSWORD }, 422, 'VALID_PASSWORD_HISTORY'],
    ];
    for (const [overrides, status, code] of cases) {
      const res = await changePassword(changeRequest(overrides));
      expect(res.status, JSON.stringify(overrides)).toBe(status);
      expect(await bodyOf(res)).toEqual(expect.objectContaining({ code }));
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    }
    const broken = await changePassword(request('/api/auth/password/change', { body: '{not json' }));
    expect(broken.status).toBe(400);
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.userUpdateUser).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('change: 新しいパスワードが現在のパスワードと同じなら 422 VALID_PASSWORD_HISTORY (現在のパスワードと違うものに)', async () => {
    const res = await changePassword(changeRequest({ new_password: CURRENT_PASSWORD }));
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toEqual({
      error: '新しいパスワードは、現在のパスワードと違うものにしてください。',
      code: 'VALID_PASSWORD_HISTORY',
    });
  });

  it('change: 本文に NULL 文字があれば 400 INVALID_CHARACTER (認証に触れる前)', async () => {
    const res = await changePassword(changeRequest({ new_password: `NewPass2026x\u0000` }));
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual(expect.objectContaining({ code: 'INVALID_CHARACTER' }));
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('change: 成功 → 200 { ok: true } で signOut を呼ばない (他の端末の失効は GoTrue が行う)', async () => {
    const res = await changePassword(changeRequest());
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ ok: true });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.userSignOut).not.toHaveBeenCalled();
    expect(mocks.adminSignOut).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(USER_ID, 'auth-password-change');
  });

  it('change: RPC に本人・現在のパスワード・新しいパスワード・世代数を渡し、service_role で呼ぶ', async () => {
    await changePassword(changeRequest());
    expect(mocks.adminRpc).toHaveBeenCalledTimes(1);
    expect(mocks.adminRpc.mock.calls[0][0]).toBe('auth_password_check');
    expect(rpcArgs()).toEqual({
      p_user_id: USER_ID,
      p_current_password: CURRENT_PASSWORD,
      p_new_password: NEW_PASSWORD,
      p_generations: 3,
    });
    expect(mocks.getSupabaseAdmin).toHaveBeenCalled();
  });

  it('change: current_mismatch → 400 AUTH_CURRENT_PASSWORD_MISMATCH で GoTrue を呼ばない', async () => {
    mocks.state.rpcData = 'current_mismatch';
    const res = await changePassword(changeRequest());
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: '現在のパスワードが正しくありません。', code: 'AUTH_CURRENT_PASSWORD_MISMATCH' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('change: reused → 422 VALID_PASSWORD_HISTORY で GoTrue を呼ばない', async () => {
    mocks.state.rpcData = 'reused';
    const res = await changePassword(changeRequest());
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toEqual({
      error: '最近使ったパスワードは使えません。別のパスワードにしてください。',
      code: 'VALID_PASSWORD_HISTORY',
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('change: no_password → 409 AUTH_PASSWORD_NOT_SET、unsupported_hash → 409 AUTH_PASSWORD_NOT_SET (文言は「この方法では変更できません」)', async () => {
    mocks.state.rpcData = 'no_password';
    const noPassword = await changePassword(changeRequest());
    expect(noPassword.status).toBe(409);
    expect(await bodyOf(noPassword)).toEqual({
      error: 'このアカウントはパスワードでログインしていないため、変更できません。',
      code: 'AUTH_PASSWORD_NOT_SET',
    });

    mocks.state.rpcData = 'unsupported_hash';
    const unsupported = await changePassword(changeRequest());
    expect(unsupported.status).toBe(409);
    expect(await bodyOf(unsupported)).toEqual({
      error: 'この方法では変更できません。お問い合わせください。',
      code: 'AUTH_PASSWORD_NOT_SET',
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('change: rate-limit 超過 → 429 RATE_LIMITED + Retry-After で、RPC も GoTrue も呼ばない', async () => {
    mocks.state.rateLimitSuccess = false;
    const res = await changePassword(changeRequest());
    expect(res.status).toBe(429);
    expect(await bodyOf(res)).toEqual(expect.objectContaining({ code: 'RATE_LIMITED' }));
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('change: roles から世代数を決めて RPC に渡す (super_admin は 10・org_ のロールは 5)', async () => {
    mocks.state.profile = { roles: ['user', 'super_admin'], frozen_at: null, unban_at: null };
    await changePassword(changeRequest());
    expect(rpcArgs().p_generations).toBe(10);

    mocks.adminRpc.mockClear();
    mocks.state.profile = { roles: ['org_admin'], frozen_at: null, unban_at: null };
    await changePassword(changeRequest());
    expect(rpcArgs().p_generations).toBe(5);
  });

  it('change: 世代数は requireSessionUser の roles から決め、route は user_profiles を 1 回しか読まない', async () => {
    await changePassword(changeRequest());
    expect(mocks.userFrom.mock.calls.filter(([table]) => table === 'user_profiles')).toHaveLength(1);
  });

  it('change: user_profiles の行が無い利用者でも通り、RPC の p_generations は 3 (S-30)', async () => {
    mocks.state.profile = null;
    const res = await changePassword(changeRequest());
    expect(res.status).toBe(200);
    expect(rpcArgs().p_generations).toBe(3);
  });

  it('change: 凍結中は 403 AUTH_ACCOUNT_FROZEN、claims が読めなければ 401', async () => {
    mocks.state.profile = { roles: ['user'], frozen_at: '2026-10-01T00:00:00+00:00', unban_at: null };
    const frozen = await changePassword(changeRequest());
    expect(frozen.status).toBe(403);
    expect(await bodyOf(frozen)).toEqual(expect.objectContaining({ code: 'AUTH_ACCOUNT_FROZEN' }));

    mocks.state.profile = { roles: ['user'], frozen_at: null, unban_at: null };
    mocks.state.claimsByToken = {};
    const unauthenticated = await changePassword(changeRequest());
    expect(unauthenticated.status).toBe(401);
    expect(await bodyOf(unauthenticated)).toEqual(expect.objectContaining({ code: 'AUTH_UNAUTHENTICATED' }));
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('change: Bearer だけの要求 (Cookie 無し) でも createClient() の auth.updateUser を呼ばず、updatePasswordWithAccessToken に Bearer の JWT と本文の current_password を渡す', async () => {
    mocks.state.cookieSession = null;
    const res = await changePassword(changeRequest({}, BEARER_TOKEN));
    expect(res.status).toBe(200);
    expect(mocks.userUpdateUser).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const call = gotrueCall();
    expect(call.url).toBe(`${SUPABASE_URL}/auth/v1/user`);
    expect(call.init.method).toBe('PUT');
    expect(call.headers.Authorization).toBe(`Bearer ${BEARER_TOKEN}`);
    expect(call.headers.apikey).toBe(SUPABASE_ANON_KEY);
    expect(call.body).toEqual({ password: NEW_PASSWORD, current_password: CURRENT_PASSWORD });
  });

  it('change: Cookie の要求では Cookie のセッションの access token を渡す', async () => {
    await changePassword(changeRequest());
    expect(gotrueCall().headers.Authorization).toBe(`Bearer ${COOKIE_TOKEN}`);
    expect(mocks.userUpdateUser).not.toHaveBeenCalled();
  });

  it('change: updatePasswordWithAccessToken の weak_password → 422 VALID_PASSWORD_WEAK (GoTrue の英文を出さない)', async () => {
    mocks.fetch.mockImplementation(async () => gotrueError(422, 'weak_password'));
    const res = await changePassword(changeRequest());
    expect(res.status).toBe(422);
    const body = await bodyOf(res);
    expect(body).toEqual({
      error: 'このパスワードは安全性の基準を満たしていません。別のパスワードにしてください。',
      code: 'VALID_PASSWORD_WEAK',
    });
    expect(JSON.stringify(body)).not.toContain('GoTrue raw english');
  });

  it('change: GoTrue の same_password → 422 VALID_PASSWORD_HISTORY、reauthentication_needed → 403 AUTH_REAUTHENTICATION_REQUIRED', async () => {
    mocks.fetch.mockImplementationOnce(async () => gotrueError(422, 'same_password'));
    const same = await changePassword(changeRequest());
    expect(same.status).toBe(422);
    expect(await bodyOf(same)).toEqual(expect.objectContaining({ code: 'VALID_PASSWORD_HISTORY' }));

    mocks.fetch.mockImplementationOnce(async () => gotrueError(400, 'reauthentication_needed'));
    const reauth = await changePassword(changeRequest());
    expect(reauth.status).toBe(403);
    expect(await bodyOf(reauth)).toEqual({
      error: '安全のため、もう一度ログインしてから変更してください。',
      code: 'AUTH_REAUTHENTICATION_REQUIRED',
    });
  });

  it('change: updatePasswordWithAccessToken が current_password_invalid を返したら 400 AUTH_CURRENT_PASSWORD_MISMATCH', async () => {
    mocks.fetch.mockImplementation(async () => gotrueError(400, 'current_password_invalid'));
    const res = await changePassword(changeRequest());
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual(expect.objectContaining({ code: 'AUTH_CURRENT_PASSWORD_MISMATCH' }));
  });

  it('change: GoTrue の想定外の失敗 (500)・通信の失敗は 500 INTERNAL_ERROR で、stage を残し本文に英文を出さない', async () => {
    mocks.fetch.mockImplementationOnce(async () => gotrueError(500, 'unexpected_failure'));
    const upstream = await changePassword(changeRequest());
    expect(upstream.status).toBe(500);
    const upstreamBody = await bodyOf(upstream);
    expect(upstreamBody.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(upstreamBody)).not.toContain('GoTrue raw english');
    expect(upstream.headers.get('Cache-Control')).toBe('private, no-store');

    mocks.fetch.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed');
    });
    const network = await changePassword(changeRequest());
    expect(network.status).toBe(500);
    expect(mocks.loggerError).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ stage: 'password-update' }));
  });

  it('change: RPC の例外 (error・知らない戻り値) は 500 で、stage = password-check。GoTrue を呼ばない', async () => {
    mocks.state.rpcError = { code: '42501', message: 'permission denied for function auth_password_check' };
    const failed = await changePassword(changeRequest());
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await bodyOf(failed))).not.toContain('permission denied');
    expect(mocks.loggerError).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ stage: 'password-check' }));

    mocks.state.rpcError = null;
    mocks.state.rpcData = 'something_new';
    const unknown = await changePassword(changeRequest());
    expect(unknown.status).toBe(500);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('change: 本文にもログにもパスワードも生のエラー文も出ない', async () => {
    mocks.state.rpcError = { code: 'XX000', message: `boom ${CURRENT_PASSWORD} ${NEW_PASSWORD}` };
    const res = await changePassword(changeRequest());
    const text = JSON.stringify(await bodyOf(res));
    expect(text).not.toContain(CURRENT_PASSWORD);
    expect(text).not.toContain(NEW_PASSWORD);
    const logged = JSON.stringify(mocks.loggerError.mock.calls, (_key, value) =>
      value instanceof Error ? { name: value.name, message: value.message } : value,
    );
    expect(logged).not.toContain(CURRENT_PASSWORD);
    expect(logged).not.toContain(NEW_PASSWORD);
  });
});

describe('POST /api/auth/password/reset (§14.7)', () => {
  beforeEach(() => {
    mocks.state.claimsByToken[COOKIE_TOKEN] = recoveryClaims('recovery');
    mocks.state.claimsByToken[BEARER_TOKEN] = recoveryClaims('otp');
  });

  it('reset: 入力の検証で弾くときは RPC も GoTrue も呼ばない (400 / 422)', async () => {
    const bad = await resetPassword(resetRequest({ new_password: '' }));
    expect(bad.status).toBe(400);
    const weak = await resetPassword(resetRequest({ new_password: 'short1' }));
    expect(weak.status).toBe(422);
    expect(await bodyOf(weak)).toEqual(expect.objectContaining({ code: 'VALID_PASSWORD_WEAK' }));
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it('reset: amr に recovery も otp も無い (password) → 403 AUTH_RECOVERY_SESSION_REQUIRED で RPC も GoTrue も呼ばない', async () => {
    mocks.state.claimsByToken[COOKIE_TOKEN] = { sub: USER_ID, session_id: SESSION_ID, amr: [{ method: 'password', timestamp: nowSeconds() }] };
    const res = await resetPassword(resetRequest());
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toEqual({
      error: 'パスワードの再設定は、再設定メールのリンクから開き直してください。',
      code: 'AUTH_RECOVERY_SESSION_REQUIRED',
    });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it('reset: oauth だけ・amr が無い (claims に amr 無し) でも 403', async () => {
    mocks.state.claimsByToken[COOKIE_TOKEN] = { sub: USER_ID, session_id: SESSION_ID, amr: [{ method: 'oauth', timestamp: nowSeconds() }] };
    expect((await resetPassword(resetRequest())).status).toBe(403);
    mocks.state.claimsByToken[COOKIE_TOKEN] = { sub: USER_ID, session_id: SESSION_ID };
    expect((await resetPassword(resetRequest())).status).toBe(403);
  });

  it('reset: 60 分より古い recovery → 403', async () => {
    mocks.state.claimsByToken[COOKIE_TOKEN] = recoveryClaims('recovery', 61);
    const res = await resetPassword(resetRequest());
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toEqual(expect.objectContaining({ code: 'AUTH_RECOVERY_SESSION_REQUIRED' }));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('reset: amr の recovery (PKCE) → 200', async () => {
    const res = await resetPassword(resetRequest());
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ ok: true });
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(USER_ID, 'auth-password-reset');
    expect(mocks.userSignOut).not.toHaveBeenCalled();
  });

  it('reset: amr の otp (token_hash / implicit) → 200', async () => {
    mocks.state.cookieSession = null;
    const res = await resetPassword(resetRequest({}, BEARER_TOKEN));
    expect(res.status).toBe(200);
  });

  it('reset: RPC に p_current_password = null を渡す', async () => {
    await resetPassword(resetRequest());
    expect(rpcArgs()).toEqual({ p_user_id: USER_ID, p_current_password: null, p_new_password: NEW_PASSWORD, p_generations: 3 });
  });

  it('reset: 直近の世代と同じパスワード (RPC が reused) → 422 VALID_PASSWORD_HISTORY で、GoTrue を呼ばない (S-14)', async () => {
    mocks.state.rpcData = 'reused';
    const res = await resetPassword(resetRequest());
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toEqual(expect.objectContaining({ code: 'VALID_PASSWORD_HISTORY' }));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('reset: Bearer だけの要求でも Bearer の JWT で更新し、GoTrue への本文は password だけ (current_password を入れない)', async () => {
    mocks.state.cookieSession = null;
    const res = await resetPassword(resetRequest({}, BEARER_TOKEN));
    expect(res.status).toBe(200);
    expect(mocks.userUpdateUser).not.toHaveBeenCalled();
    const call = gotrueCall();
    expect(call.headers.Authorization).toBe(`Bearer ${BEARER_TOKEN}`);
    expect(call.body).toEqual({ password: NEW_PASSWORD });
  });

  it('reset: user_profiles の行が無い利用者でも 200 で、RPC の p_generations は 3 (S-30)', async () => {
    mocks.state.profile = null;
    const res = await resetPassword(resetRequest());
    expect(res.status).toBe(200);
    expect(rpcArgs().p_generations).toBe(3);
  });

  it('reset: roles から世代数を決める (運営のロールは 10)', async () => {
    mocks.state.profile = { roles: ['support'], frozen_at: null, unban_at: null };
    await resetPassword(resetRequest());
    expect(rpcArgs().p_generations).toBe(10);
  });

  it('reset: weak_password → 422 VALID_PASSWORD_WEAK、reauthentication_needed → 403 AUTH_REAUTHENTICATION_REQUIRED', async () => {
    mocks.fetch.mockImplementationOnce(async () => gotrueError(422, 'weak_password'));
    expect((await resetPassword(resetRequest())).status).toBe(422);
    mocks.fetch.mockImplementationOnce(async () => gotrueError(400, 'reauthentication_needed'));
    const reauth = await resetPassword(resetRequest());
    expect(reauth.status).toBe(403);
    expect(await bodyOf(reauth)).toEqual(expect.objectContaining({ code: 'AUTH_REAUTHENTICATION_REQUIRED' }));
  });

  it('reset: rate-limit 超過 → 429', async () => {
    mocks.state.rateLimitSuccess = false;
    const res = await resetPassword(resetRequest());
    expect(res.status).toBe(429);
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });

  it('reset: RPC が current_mismatch・no_password・unsupported_hash を返したら 500 (再設定では起き得ない §14.7)', async () => {
    for (const outcome of ['current_mismatch', 'no_password', 'unsupported_hash']) {
      mocks.state.rpcData = outcome;
      const res = await resetPassword(resetRequest());
      expect(res.status, outcome).toBe(500);
      expect((await bodyOf(res)).code).toBe('INTERNAL_ERROR');
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('reset: 凍結中は 403 AUTH_ACCOUNT_FROZEN、認証が無ければ 401', async () => {
    mocks.state.profile = { roles: ['user'], frozen_at: '2026-10-01T00:00:00+00:00', unban_at: null };
    const frozen = await resetPassword(resetRequest());
    expect(frozen.status).toBe(403);
    expect(await bodyOf(frozen)).toEqual(expect.objectContaining({ code: 'AUTH_ACCOUNT_FROZEN' }));

    mocks.state.profile = { roles: ['user'], frozen_at: null, unban_at: null };
    mocks.state.authUser = null;
    expect((await resetPassword(resetRequest())).status).toBe(401);
  });

  it('本文にもログにもパスワードも生のエラー文も出ない', async () => {
    mocks.fetch.mockImplementation(async () => gotrueError(500, 'unexpected_failure'));
    const res = await resetPassword(resetRequest());
    const text = JSON.stringify(await bodyOf(res));
    expect(text).not.toContain(NEW_PASSWORD);
    expect(text).not.toContain('GoTrue raw english');
    const logged = JSON.stringify(mocks.loggerError.mock.calls, (_key, value) =>
      value instanceof Error ? { name: value.name, message: value.message } : value,
    );
    expect(logged).not.toContain(NEW_PASSWORD);
  });
});
