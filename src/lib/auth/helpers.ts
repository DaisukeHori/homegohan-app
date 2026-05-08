/**
 * 認証ヘルパー (cross/01-auth-session.md §14 準拠)
 * 全 admin / super-admin API route で使用する認可チェック
 */
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from './errors';
import type { RoleName, UserProfile, OrgRoleName } from './types';

export { AuthError, ForbiddenError };

/**
 * ロール検証ヘルパー
 * セッションを取得し、指定ロールのいずれかを持つことを確認する。
 * 条件を満たさない場合は AuthError / ForbiddenError をスローする。
 *
 * @example
 * // super_admin のみ許可
 * const user = await requireRole(['super_admin']);
 *
 * // admin / super_admin を許可
 * const user = await requireRole(['admin', 'super_admin']);
 */
export async function requireRole(allowedRoles: RoleName[]): Promise<UserProfile> {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new AuthError('UNAUTHENTICATED', '認証が必要です');
  }

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('id, roles, organization_id')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    throw new AuthError('PROFILE_NOT_FOUND', 'プロフィールが見つかりません');
  }

  const roles = (profile.roles ?? []) as RoleName[];
  const hasRole = allowedRoles.some((r) => roles.includes(r));
  if (!hasRole) {
    throw new ForbiddenError(
      'OP_PERMISSION_DENIED',
      `必要なロールがありません: ${allowedRoles.join(', ')}`,
    );
  }

  return {
    id: user.id,
    email: user.email,
    roles,
    organization_id: profile.organization_id ?? null,
  };
}

/**
 * 組織ロール検証ヘルパー
 * 指定組織に対して指定ロールを持つことを確認する。
 */
export async function requireOrgRole(
  userId: string,
  orgId: string,
  allowedRoles: OrgRoleName[],
): Promise<void> {
  const supabase = await createClient();

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles, organization_id')
    .eq('id', userId)
    .single();

  const roles = (profile?.roles ?? []) as RoleName[];
  const hasRole = allowedRoles.some((r) => roles.includes(r));
  const sameOrg = profile?.organization_id === orgId;

  if (!hasRole || !sameOrg) {
    throw new ForbiddenError('OP_PERMISSION_DENIED', '組織ロールが不足しています');
  }
}
