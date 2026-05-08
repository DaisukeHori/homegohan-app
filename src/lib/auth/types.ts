/**
 * 公式ロール (operator §7.1.1、cross/02 §B、12 種固定)
 * 新規追加は禁止 (要件で確定済み)
 */
export type RoleName =
  | 'user'
  | 'support'
  | 'sales'
  | 'finance'
  | 'content_moderator'
  | 'org_member'
  | 'org_viewer'
  | 'org_manager'
  | 'org_admin'
  | 'org_industrial_doctor'
  | 'admin'
  | 'super_admin';

/**
 * org_ プレフィックスを持つロール (組織スコープ確認で使用)
 */
export type OrgRoleName = Extract<RoleName, `org_${string}`>;

/**
 * requireRole の戻り値型 - Supabase User + roles を付加
 */
export interface UserProfile {
  id: string;
  email?: string;
  roles: RoleName[];
  organization_id?: string | null;
}

/**
 * impersonate の戻り値型
 */
export interface ImpersonationResult {
  impersonation_token: string;
  expires_at: string;
}
