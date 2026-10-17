/**
 * #1189・#1190 ログイン中の端末・最近のログインの API (段 B の 5 route) の route テスト。
 * 設計 docs/design/cross/16-auth-history-sessions.md §14.1〜14.5・§19・§20.2
 *
 * requireSessionUser・store.ts は本物を通し、Supabase の client (本人・service_role) を偽物にする
 * (本人の client = createClient()、service_role = getSupabaseAdmin())。
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CURRENT_SESSION_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION_ID = '44444444-4444-4444-8444-444444444444';
const COOKIE_TOKEN = 'cookie.access.token';
const BEARER_TOKEN = 'bearer.access.token';

type QueryResult = { data: unknown; error: unknown };

const mocks = vi.hoisted(() => {
  const state = {
    authUser: null as null | { id: string },
    cookieSession: null as null | { access_token: string },
    /** getClaims に渡された token ごとの claims */
    claimsByToken: {} as Record<string, Record<string, unknown>>,
    profile: null as null | Record<string, unknown>,
    profileError: null as null | { message: string },
    sessionRows: [] as Record<string, unknown>[],
    historyRows: [] as Record<string, unknown>[],
    revokeOutcome: 'revoked' as unknown,
    adminSignOutError: null as null | { message: string; status: number },
    deviceNameUpdated: true,
  };
  return {
    state,
    userRpc: vi.fn(),
    userFrom: vi.fn(),
    userSignOut: vi.fn(),
    adminFrom: vi.fn(),
    adminRpc: vi.fn(),
    adminSignOut: vi.fn(),
    adminUpdate: vi.fn(),
    createClient: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    loggerError: vi.fn(),
  };
});

/** select / eq / is / order / limit / update / neq / lt を何度つないでも同じものを返し、await と maybeSingle で result を返す */
function chain(result: () => QueryResult, onUpdate?: (values: unknown) => void) {
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'is', 'order', 'limit', 'neq', 'lt']) builder[name] = vi.fn(() => builder);
  builder.update = vi.fn((values: unknown) => {
    onUpdate?.(values);
    return builder;
  });
  builder.maybeSingle = vi.fn(async () => result());
  builder.then = (resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result()).then(resolve, reject);
  return builder;
}

function defaultUserFrom(table: string) {
  const { state } = mocks;
  if (table === 'user_profiles') return chain(() => ({ data: state.profile, error: state.profileError }));
  if (table === 'user_sessions_metadata') {
    return chain(() => ({ data: state.historyRows.length > 0 ? state.historyRows : state.sessionRows, error: null }));
  }
  throw new Error(`unexpected table ${table}`);
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
    },
    from: (table: string) => mocks.userFrom(table),
    rpc: (name: string, args: unknown) => mocks.userRpc(name, args),
  };
}

function makeAdminClient() {
  const { state } = mocks;
  return {
    auth: {
      admin: {
        signOut: (token: string, scope: string) => mocks.adminSignOut(token, scope),
      },
    },
    from: (table: string) => {
      mocks.adminFrom(table);
      return chain(() => ({ data: state.deviceNameUpdated ? [{ session_id: CURRENT_SESSION_ID }] : [], error: null }), mocks.adminUpdate);
    },
    rpc: mocks.adminRpc,
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.loggerError };
    return { ...logger, withUser: () => logger };
  },
  generateRequestId: () => 'req_test',
}));

const { GET: getSessions } = await import('@/app/api/auth/sessions/route');
const { DELETE: deleteSession } = await import('@/app/api/auth/sessions/[id]/route');
const { POST: revokeOthers } = await import('@/app/api/auth/sessions/revoke-others/route');
const { PATCH: patchCurrent } = await import('@/app/api/auth/sessions/current/route');
const { GET: getLoginHistory } = await import('@/app/api/auth/login-history/route');

function sessionRow(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    session_id: sessionId,
    user_id: USER_ID,
    ip_address: '203.0.113.10',
    ip_network: '203.0.113.0/24',
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    device_name: null,
    device_family: 'windows/chrome',
    country_code: 'JP',
    context_source: 'web',
    created_at: '2026-10-15T01:00:00.123456+00:00',
    last_active_at: '2026-10-15T02:00:00.123456+00:00',
    revoked_at: null,
    ended_reason: null,
    is_new_device: false,
    is_new_ip: false,
    is_new_country: false,
    alert_status: 'done',
    alert_claimed_at: null,
    alert_attempts: 0,
    alert_sent_at: null,
    ...overrides,
  };
}

