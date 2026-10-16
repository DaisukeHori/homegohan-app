/**
 * #1176 運営の入口の AAL2 のゲート (段 B)。docs/design/cross/12-operator-mfa.md §13.1・§13.5・§21.1 (mfa-gate.test.ts)
 *
 * src/lib/auth/helpers.ts の requireRole と src/lib/auth/operator-permissions.ts の requireSuperAdmin を本物で通し、
 * Supabase (@/lib/supabase/server の createClient) だけを差し替える。getClaims を数えて、AAL を読む / 読まないを確かめる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeFactor {
  id: string;
  factor_type: 'totp' | 'phone';
  status: 'verified' | 'unverified';
  created_at: string;
  updated_at: string;
}

interface FakeWorld {
  user: { id: string; email: string; factors: FakeFactor[] } | null;
  profile: { roles: string[]; organization_id: string | null; frozen_at: string | null; unban_at: string | null } | null;
  aal: 'aal1' | 'aal2';
}

const h = vi.hoisted(() => ({
  world: { user: null, profile: null, aal: 'aal1' } as FakeWorld,
  getClaims: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () =>
        h.world.user ? { data: { user: h.world.user }, error: null } : { data: { user: null }, error: { message: 'no session' } },
      getSession: h.getSession,
      getClaims: h.getClaims,
    },
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        single: async () => (h.world.profile ? { data: h.world.profile, error: null } : { data: null, error: { message: 'no rows' } }),
      };
      return builder;
    },
  }),
}));

import { AuthError, ForbiddenError, MfaRequiredError } from '@/lib/auth/errors';
import { requireRole } from '@/lib/auth/helpers';
import { requireSuperAdmin } from '@/lib/auth/operator-permissions';

const USER_ID = 'operator-1';
/** 猶予の日時 (未来)。readMfaEnforceFromEnv は呼ぶたびに process.env を読む */
const FUTURE_ENFORCE_FROM = '2999-01-01T00:00:00+09:00';

const VERIFIED_TOTP: FakeFactor = {
  id: 'factor-1',
  factor_type: 'totp',
  status: 'verified',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
};

function setWorld(next: { roles: string[]; aal?: 'aal1' | 'aal2'; factors?: FakeFactor[]; frozen?: boolean } | null): void {
  const world = h.world;
  if (next === null) {
    world.user = null;
    world.profile = null;
    return;
  }
  world.user = { id: USER_ID, email: 'operator@example.com', factors: next.factors ?? [] };
  world.profile = {
    roles: next.roles,
    organization_id: null,
    frozen_at: next.frozen ? '2026-10-01T00:00:00Z' : null,
    unban_at: null,
  };
  world.aal = next.aal ?? 'aal1';
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('OPERATOR_MFA_ENFORCE_FROM', '');
  h.getSession.mockReset();
  h.getSession.mockResolvedValue({ data: { session: { access_token: 'a.b.c' } }, error: null });
  h.getClaims.mockReset();
  h.getClaims.mockImplementation(async () => ({
    data: { claims: { sub: USER_ID, aal: h.world.aal, session_id: 'session-1' } },
    error: null,
  }));
  setWorld(null);
});

