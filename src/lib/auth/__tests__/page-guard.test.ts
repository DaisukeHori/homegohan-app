/**
 * #1176 運営の layout / page の入口 requireRoleForPage (段 B)。docs/design/cross/12-operator-mfa.md §13.4・§21.1 (page-guard.test.ts)
 * next/navigation の redirect と、@/lib/auth/helpers の requireRole を差し替える。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock('@/lib/auth/helpers', () => ({ requireRole: h.requireRole }));

import { AuthError, ForbiddenError, MfaRequiredError } from '@/lib/auth/errors';
import { MFA_PAGE_PATHS, PAGE_FORBIDDEN_DEFAULT_PATH, mfaRedirectPathFor, requireRoleForPage } from '@/lib/auth/page-guard';

const NEXT = '/admin/users/a b?x=1';
const ENCODED_NEXT = encodeURIComponent(NEXT);

beforeEach(() => {
  h.requireRole.mockReset();
});

describe('mfaRedirectPathFor', () => {
  it('mfaRedirectPathFor: AUTH_2FA_REQUIRED → verify、AUTH_2FA_ENROLLMENT_REQUIRED → setup、他は null。next は encodeURIComponent', () => {
    expect(mfaRedirectPathFor('AUTH_2FA_REQUIRED', NEXT)).toBe(`${MFA_PAGE_PATHS.verify}?next=${ENCODED_NEXT}`);
    expect(mfaRedirectPathFor('AUTH_2FA_ENROLLMENT_REQUIRED', NEXT)).toBe(`${MFA_PAGE_PATHS.setup}?next=${ENCODED_NEXT}`);
    expect(mfaRedirectPathFor('PERM_DENIED', NEXT)).toBeNull();
    expect(mfaRedirectPathFor('AUTH_ACCOUNT_FROZEN', NEXT)).toBeNull();
    expect(MFA_PAGE_PATHS).toEqual({
      status: '/settings/security/mfa',
      setup: '/settings/security/mfa/setup',
      verify: '/settings/security/mfa/verify',
      recover: '/settings/security/mfa/recover',
    });
  });
});

describe('requireRoleForPage', () => {
  it('requireRoleForPage: AuthError → /login?next=、MfaRequiredError → MFA の画面、PERM_DENIED → /login、通れば UserProfile', async () => {
    h.requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    await expect(requireRoleForPage(['admin'], { next: NEXT })).rejects.toThrow(`NEXT_REDIRECT:/login?next=${ENCODED_NEXT}`);

    h.requireRole.mockRejectedValueOnce(new MfaRequiredError('AUTH_2FA_REQUIRED'));
    await expect(requireRoleForPage(['admin'], { next: NEXT })).rejects.toThrow(
      `NEXT_REDIRECT:${MFA_PAGE_PATHS.verify}?next=${ENCODED_NEXT}`,
    );

    h.requireRole.mockRejectedValueOnce(new MfaRequiredError('AUTH_2FA_ENROLLMENT_REQUIRED'));
    await expect(requireRoleForPage(['admin'], { next: NEXT })).rejects.toThrow(
      `NEXT_REDIRECT:${MFA_PAGE_PATHS.setup}?next=${ENCODED_NEXT}`,
    );

    h.requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED'));
    await expect(requireRoleForPage(['admin'], { next: NEXT })).rejects.toThrow(`NEXT_REDIRECT:${PAGE_FORBIDDEN_DEFAULT_PATH}`);
    expect(PAGE_FORBIDDEN_DEFAULT_PATH).toBe('/login');

    const profile = { id: 'u-1', roles: ['admin'] };
    h.requireRole.mockResolvedValueOnce(profile);
    await expect(requireRoleForPage(['admin', 'super_admin'], { next: NEXT })).resolves.toBe(profile);
    // requireRole は第 2 引数なし (既定 = aal2) で呼ぶ
    expect(h.requireRole).toHaveBeenLastCalledWith(['admin', 'super_admin']);
  });

  it('requireRoleForPage: forbiddenPath を渡すと PERM_DENIED / AUTH_ACCOUNT_FROZEN はそこへ回し、MfaRequiredError と AuthError の行き先は変わらない', async () => {
    const options = { next: '/support', forbiddenPath: '/home' };
    h.requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED'));
    await expect(requireRoleForPage(['support'], options)).rejects.toThrow('NEXT_REDIRECT:/home');
    h.requireRole.mockRejectedValueOnce(new ForbiddenError('AUTH_ACCOUNT_FROZEN'));
    await expect(requireRoleForPage(['support'], options)).rejects.toThrow('NEXT_REDIRECT:/home');
    h.requireRole.mockRejectedValueOnce(new MfaRequiredError('AUTH_2FA_REQUIRED'));
    await expect(requireRoleForPage(['support'], options)).rejects.toThrow(
      `NEXT_REDIRECT:${MFA_PAGE_PATHS.verify}?next=%2Fsupport`,
    );
    h.requireRole.mockRejectedValueOnce(new AuthError('AUTH_PROFILE_NOT_FOUND'));
    await expect(requireRoleForPage(['support'], options)).rejects.toThrow('NEXT_REDIRECT:/login?next=%2Fsupport');
  });

  it('requireRoleForPage: 認可の例外でないもの (DB の失敗など) はそのまま投げる', async () => {
    const boom = new Error('boom');
    h.requireRole.mockRejectedValueOnce(boom);
    await expect(requireRoleForPage(['admin'], { next: NEXT })).rejects.toBe(boom);
  });
});
