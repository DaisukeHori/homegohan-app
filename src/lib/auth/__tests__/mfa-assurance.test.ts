/**
 * #1176 セッションの AAL の読み取りのテスト (段 A)。docs/design/cross/12-operator-mfa.md §13.2・§21.1 (mfa-assurance.test.ts)
 * supabase の client と next/headers を差し替える。assertOperatorAssurance の it (段 B) は @/lib/supabase/server の createClient も差し替える。
 */
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ headerGet: vi.fn(), serverClient: { current: null as unknown } }));

// assertOperatorAssurance (段 B) が createClient() で読む client。it ごとに mocks.serverClient.current を差し替える
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => mocks.serverClient.current }));

// next/headers の headers() は Promise を返す (Next 15。tests/next15-async-request-api-scan.test.ts の #1621)
vi.mock('next/headers', () => ({ headers: async () => ({ get: mocks.headerGet }) }));

import { AuthError, ForbiddenError, MfaRequiredError } from '@/lib/auth/errors';
import {
  SessionClaimsSchema,
  assertOperatorAssurance,
  bearerJwtOf,
  readRequestAccessToken,
  readSessionAssurance,
} from '@/lib/auth/mfa/assurance';

const USER_ID = 'user-1';
const COOKIE_TOKEN = 'cookie.header.payload';
const BEARER_TOKEN = 'bearer.header.payload';

function supabaseWith(options: {
  sessionToken: string | null;
  claims?: Record<string, unknown> | null;
  claimsError?: unknown;
}) {
  const getSession = vi.fn().mockResolvedValue({
    data: { session: options.sessionToken ? { access_token: options.sessionToken } : null },
    error: null,
  });
  const getClaims = vi.fn().mockResolvedValue(
    options.claimsError
      ? { data: null, error: options.claimsError }
      : { data: options.claims === null ? null : { claims: options.claims ?? {} }, error: null },
  );
  const client = { auth: { getSession, getClaims } } as unknown as SupabaseClient;
  return { client, getSession, getClaims };
}

beforeEach(() => {
  mocks.headerGet.mockReset();
  mocks.serverClient.current = null;
  vi.unstubAllEnvs();
});

describe('bearerJwtOf', () => {
  it('bearerJwtOf: 3 セグメントの Bearer だけ token にする (CRON_SECRET 形式は null)', () => {
    expect(bearerJwtOf('Bearer a.b.c')).toBe('a.b.c');
    expect(bearerJwtOf('bearer  a.b.c')).toBe('a.b.c');
    expect(bearerJwtOf('Bearer cron-secret-value')).toBeNull();
    expect(bearerJwtOf('Bearer a.b')).toBeNull();
    expect(bearerJwtOf('Basic a.b.c')).toBeNull();
    expect(bearerJwtOf('Bearer ')).toBeNull();
    expect(bearerJwtOf(null)).toBeNull();
    expect(bearerJwtOf('')).toBeNull();
  });
});

describe('readRequestAccessToken', () => {
  it('readRequestAccessToken: Cookie のセッションの access_token を先に返し (next/headers を読まない)、無ければ Bearer JWT、どちらも無ければ null (回復の route が全セッションを終えるのに使う)', async () => {
    const cookie = supabaseWith({ sessionToken: COOKIE_TOKEN });
    mocks.headerGet.mockImplementation((name: string) => (name === 'authorization' ? `Bearer ${BEARER_TOKEN}` : null));
    await expect(readRequestAccessToken(cookie.client)).resolves.toBe(COOKIE_TOKEN);
    expect(mocks.headerGet).not.toHaveBeenCalled();

    const bearer = supabaseWith({ sessionToken: null });
    await expect(readRequestAccessToken(bearer.client)).resolves.toBe(BEARER_TOKEN);

    mocks.headerGet.mockReturnValue('Bearer cron-secret');
    await expect(readRequestAccessToken(supabaseWith({ sessionToken: null }).client)).resolves.toBeNull();
    mocks.headerGet.mockReturnValue(null);
    await expect(readRequestAccessToken(supabaseWith({ sessionToken: null }).client)).resolves.toBeNull();
  });
});

