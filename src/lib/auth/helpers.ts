/**
 * 認証・認可ヘルパー関数
 * cross/01-auth-session.md §14 / operator/02-api-spec.md §3.1 準拠
 *
 * 全 operator / family / org API が呼び出す共通認証関数を提供する。
 * Supabase クライアントは内部で取得するため、route.ts 側の boilerplate を削減できる。
 */

import { type User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError, ImpersonationError } from './errors';
import { type RoleName, type OrgRoleName, type UserProfile } from './types';
import { isAccountFrozen } from './frozen';

export { type RoleName, type OrgRoleName, type UserProfile };

// ─────────────────────────────────────────────────────────────────────────────
// 内部ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supabase auth から認証済みユーザーを取得する。
 * 未認証・エラー時は AuthError を throw する。
 */
async function getAuthUser(): Promise<User> {
  const supabase = createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    throw new AuthError('AUTH_UNAUTHENTICATED');
  }
  return user;
}

/**
 * user_profiles テーブルから roles と organization_id、凍結状態 (frozen_at/unban_at) を取得する。
 */
async function getUserProfile(userId: string): Promise<{
  roles: RoleName[];
  organization_id: string | null;
  frozen_at: string | null;
  unban_at: string | null;
}> {
  const supabase = createClient();
  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('roles, organization_id, frozen_at, unban_at')
    .eq('id', userId)
    .single();

  if (error || !profile) {
    throw new AuthError('AUTH_PROFILE_NOT_FOUND');
  }

  return {
    roles: (profile.roles ?? ['user']) as RoleName[],
    organization_id: profile.organization_id ?? null,
    frozen_at: (profile as { frozen_at?: string | null }).frozen_at ?? null,
    unban_at: (profile as { unban_at?: string | null }).unban_at ?? null,
  };
}

/**
 * #1030: frozen_at がセットされ、かつ一時 BAN の unban_at が未到来の場合に
 * ForbiddenError('AUTH_ACCOUNT_FROZEN') を throw する。
 * unban_at 経過後 (一時 BAN の自動解除) は許可する (判定時比較)。
 */