describe('requireRole (段 B の AAL2 のゲート)', () => {
  it('requireRole: admin + aal1 + verified は AUTH_2FA_REQUIRED を投げる', async () => {
    setWorld({ roles: ['admin'], aal: 'aal1', factors: [VERIFIED_TOTP] });
    const result = requireRole(['admin', 'super_admin']);
    await expect(result).rejects.toBeInstanceOf(MfaRequiredError);
    await expect(result).rejects.toMatchObject({ code: 'AUTH_2FA_REQUIRED' });
  });

  it('requireRole: admin + aal1 + factor 無し + 猶予なし は AUTH_2FA_ENROLLMENT_REQUIRED', async () => {
    setWorld({ roles: ['admin'], aal: 'aal1' });
    await expect(requireRole(['admin', 'super_admin'])).rejects.toMatchObject({ code: 'AUTH_2FA_ENROLLMENT_REQUIRED' });
  });

  it('requireRole: admin + aal1 + factor 無し + OPERATOR_MFA_ENFORCE_FROM が未来 (vi.stubEnv。readMfaEnforceFromEnv は呼ぶたびに process.env を読む) は投げず、assurance.decision = pass_grace・enforce_from = その日時の ISO 文字列 (S-5・S-15 の猶予の枝。結合テストでは試さない §21.4)', async () => {
    vi.stubEnv('OPERATOR_MFA_ENFORCE_FROM', FUTURE_ENFORCE_FROM);
    setWorld({ roles: ['admin'], aal: 'aal1' });
    const actor = await requireRole(['admin', 'super_admin']);
    expect(actor.assurance).toEqual({
      required: true,
      aal: 'aal1',
      enrolled: false,
      decision: 'pass_grace',
      enforce_from: new Date(FUTURE_ENFORCE_FROM).toISOString(),
    });
  });

  it('requireRole: admin + aal1 + verified + OPERATOR_MFA_ENFORCE_FROM が未来 でも AUTH_2FA_REQUIRED (猶予は未登録にだけ効く)', async () => {
    vi.stubEnv('OPERATOR_MFA_ENFORCE_FROM', FUTURE_ENFORCE_FROM);
    setWorld({ roles: ['admin'], aal: 'aal1', factors: [VERIFIED_TOTP] });
    await expect(requireRole(['admin', 'super_admin'])).rejects.toMatchObject({ code: 'AUTH_2FA_REQUIRED' });
  });

  it('requireRole([admin, super_admin, finance]): roles [admin, finance] と [finance] だけ、どちらも aal1 + verified は AUTH_2FA_REQUIRED (S-13)', async () => {
    for (const roles of [['admin', 'finance'], ['finance']]) {
      setWorld({ roles, aal: 'aal1', factors: [VERIFIED_TOTP] });
      await expect(requireRole(['admin', 'super_admin', 'finance'])).rejects.toMatchObject({ code: 'AUTH_2FA_REQUIRED' });
    }
  });

  it('requireRole: admin + aal2 は UserProfile.assurance.decision = pass', async () => {
    setWorld({ roles: ['admin'], aal: 'aal2', factors: [VERIFIED_TOTP] });
    const actor = await requireRole(['admin', 'super_admin']);
    expect(actor).toMatchObject({ id: USER_ID, roles: ['admin'] });
    expect(actor.assurance).toEqual({ required: true, aal: 'aal2', enrolled: true, decision: 'pass', enforce_from: null });
  });

  it('requireRole: support だけなら getClaims を呼ばず assurance.decision = not_required', async () => {
    setWorld({ roles: ['support'], aal: 'aal1' });
    const actor = await requireRole(['support', 'admin', 'super_admin']);
    expect(actor.assurance?.decision).toBe('not_required');
    expect(h.getClaims).not.toHaveBeenCalled();
    expect(h.getSession).not.toHaveBeenCalled();
  });

  it("requireRole: { assurance: 'session' } は AAL を見ない (assurance は undefined)", async () => {
    setWorld({ roles: ['admin'], aal: 'aal1', factors: [VERIFIED_TOTP] });
    const actor = await requireRole(['admin', 'super_admin'], { assurance: 'session' });
    expect(actor.assurance).toBeUndefined();
    expect(h.getClaims).not.toHaveBeenCalled();
  });

  it('requireRole: 凍結中は AAL の前に AUTH_ACCOUNT_FROZEN', async () => {
    setWorld({ roles: ['admin'], aal: 'aal1', factors: [VERIFIED_TOTP], frozen: true });
    const result = requireRole(['admin', 'super_admin']);
    await expect(result).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_FROZEN' });
    await expect(result).rejects.not.toBeInstanceOf(MfaRequiredError);
    expect(h.getClaims).not.toHaveBeenCalled();
  });

  it('requireRole: ロール不足は AAL の前に PERM_DENIED (getClaims を呼ばない)', async () => {
    setWorld({ roles: ['admin'], aal: 'aal1', factors: [VERIFIED_TOTP] });
    await expect(requireRole(['super_admin'])).rejects.toMatchObject({ code: 'PERM_DENIED' });
    expect(h.getClaims).not.toHaveBeenCalled();
  });
});

describe('requireSuperAdmin (段 B の委譲)', () => {
  it("requireSuperAdmin: requireRole(['super_admin']) に委ね、aal1 なら AUTH_2FA_REQUIRED、non-super_admin なら ForbiddenError、未認証なら AuthError", async () => {
    setWorld({ roles: ['super_admin'], aal: 'aal2', factors: [VERIFIED_TOTP] });
    await expect(requireSuperAdmin()).resolves.toEqual({ userId: USER_ID });

    setWorld({ roles: ['super_admin'], aal: 'aal1', factors: [VERIFIED_TOTP] });
    await expect(requireSuperAdmin()).rejects.toMatchObject({ code: 'AUTH_2FA_REQUIRED' });

    setWorld({ roles: ['admin'], aal: 'aal2', factors: [VERIFIED_TOTP] });
    const forbidden = requireSuperAdmin();
    await expect(forbidden).rejects.toBeInstanceOf(ForbiddenError);
    await expect(forbidden).rejects.toMatchObject({ code: 'PERM_DENIED' });

    setWorld(null);
    await expect(requireSuperAdmin()).rejects.toBeInstanceOf(AuthError);
  });

  it('requireSuperAdmin: 凍結中の super_admin は AUTH_ACCOUNT_FROZEN (委譲で凍結の判定が付く)', async () => {
    setWorld({ roles: ['super_admin'], aal: 'aal2', factors: [VERIFIED_TOTP], frozen: true });
    await expect(requireSuperAdmin()).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_FROZEN' });
  });
});