describe('readSessionAssurance', () => {
  it('readSessionAssurance: Cookie のセッションがあればその access_token を getClaims に渡し、next/headers は読まない', async () => {
    const { client, getClaims } = supabaseWith({
      sessionToken: COOKIE_TOKEN,
      claims: { sub: USER_ID, aal: 'aal2', session_id: 'session-1' },
    });
    await expect(readSessionAssurance(client, { id: USER_ID })).resolves.toEqual({ aal: 'aal2', sessionId: 'session-1' });
    expect(getClaims).toHaveBeenCalledWith(COOKIE_TOKEN);
    expect(mocks.headerGet).not.toHaveBeenCalled();
  });

  it('readSessionAssurance: セッションが無ければ Authorization ヘッダの Bearer JWT を getClaims に渡す (next/headers をモック)', async () => {
    mocks.headerGet.mockImplementation((name: string) => (name === 'authorization' ? `Bearer ${BEARER_TOKEN}` : null));
    const { client, getClaims } = supabaseWith({ sessionToken: null, claims: { sub: USER_ID, aal: 'aal1' } });
    await expect(readSessionAssurance(client, { id: USER_ID })).resolves.toEqual({ aal: 'aal1', sessionId: null });
    expect(getClaims).toHaveBeenCalledWith(BEARER_TOKEN);
  });

  it('readSessionAssurance: token 無し / getClaims の error / sub の不一致は AuthError(AUTH_UNAUTHENTICATED)', async () => {
    mocks.headerGet.mockReturnValue(null);
    const noToken = supabaseWith({ sessionToken: null });
    await expect(readSessionAssurance(noToken.client, { id: USER_ID })).rejects.toMatchObject({
      code: 'AUTH_UNAUTHENTICATED',
    });
    expect(noToken.getClaims).not.toHaveBeenCalled();

    mocks.headerGet.mockReturnValue('Bearer cron-secret');
    const cronSecret = supabaseWith({ sessionToken: null });
    await expect(readSessionAssurance(cronSecret.client, { id: USER_ID })).rejects.toBeInstanceOf(AuthError);
    expect(cronSecret.getClaims).not.toHaveBeenCalled();

    const claimsError = supabaseWith({ sessionToken: COOKIE_TOKEN, claimsError: { message: 'invalid JWT' } });
    await expect(readSessionAssurance(claimsError.client, { id: USER_ID })).rejects.toMatchObject({
      code: 'AUTH_UNAUTHENTICATED',
    });

    const noData = supabaseWith({ sessionToken: COOKIE_TOKEN, claims: null });
    await expect(readSessionAssurance(noData.client, { id: USER_ID })).rejects.toBeInstanceOf(AuthError);

    const otherUser = supabaseWith({ sessionToken: COOKIE_TOKEN, claims: { sub: 'someone-else', aal: 'aal2' } });
    await expect(readSessionAssurance(otherUser.client, { id: USER_ID })).rejects.toMatchObject({
      code: 'AUTH_UNAUTHENTICATED',
    });

    const noSub = supabaseWith({ sessionToken: COOKIE_TOKEN, claims: { aal: 'aal2' } });
    await expect(readSessionAssurance(noSub.client, { id: USER_ID })).rejects.toBeInstanceOf(AuthError);
  });

  it('readSessionAssurance: aal が無い claim は aal1 として読む', async () => {
    const missing = supabaseWith({ sessionToken: COOKIE_TOKEN, claims: { sub: USER_ID } });
    await expect(readSessionAssurance(missing.client, { id: USER_ID })).resolves.toEqual({ aal: 'aal1', sessionId: null });
    const unexpected = supabaseWith({ sessionToken: COOKIE_TOKEN, claims: { sub: USER_ID, aal: 'aal3' } });
    await expect(readSessionAssurance(unexpected.client, { id: USER_ID })).resolves.toEqual({ aal: 'aal1', sessionId: null });
    expect(SessionClaimsSchema.parse({ sub: USER_ID }).aal).toBe('aal1');
  });

  it('readSessionAssurance: claims に amr (method が oauth / password のどちら) があっても読むのは aal と session_id だけ。Google ログインの aal1 は aal1 (S-18: 判定はログインの方式を入力に持たない)', async () => {
    for (const method of ['oauth', 'password']) {
      const { client } = supabaseWith({
        sessionToken: COOKIE_TOKEN,
        claims: { sub: USER_ID, aal: 'aal1', session_id: 's-1', amr: [{ method, timestamp: 1 }], app_metadata: { provider: 'google' } },
      });
      const result = await readSessionAssurance(client, { id: USER_ID });
      expect(result).toEqual({ aal: 'aal1', sessionId: 's-1' });
      expect(Object.keys(result).sort()).toEqual(['aal', 'sessionId']);
    }
  });
});

