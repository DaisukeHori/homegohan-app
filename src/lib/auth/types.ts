import type { OperatorAssuranceSummary } from './mfa/policy';

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
  /**
   * 運営の入口の AAL2 の判定の要約 (#1176。docs/design/cross/12-operator-mfa.md §13.1)。
   * requireRole が既定 (assurance: 'aal2') で通したときだけ入る。{ assurance: 'session' } のときと、テストで作るリテラルは undefined
   */
  assurance?: OperatorAssuranceSummary;
}
