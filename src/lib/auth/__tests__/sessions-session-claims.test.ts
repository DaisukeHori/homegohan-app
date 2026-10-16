/**
 * src/lib/auth/sessions/session-claims.ts の単体テスト (#1190・#1198。設計 docs/design/cross/16-auth-history-sessions.md §12.4・§13.6・§20.1)
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '../errors';
import {
  RECOVERY_AMR_METHODS,
  SessionUserProfileReadError,
  hasRecentRecoveryMethod,
  readSessionAuth,
  requireSessionUser,
  type SessionClaims,
  type SessionClaimsReader,
} from '../sessions/session-claims';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const BEARER_JWT = 'bearer.jwt.value';
const COOKIE_JWT = 'cookie.jwt.value';
const MAX_AGE_MINUTES = 60;
const NOW = new Date('2026-10-16T00:00:00.000Z');
const SECONDS = (date: Date) => Math.floor(date.getTime() / 1000);

function reader(options: {
  cookieToken?: string | null;
  claims?: unknown;
  claimsError?: boolean;
}): SessionClaimsReader & { getSession: ReturnType<typeof vi.fn>; getClaims: ReturnType<typeof vi.fn> } {
  const getSession = vi.fn(async () => ({
    data: { session: options.cookieToken ? { access_token: options.cookieToken } : null },
  }));
  const getClaims = vi.fn(async () =>
    options.claimsError
      ? { data: null, error: { message: 'invalid' } }
      : { data: { claims: options.claims ?? { sub: USER_ID, session_id: SESSION_ID } }, error: null },
  );
  return { getSession, getClaims };
}

describe('readSessionAuth', () => {
  it('Bearer があれば getSession を呼ばずその JWT を getClaims に渡し、accessToken にその JWT を返す', async () => {
    const auth = reader({ cookieToken: COOKIE_JWT });
    const result = await readSessionAuth(auth, `Bearer ${BEARER_JWT}`);
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(auth.getClaims).toHaveBeenCalledWith(BEARER_JWT);
    expect(result).toEqual({ claims: { sub: USER_ID, session_id: SESSION_ID }, accessToken: BEARER_JWT });
  });

  it('Bearer が無ければ Cookie のセッションの access_token を渡し、accessToken にその token を返す', async () => {
    const auth = reader({ cookieToken: COOKIE_JWT });
    const result = await readSessionAuth(auth, null);
    expect(auth.getSession).toHaveBeenCalledTimes(1);
    expect(auth.getClaims).toHaveBeenCalledWith(COOKIE_JWT);
    expect(result?.accessToken).toBe(COOKIE_JWT);
    expect(result?.claims.session_id).toBe(SESSION_ID);
  });

  it('token が無い・getClaims が error・claims の形が違うときは null', async () => {
    const noToken = reader({ cookieToken: null });
    expect(await readSessionAuth(noToken, undefined)).toBeNull();
    expect(noToken.getClaims).not.toHaveBeenCalled();
    expect(await readSessionAuth(reader({ claimsError: true }), `Bearer ${BEARER_JWT}`)).toBeNull();
    expect(await readSessionAuth(reader({ claims: { sub: USER_ID } }), `Bearer ${BEARER_JWT}`)).toBeNull();
    expect(await readSessionAuth(reader({ claims: { sub: 'not-a-uuid', session_id: SESSION_ID } }), `Bearer ${BEARER_JWT}`)).toBeNull();
    // Bearer の形でないヘッダは無視して Cookie を見る (ここでは Cookie も無い)
    expect(await readSessionAuth(reader({ cookieToken: null }), 'Basic abc')).toBeNull();
  });
});

describe('hasRecentRecoveryMethod', () => {
  const claimsWith = (amr: Array<{ method: string; timestamp: number }>): SessionClaims => ({ sub: USER_ID, session_id: SESSION_ID, amr });

  it('RECOVERY_AMR_METHODS は recovery と otp だけ', () => {
    expect([...RECOVERY_AMR_METHODS].sort()).toEqual(['otp', 'recovery']);
  });

  it('hasRecentRecoveryMethod は 60 分以内の recovery を真にする', () => {
    const at = new Date(NOW.getTime() - MAX_AGE_MINUTES * 60 * 1000);
    expect(hasRecentRecoveryMethod(claimsWith([{ method: 'recovery', timestamp: SECONDS(at) }]), NOW, MAX_AGE_MINUTES)).toBe(true);
  });

  it('hasRecentRecoveryMethod は 60 分以内の otp を真にする', () => {
    const at = new Date(NOW.getTime() - 5 * 60 * 1000);
    expect(hasRecentRecoveryMethod(claimsWith([{ method: 'otp', timestamp: SECONDS(at) }]), NOW, MAX_AGE_MINUTES)).toBe(true);
  });

  it('password・oauth だけなら偽', () => {
    const at = SECONDS(NOW);
    expect(hasRecentRecoveryMethod(claimsWith([{ method: 'password', timestamp: at }, { method: 'oauth', timestamp: at }]), NOW, MAX_AGE_MINUTES)).toBe(false);
    expect(hasRecentRecoveryMethod({ sub: USER_ID, session_id: SESSION_ID }, NOW, MAX_AGE_MINUTES)).toBe(false);
  });

  it('60 分より古い recovery / otp は偽', () => {
    const at = SECONDS(new Date(NOW.getTime() - MAX_AGE_MINUTES * 60 * 1000)) - 1;
    expect(hasRecentRecoveryMethod(claimsWith([{ method: 'recovery', timestamp: at }]), NOW, MAX_AGE_MINUTES)).toBe(false);
    expect(hasRecentRecoveryMethod(claimsWith([{ method: 'otp', timestamp: at }]), NOW, MAX_AGE_MINUTES)).toBe(false);
  });
});

interface FakeOptions {
  user?: { id: string } | null;
  userError?: boolean;
  claims?: unknown;
  claimsError?: boolean;
  profile?: { roles: string[] | null; frozen_at: string | null; unban_at: string | null } | null;
  profileError?: boolean;
}

function fakeSupabase(options: FakeOptions) {
  const maybeSingle = vi.fn(async () =>
    options.profileError
      ? { data: null, error: { message: 'relation "user_profiles" permission denied for value secret' } }
      : { data: options.profile ?? null, error: null },
  );
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const auth = {
    getUser: vi.fn(async () =>
      options.userError
        ? { data: { user: null }, error: { message: 'bad' } }
        : { data: { user: options.user === undefined ? { id: USER_ID } : options.user }, error: null },
    ),
    ...reader({ cookieToken: COOKIE_JWT, claims: options.claims, claimsError: options.claimsError }),
  };
  const client = { auth, from } as unknown as SupabaseClient;
  return { client, from, select, eq, maybeSingle };
}

describe('requireSessionUser', () => {
  it('requireSessionUser は getUser が error か user 無しなら AuthError (AUTH_UNAUTHENTICATED)', async () => {
    for (const options of [{ userError: true }, { user: null }]) {
      const { client } = fakeSupabase(options);
      const error = await requireSessionUser(client, null).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe('AUTH_UNAUTHENTICATED');
    }
  });

  it('requireSessionUser は claims が読めない・sub が getUser の id と違うなら AuthError (AUTH_UNAUTHENTICATED)', async () => {
    for (const options of [{ claimsError: true }, { claims: { sub: OTHER_USER_ID, session_id: SESSION_ID } }]) {
      const { client, from } = fakeSupabase(options);
      const error = await requireSessionUser(client, null).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe('AUTH_UNAUTHENTICATED');
      expect(from).not.toHaveBeenCalled();
    }
  });

  it('requireSessionUser は user_profiles の行が無ければ (maybeSingle の data が null) roles [] で通し、凍結の判定で止めない (S-30)', async () => {
    const { client, from, select, eq } = fakeSupabase({ profile: null });
    const ctx = await requireSessionUser(client, `Bearer ${BEARER_JWT}`);
    expect(ctx.user.id).toBe(USER_ID);
    expect(ctx.roles).toEqual([]);
    expect(ctx.session).toEqual({ claims: { sub: USER_ID, session_id: SESSION_ID }, accessToken: BEARER_JWT });
    expect(from).toHaveBeenCalledWith('user_profiles');
    expect(select).toHaveBeenCalledWith('roles, frozen_at, unban_at');
    expect(eq).toHaveBeenCalledWith('id', USER_ID);
  });

  it('requireSessionUser は行があって凍結中なら ForbiddenError AUTH_ACCOUNT_FROZEN、unban_at が過ぎていれば通す', async () => {
    const frozen = fakeSupabase({ profile: { roles: ['user'], frozen_at: '2026-01-01T00:00:00Z', unban_at: null } });
    const error = await requireSessionUser(frozen.client, null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).code).toBe('AUTH_ACCOUNT_FROZEN');

    const unbanned = fakeSupabase({ profile: { roles: ['user'], frozen_at: '2026-01-01T00:00:00Z', unban_at: '2026-01-02T00:00:00Z' } });
    await expect(requireSessionUser(unbanned.client, null)).resolves.toMatchObject({ roles: ['user'] });
  });

  it('requireSessionUser は行の roles を返し、null は []', async () => {
    const withRoles = fakeSupabase({ profile: { roles: ['super_admin'], frozen_at: null, unban_at: null } });
    expect((await requireSessionUser(withRoles.client, null)).roles).toEqual(['super_admin']);
    const nullRoles = fakeSupabase({ profile: { roles: null, frozen_at: null, unban_at: null } });
    expect((await requireSessionUser(nullRoles.client, null)).roles).toEqual([]);
  });

  it('requireSessionUser は user_profiles の読み取りが error なら SessionUserProfileReadError (値・英文を持たない)', async () => {
    const { client } = fakeSupabase({ profileError: true });
    const error = await requireSessionUser(client, null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionUserProfileReadError);
    expect((error as Error).message).not.toMatch(/permission|secret|relation/);
  });
});