describe('assertOperatorAssurance (段 B)', () => {
  /** 固定の時刻 (猶予の判定に使う) */
  const NOW = new Date('2026-10-20T00:00:00Z');
  const FUTURE = '2026-11-01T00:00:00+09:00';
  const VERIFIED_TOTP = {
    id: 'factor-1',
    factor_type: 'totp',
    status: 'verified',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    friendly_name: 'authenticator',
  };

  function userWith(factors: ReadonlyArray<typeof VERIFIED_TOTP>): User {
    return { id: USER_ID, factors } as unknown as User;
  }

  it('assertOperatorAssurance: 必須ロールでなければ getClaims を呼ばない', async () => {
    vi.stubEnv('OPERATOR_MFA_ENFORCE_FROM', '');
    const { client, getSession, getClaims } = supabaseWith({ sessionToken: COOKIE_TOKEN, claims: { sub: USER_ID, aal: 'aal1' } });
    mocks.serverClient.current = client;
    await expect(assertOperatorAssurance({ user: userWith([]), roles: ['support'], now: NOW })).resolves.toEqual({
      required: false,
      aal: null,
      enrolled: false,
      decision: 'not_required',
      enforce_from: null,
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(getClaims).not.toHaveBeenCalled();
  });

  it('assertOperatorAssurance: challenge_required は MfaRequiredError(AUTH_2FA_REQUIRED)、enrollment_required は AUTH_2FA_ENROLLMENT_REQUIRED (どちらも instanceof ForbiddenError)', async () => {
    vi.stubEnv('OPERATOR_MFA_ENFORCE_FROM', '');
    mocks.serverClient.current = supabaseWith({ sessionToken: COOKIE_TOKEN, claims: { sub: USER_ID, aal: 'aal1' } }).client;

    const challenge = assertOperatorAssurance({ user: userWith([VERIFIED_TOTP]), roles: ['admin'], now: NOW });
    await expect(challenge).rejects.toBeInstanceOf(MfaRequiredError);
    await expect(challenge).rejects.toBeInstanceOf(ForbiddenError);
    await expect(challenge).rejects.toMatchObject({ code: 'AUTH_2FA_REQUIRED' });

    const enrollment = assertOperatorAssurance({ user: userWith([]), roles: ['super_admin'], now: NOW });
    await expect(enrollment).rejects.toBeInstanceOf(MfaRequiredError);
    await expect(enrollment).rejects.toBeInstanceOf(ForbiddenError);
    await expect(enrollment).rejects.toMatchObject({ code: 'AUTH_2FA_ENROLLMENT_REQUIRED' });
  });

  it('assertOperatorAssurance: pass / pass_grace は要約 (required / aal / enrolled / decision / enforce_from) を返す', async () => {
    vi.stubEnv('OPERATOR_MFA_ENFORCE_FROM', '');
    mocks.serverClient.current = supabaseWith({ sessionToken: COOKIE_TOKEN, claims: { sub: USER_ID, aal: 'aal2' } }).client;
    await expect(assertOperatorAssurance({ user: userWith([VERIFIED_TOTP]), roles: ['admin'], now: NOW })).resolves.toEqual({
      required: true,
      aal: 'aal2',
      enrolled: true,
      decision: 'pass',
      enforce_from: null,
    });

    vi.stubEnv('OPERATOR_MFA_ENFORCE_FROM', FUTURE);
    mocks.serverClient.current = supabaseWith({ sessionToken: COOKIE_TOKEN, claims: { sub: USER_ID, aal: 'aal1' } }).client;
    await expect(assertOperatorAssurance({ user: userWith([]), roles: ['finance'], now: NOW })).resolves.toEqual({
      required: true,
      aal: 'aal1',
      enrolled: false,
      decision: 'pass_grace',
      enforce_from: new Date(FUTURE).toISOString(),
    });
  });
});
