/**
 * 運営の layout / page (Server Component) の入口 (#1176。docs/design/cross/12-operator-mfa.md §13.4)
 *
 * requireRole と同じ判定をし、失敗したら redirect() する (戻らない)。運営の layout / page は requireRole を直接呼ばず、
 * 必ず requireRoleForPage を呼ぶ (tests/operator-mfa-entry-points-scan.test.ts の ④)。
 * サーバー専用 (@/lib/auth/helpers を import する)。client component は MFA_PAGE_PATHS を import できないので、
 * 画面は同じ文字列を自分で書く (§15.1)。
 */
import { redirect } from 'next/navigation';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { requireRole, type RoleName, type UserProfile } from '@/lib/auth/helpers';

/** 自己サービスの画面 (Web)。next を付けて回す */
export const MFA_PAGE_PATHS = {
  status: '/settings/security/mfa',
  setup: '/settings/security/mfa/setup',
  verify: '/settings/security/mfa/verify',
  recover: '/settings/security/mfa/recover',
} as const;

/** 2FA 未完了の code → 回す先。それ以外は null */
export function mfaRedirectPathFor(code: string, next: string): string | null {
  const query = `?next=${encodeURIComponent(next)}`;
  if (code === 'AUTH_2FA_REQUIRED') return `${MFA_PAGE_PATHS.verify}${query}`;
  if (code === 'AUTH_2FA_ENROLLMENT_REQUIRED') return `${MFA_PAGE_PATHS.setup}${query}`;
  return null;
}

/** ロール不足・凍結 (2FA 以外の 403) のときの既定の行き先 (運営の layout / page の現行の挙動) */
export const PAGE_FORBIDDEN_DEFAULT_PATH = '/login';

export interface RequireRoleForPageOptions {
  /** 認証・2FA の画面から戻る先 (この画面のパス。同一オリジンの相対パスだけ) */
  next: string;
  /** 2FA 以外の 403 (ロール不足・凍結) のときの行き先。省略時は PAGE_FORBIDDEN_DEFAULT_PATH。(support) 区画は今の client の判定と同じ '/home' を渡す */
  forbiddenPath?: string;
}

/**
 * Server Component (layout / page) の入口。requireRole と同じ判定をし、失敗したら redirect() する (戻らない)。
 *   未認証 (AuthError)            → /login?next=<next>
 *   2FA 未完了 (MfaRequiredError) → /settings/security/mfa/{verify|setup}?next=<next>
 *   それ以外の 403 (ForbiddenError) → forbiddenPath (既定 /login。現行の挙動を保つ。super-admin と (operator) の layout は今の行き先を渡す: cross/12 §13.4.2)
 * 運営の layout / page は requireRole を直接呼ばず、必ずこれを呼ぶ (走査 ④)。
 */
export async function requireRoleForPage(
  allowedRoles: ReadonlyArray<RoleName>,
  options: RequireRoleForPageOptions,
): Promise<UserProfile> {
  try {
    return await requireRole(allowedRoles);
  } catch (err) {
    if (err instanceof AuthError) redirect(`/login?next=${encodeURIComponent(options.next)}`);
    if (err instanceof ForbiddenError) {
      redirect(mfaRedirectPathFor(err.code, options.next) ?? options.forbiddenPath ?? PAGE_FORBIDDEN_DEFAULT_PATH);
    }
    throw err;
  }
}
