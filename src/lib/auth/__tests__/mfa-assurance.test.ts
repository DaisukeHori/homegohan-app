/**
 * #1176 セッションの AAL の読み取りのテスト (段 A)。docs/design/cross/12-operator-mfa.md §13.2・§21.1 (mfa-assurance.test.ts)
 * supabase の client と next/headers を差し替える。assertOperatorAssurance の it は段 B で足す。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ headerGet: vi.fn() }));

// next/headers の headers() は Promise を返す (Next 15。tests/next15-async-request-api-scan.test.ts の #1621)
vi.mock('next/headers', () => ({ headers: async () => ({ get: mocks.headerGet }) }));

import { AuthError } from '@/lib/auth/errors';
import { SessionClaimsSchema, bearerJwtOf, readSessionAssurance } from '@/lib/auth/mfa/assurance';

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