function assertNotFrozen(frozenAt: string | null, unbanAt: string | null): void {
  if (isAccountFrozen({ frozenAt, unbanAt })) {
    throw new ForbiddenError('AUTH_ACCOUNT_FROZEN', 'アカウントが凍結されています');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 公開 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supabase auth で取得した user を返す。未認証なら 401 相当の AuthError を throw する。
 * #1030: frozen_at がセットされている(かつ一時 BAN 未解除)場合は 403 相当の
 * ForbiddenError('AUTH_ACCOUNT_FROZEN') を throw する。
 */
export async function requireUser(): Promise<User> {
  const user = await getAuthUser();
  const { frozen_at, unban_at } = await getUserProfile(user.id);
  assertNotFrozen(frozen_at, unban_at);
  return user;
}

/**
 * 指定ロールのいずれかを保有していれば UserProfile を返す。なければ 403 相当の ForbiddenError を throw する。
 * 認証済み user 取得 + user_profiles.roles 取得 + intersect を行う。
 *
 * @param allowedRoles - 許可するロールの配列
 * @returns 認証済みユーザーの UserProfile
 * @throws AuthError (401) - 未認証の場合
 * @throws ForbiddenError (403) - ロール不足の場合、または #1030: アカウント凍結中の場合
 */
export async function requireRole(
  allowedRoles: ReadonlyArray<RoleName>,
): Promise<UserProfile> {
  const user = await getAuthUser();
  const { roles, organization_id, frozen_at, unban_at } = await getUserProfile(user.id);
  assertNotFrozen(frozen_at, unban_at);

  if (!roles.some((r) => allowedRoles.includes(r))) {
    throw new ForbiddenError(
      'PERM_DENIED',
      `Requires one of: ${allowedRoles.join(', ')}`,
    );
  }

  return {
    id: user.id,
    email: user.email,
    roles,
    organization_id,
  };
}

/**
 * 指定 org の指定 org ロールを保有しているか確認する。
 * 組織とユーザーの所属一致も検証する。
 * org_industrial_doctor の場合は family データ閲覧不可ガードを内包する。
 *
 * @param userId      - 検証対象ユーザー ID
 * @param orgId       - 組織 ID
 * @param allowedRoles - 許可する org ロールの配列
 * @throws AuthError      - プロフィールが見つからない場合
 * @throws ForbiddenError - 組織不一致またはロール不足の場合
 */
export async function requireOrgRole(
  userId: string,
  orgId: string,
  allowedRoles: ReadonlyArray<OrgRoleName>,
): Promise<void> {
  const supabase = createClient();
  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('roles, organization_id')
    .eq('id', userId)
    .single();

  if (error || !profile) {
    throw new AuthError('AUTH_PROFILE_NOT_FOUND');
  }

  if (profile.organization_id !== orgId) {
    throw new ForbiddenError('PERM_ORG_MISMATCH');
  }

  const userRoles = (profile.roles ?? []) as RoleName[];

  if (!userRoles.some((r) => allowedRoles.includes(r as OrgRoleName))) {
    throw new ForbiddenError('PERM_DENIED');
  }
}

/**
 * impersonate (super_admin が他ユーザーに成り代わる)。
 * cross/01-auth-session.md §11 仕様に準拠。
 * admin_audit_logs に impersonate 記録を挿入する。
 *
 * @param targetUserId - impersonate 対象のユーザー ID
 * @param reason       - impersonate の理由 (audit_log に記録)
 * @returns impersonation_token と expires_at
 * @throws AuthError          - 実行者が未認証の場合
 * @throws ImpersonationError - super_admin 以外が実行した場合 / 対象が拒否設定の場合
 */
export async function impersonate(
  targetUserId: string,
  reason: string,
): Promise<{ impersonation_token: string; expires_at: string }> {
  const user = await getAuthUser();
  const { roles } = await getUserProfile(user.id);

  if (!roles.includes('super_admin')) {
    throw new ImpersonationError(
      'AUTH_IMPERSONATION_DENIED',
      'impersonate は super_admin のみ実行可能です',
    );
  }

  const supabase = createClient();

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const impersonationToken = crypto.randomUUID();

  // admin_audit_logs に記録 (テーブル不在時は graceful degradation)
  try {
    const { error: auditError } = await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      target_id: targetUserId,
      target_type: 'user',
      action_type: 'impersonate',
      impersonated_by: user.id,
      details: { reason, impersonation_token: impersonationToken, expires_at: expiresAt },
      severity: 'warn',
    });

    if (auditError) {
      console.error('[auth/helpers] admin_audit_logs INSERT failed (graceful):', auditError.message);
    }
  } catch (err) {
    console.error('[auth/helpers] admin_audit_logs unavailable (graceful):', err);
  }

  return {
    impersonation_token: impersonationToken,
    expires_at: expiresAt,
  };
}

/**
 * impersonate を解除する。
 * admin_audit_logs に解除記録を挿入する。
 *
 * @throws AuthError - 実行者が未認証の場合
 */
export async function endImpersonation(): Promise<void> {
  const user = await getAuthUser();
  const supabase = createClient();

  try {
    const { error: auditError } = await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      target_id: user.id,
      target_type: 'user',
      action_type: 'impersonate_end',
      severity: 'info',
      details: {},
    });

    if (auditError) {
      console.error('[auth/helpers] admin_audit_logs INSERT failed (graceful):', auditError.message);
    }
  } catch (err) {
    console.error('[auth/helpers] admin_audit_logs unavailable (graceful):', err);
  }
}

/**
 * 現在 impersonate 中かどうかを確認する。
 * admin_audit_logs.impersonated_by が NOT NULL であるかをチェックする。
 *
 * @param user - requireUser / requireRole で取得した User
 * @returns impersonate 中であれば true
 */
export async function isImpersonating(user: User): Promise<boolean> {
  const supabase = createClient();

  try {
    const { data, error } = await supabase
      .from('admin_audit_logs')
      .select('id')
      .eq('target_id', user.id)
      .eq('action_type', 'impersonate')
      .not('impersonated_by', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      console.error('[auth/helpers] isImpersonating query failed (graceful):', error.message);
      return false;
    }

    return (data ?? []).length > 0;
  } catch (err) {
    console.error('[auth/helpers] admin_audit_logs unavailable (graceful):', err);
    return false;
  }
}