const BASE_URL = 'http://localhost';
function request(method: string, path: string, init: { body?: unknown; bearer?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`${BASE_URL}${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  const { state } = mocks;
  state.authUser = { id: USER_ID };
  state.cookieSession = { access_token: COOKIE_TOKEN };
  state.claimsByToken = {
    [COOKIE_TOKEN]: { sub: USER_ID, session_id: CURRENT_SESSION_ID },
    [BEARER_TOKEN]: { sub: USER_ID, session_id: CURRENT_SESSION_ID },
  };
  state.profile = { roles: ['user'], frozen_at: null, unban_at: null };
  state.profileError = null;
  state.sessionRows = [sessionRow(CURRENT_SESSION_ID), sessionRow(OTHER_SESSION_ID, { user_agent: 'node', device_name: 'iPhone 15 Pro' })];
  state.historyRows = [];
  state.revokeOutcome = 'revoked';
  state.adminSignOutError = null;
  state.deviceNameUpdated = true;
  mocks.userFrom.mockImplementation(defaultUserFrom);
  mocks.userRpc.mockImplementation(async () => ({ data: state.revokeOutcome, error: null }));
  mocks.adminSignOut.mockImplementation(async () => ({ data: null, error: state.adminSignOutError }));
  mocks.createClient.mockImplementation(async () => makeUserClient());
  mocks.getSupabaseAdmin.mockImplementation(() => makeAdminClient());
});

describe('GET /api/auth/sessions (§14.1)', () => {
  it('GET は本人の live の行を device_label と is_current つきで返す', async () => {
    const res = await getSessions(request('GET', '/api/auth/sessions'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.sessions).toEqual([
      expect.objectContaining({ session_id: CURRENT_SESSION_ID, device_label: 'Windows の Chrome', is_current: true, device_name: null }),
      expect.objectContaining({ session_id: OTHER_SESSION_ID, device_label: '不明な端末', is_current: false, device_name: 'iPhone 15 Pro' }),
    ]);
    // 本人の client (RLS) で読み、service_role を使わない
    expect(mocks.userFrom).toHaveBeenCalledWith('user_sessions_metadata');
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    // 生の UA・判定の列は返さない
    expect(JSON.stringify(body)).not.toContain('Mozilla');
    expect(JSON.stringify(body)).not.toContain('alert_status');
  });

  it('GET は claims が読めなければ 401', async () => {
    mocks.state.claimsByToken = {};
    const res = await getSessions(request('GET', '/api/auth/sessions'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(expect.objectContaining({ code: 'AUTH_UNAUTHENTICATED' }));
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('GET と PATCH current は user_profiles の行が無い利用者 (maybeSingle が null) でも 200 (requireUser の 401 にならない S-30)', async () => {
    mocks.state.profile = null;
    const list = await getSessions(request('GET', '/api/auth/sessions'));
    expect(list.status).toBe(200);
    const patch = await patchCurrent(request('PATCH', '/api/auth/sessions/current', { body: { device_name: 'iPhone 15 Pro (iOS 18.0)' }, bearer: BEARER_TOKEN }));
    expect(patch.status).toBe(200);
  });

  it('凍結中は 403', async () => {
    mocks.state.profile = { roles: ['user'], frozen_at: '2026-10-01T00:00:00+00:00', unban_at: null };
    const res = await getSessions(request('GET', '/api/auth/sessions'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(expect.objectContaining({ code: 'AUTH_ACCOUNT_FROZEN' }));
  });

  it('user_profiles の読み取りの失敗は 500 で、本文に DB の文を出さない', async () => {
    mocks.state.profileError = { message: 'relation "user_profiles" does not exist' };
    const res = await getSessions(request('GET', '/api/auth/sessions'));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('relation');
  });
});

describe('DELETE /api/auth/sessions/{id} (§14.2)', () => {
  it('DELETE は revoked で 200、current で 409、not_found で 404、UUID でなければ 404', async () => {
    const revoked = await deleteSession(request('DELETE', `/api/auth/sessions/${OTHER_SESSION_ID}`), params(OTHER_SESSION_ID));
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true });

    mocks.state.revokeOutcome = 'current';
    const current = await deleteSession(request('DELETE', `/api/auth/sessions/${CURRENT_SESSION_ID}`), params(CURRENT_SESSION_ID));
    expect(current.status).toBe(409);
    expect(await current.json()).toEqual({
      error: 'いま使っている端末は、ここでは解除できません。ログアウトを使ってください。',
      code: 'AUTH_SESSION_IS_CURRENT',
    });

    mocks.state.revokeOutcome = 'not_found';
    const notFound = await deleteSession(request('DELETE', `/api/auth/sessions/${OTHER_SESSION_ID}`), params(OTHER_SESSION_ID));
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: 'その端末のログインは、すでに終了しています。', code: 'AUTH_SESSION_NOT_FOUND' });

    mocks.userRpc.mockClear();
    const bad = await deleteSession(request('DELETE', '/api/auth/sessions/not-a-uuid'), params('not-a-uuid'));
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual(expect.objectContaining({ code: 'AUTH_SESSION_NOT_FOUND' }));
    expect(mocks.userRpc).not.toHaveBeenCalled();
    expect(bad.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('DELETE は RPC を本人の client で呼ぶ (service_role を使わない)', async () => {
    await deleteSession(request('DELETE', `/api/auth/sessions/${OTHER_SESSION_ID}`), params(OTHER_SESSION_ID));
    expect(mocks.userRpc).toHaveBeenCalledWith('auth_session_revoke', { p_session_id: OTHER_SESSION_ID });
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/sessions/revoke-others (§14.3)', () => {
  it("revoke-others は Cookie のセッションの access token で auth.admin.signOut(token, 'others') を呼び、残りの件数を返す", async () => {
    mocks.state.sessionRows = [sessionRow(CURRENT_SESSION_ID)];
    const res = await revokeOthers(request('POST', '/api/auth/sessions/revoke-others'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, remaining: 1 });
    expect(mocks.adminSignOut).toHaveBeenCalledTimes(1);
    expect(mocks.adminSignOut).toHaveBeenCalledWith(COOKIE_TOKEN, 'others');
  });

  it('revoke-others は Bearer だけの要求 (Cookie 無し) でも Bearer の JWT を auth.admin.signOut に渡す', async () => {
    mocks.state.cookieSession = null;
    const res = await revokeOthers(request('POST', '/api/auth/sessions/revoke-others', { bearer: BEARER_TOKEN }));
    expect(res.status).toBe(200);
    expect(mocks.adminSignOut).toHaveBeenCalledWith(BEARER_TOKEN, 'others');
  });

  it('revoke-others は createClient() の auth.signOut を呼ばない', async () => {
    await revokeOthers(request('POST', '/api/auth/sessions/revoke-others', { bearer: BEARER_TOKEN }));
    await revokeOthers(request('POST', '/api/auth/sessions/revoke-others'));
    expect(mocks.userSignOut).not.toHaveBeenCalled();
  });

  it('revoke-others は auth.admin.signOut が error なら 500 で remaining を返さない', async () => {
    mocks.state.adminSignOutError = { message: 'Session from session_id claim in JWT does not exist', status: 403 };
    const res = await revokeOthers(request('POST', '/api/auth/sessions/revoke-others'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).not.toHaveProperty('remaining');
    expect(JSON.stringify(body)).not.toContain('session_id claim');
  });

  it('revoke-others は claims が読めなければ 401', async () => {
    mocks.state.claimsByToken = {};
    const res = await revokeOthers(request('POST', '/api/auth/sessions/revoke-others'));
    expect(res.status).toBe(401);
    expect(mocks.adminSignOut).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/auth/sessions/current (§14.4)', () => {
  it('PATCH current は device_name を検証し、行が無ければ 404', async () => {
    const ok = await patchCurrent(request('PATCH', '/api/auth/sessions/current', { body: { device_name: '  iPhone 15 Pro (iOS 18.0)  ' }, bearer: BEARER_TOKEN }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(mocks.adminUpdate).toHaveBeenCalledWith({ device_name: 'iPhone 15 Pro (iOS 18.0)', context_source: 'mobile' });

    mocks.state.deviceNameUpdated = false;
    const missing = await patchCurrent(request('PATCH', '/api/auth/sessions/current', { body: { device_name: 'Pixel 8' }, bearer: BEARER_TOKEN }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(expect.objectContaining({ code: 'AUTH_SESSION_NOT_FOUND' }));

    const empty = await patchCurrent(request('PATCH', '/api/auth/sessions/current', { body: { device_name: '   ' }, bearer: BEARER_TOKEN }));
    expect(empty.status).toBe(400);
    const broken = await patchCurrent(request('PATCH', '/api/auth/sessions/current', { body: '{not json', bearer: BEARER_TOKEN }));
    expect(broken.status).toBe(400);
  });

  it.each([['日本語の端末'], ['http://evil.example'], ['a/b'], ['me@example.com'], ['iPhone\nもう一行']])(
    'PATCH current は日本語・`:`・`/`・`@`・改行を含む device_name (%s) を 400 VALIDATION_ERROR にし、setCurrentDeviceName を呼ばない (S-31)',
    async (deviceName) => {
      const res = await patchCurrent(request('PATCH', '/api/auth/sessions/current', { body: { device_name: deviceName }, bearer: BEARER_TOKEN }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: '入力の内容を確認してください。', code: 'VALIDATION_ERROR' });
      expect(mocks.adminUpdate).not.toHaveBeenCalled();
      expect(mocks.createClient).not.toHaveBeenCalled();
    },
  );

  it('PATCH current は `iPhone 15 Pro (iOS 18.0)` を通し、要求の JWT の session_id の行に書く', async () => {
    const res = await patchCurrent(request('PATCH', '/api/auth/sessions/current', { body: { device_name: 'iPhone 15 Pro (iOS 18.0)' }, bearer: BEARER_TOKEN }));
    expect(res.status).toBe(200);
    expect(mocks.adminFrom).toHaveBeenCalledWith('user_sessions_metadata');
  });
});

describe('GET /api/auth/login-history (§14.5)', () => {
  it('login-history は 20 件まで', async () => {
    mocks.state.historyRows = [
      sessionRow(OTHER_SESSION_ID, {
        revoked_at: '2026-10-15T03:00:00+00:00',
        ended_reason: 'signed_out',
        is_new_device: true,
        alert_sent_at: '2026-10-15T01:01:00+00:00',
      }),
    ];
    let limitArg: unknown;
    mocks.userFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') return chain(() => ({ data: mocks.state.profile, error: null }));
      const builder = chain(() => ({ data: mocks.state.historyRows, error: null }));
      const limit = builder.limit as ReturnType<typeof vi.fn>;
      limit.mockImplementation((value: unknown) => {
        limitArg = value;
        return builder;
      });
      return builder;
    });
    const res = await getLoginHistory(request('GET', '/api/auth/login-history'));
    expect(res.status).toBe(200);
    expect(limitArg).toBe(20);
    const body = await res.json();
    expect(body.entries).toEqual([
      expect.objectContaining({
        session_id: OTHER_SESSION_ID,
        ended_at: '2026-10-15T03:00:00+00:00',
        ended_reason: 'signed_out',
        is_new_device: true,
        alert_sent_at: '2026-10-15T01:01:00+00:00',
        device_label: 'Windows の Chrome',
      }),
    ]);
    expect(body.entries[0]).not.toHaveProperty('is_current');
  });

  it('どの応答にも Cache-Control: private, no-store', async () => {
    const responses = [
      await getSessions(request('GET', '/api/auth/sessions')),
      await getLoginHistory(request('GET', '/api/auth/login-history')),
      await deleteSession(request('DELETE', `/api/auth/sessions/${OTHER_SESSION_ID}`), params(OTHER_SESSION_ID)),
      await revokeOthers(request('POST', '/api/auth/sessions/revoke-others')),
      await patchCurrent(request('PATCH', '/api/auth/sessions/current', { body: { device_name: 'Pixel 8' } })),
      await patchCurrent(request('PATCH', '/api/auth/sessions/current', { body: { device_name: 'ピクセル' } })),
    ];
    for (const res of responses) expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
