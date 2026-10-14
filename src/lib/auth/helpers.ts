/**
 * 認証・認可ヘルパー関数
 * cross/01-auth-session.md §14 / operator/02-api-spec.md §3.1 準拠
 *
 * 全 operator / family / org API が呼び出す共通認証関数を提供する。
 * Supabase クライアントは内部で取得するため、route.ts 側の boilerplate を削減できる。
 */

import { type User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from './errors';
import { type RoleName, type OrgRoleName, type UserProfile } from './types';
import { isAccountFrozen } from './frozen';
import { isOrgAdmin, type OrgAdminRole } from './org-admin';

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
 * 注意: roles 配列の org_* (org_admin など) で判定するため、「組織の管理者」の判定には使わない。
 * roles の org_admin はどの組織で付与されたかを区別できず、脱退・除名でも消えない (#1235)。
 * 組織の管理者 (org_role が owner / admin) は requireOrgAdmin() を使うこと。
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
 * requireOrgAdmin の戻り値。
 * profile は「呼び出した本人」の所属組織の情報で、isOrgAdmin() を通ったあとなので
 * organization_id は必ず string、org_role は owner / admin のどちらか。
 */
export interface OrgAdminContext {
  user: User;
  profile: {
    organization_id: string;
    org_role: OrgAdminRole;
    /** 招待メールの差出人名などに使う。未設定なら null */
    nickname: string | null;
  };
}

/**
 * ログイン中のユーザーが、所属組織の管理者 (user_profiles.org_role が owner / admin) であることを確認する。
 * 組織 (/api/org/*) の管理系 API は、入口でこの関数を呼ぶ (各 route に判定を手書きしない: #1161)。
 *
 * 判定そのものは isOrgAdmin() (src/lib/auth/org-admin.ts) に一本化している。
 * roles 配列の 'org_admin' は見ない。どの組織の管理者かを区別できず、脱退・除名でも消えないため (#1235)。
 * 組織の絞り込みは呼び出し側で profile.organization_id を使って行う (他組織の行を触らせない)。
 *
 * 凍結中のアカウントは、ミドルウェア (lib/supabase/middleware.ts) が API 全体で 403 にするため、ここでは見ない。
 *
 * @returns 認証済みユーザーと、その所属組織・組織内の役割
 * @throws AuthError      (401 相当) - 未認証の場合
 * @throws ForbiddenError (403 相当) - 組織に所属していない、または org_role が owner / admin でない場合
 */
export async function requireOrgAdmin(): Promise<OrgAdminContext> {
  const user = await getAuthUser();

  const supabase = createClient();
  const { data } = await supabase
    .from('user_profiles')
    .select('organization_id, org_role, nickname')
    .eq('id', user.id)
    .single();
  const profile = data as {
    organization_id?: string | null;
    org_role?: string | null;
    nickname?: string | null;
  } | null;

  // プロフィールが無い (取得できなかった) 場合も、組織の管理者ではないものとして 403 にする
  if (!isOrgAdmin(profile)) {
    throw new ForbiddenError('PERM_DENIED', 'owner/admin role required');
  }

  return {
    user,
    profile: {
      organization_id: profile.organization_id,
      org_role: profile.org_role,
      nickname: profile.nickname ?? null,
    },
  };
}
