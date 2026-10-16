/**
 * 運営管理者 (operator) 権限定義
 * docs/design/membership/05-operator-emergency-ui.md §1 準拠
 */

import { createClient } from '@/lib/supabase/server';
import { requireRole } from './helpers';

// ─────────────────────────────────────────────────────────────────────────────
// 権限定義
// ─────────────────────────────────────────────────────────────────────────────

export type OperatorPermission =
  | 'membership:org:transfer'        // org owner 強制譲渡
  | 'membership:org:dissolve'        // org 強制解散
  | 'membership:family:transfer'     // family 代表強制譲渡
  | 'membership:family:dissolve'     // family 強制解散
  | 'membership:audit:read';         // 監査ログ閲覧

export const SUPER_ADMIN_PERMISSIONS: OperatorPermission[] = [
  'membership:org:transfer',
  'membership:org:dissolve',
  'membership:family:transfer',
  'membership:family:dissolve',
  'membership:audit:read',
];

/**
 * ロール配列と要求パーミッションから操作可否を判定する。
 * super_admin はすべての操作が可能。
 * admin は監査ログ閲覧のみ可能。
 */
export function canOperate(roles: string[], permission: OperatorPermission): boolean {
  if (roles.includes('super_admin')) return true;
  if (roles.includes('admin') && permission === 'membership:audit:read') return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// サーバーサイド ヘルパー
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 現在の認証ユーザーが super_admin かどうかを確認する。
 * API Route ハンドラの冒頭で呼び出す。
 * requireRole(['super_admin']) に委ねる (#1176。docs/design/cross/12-operator-mfa.md §13.5): 凍結判定と AAL2 の判定が付く。
 * 未認証なら AuthError (401)、権限不足・凍結・2FA 未完了なら ForbiddenError (派生の MfaRequiredError を含む。403) を throw する。
 */
export async function requireSuperAdmin(): Promise<{ userId: string }> {
  const profile = await requireRole(['super_admin']);
  return { userId: profile.id };
}

/**
 * 指定 userId が super_admin かどうかを boolean で返す。
 * Server Component や Server Action から使用する。
 */
export async function isSuperAdmin(userId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', userId)
    .single();

  if (!profile) return false;
  const roles: string[] = (profile.roles ?? []) as string[];
  return roles.includes('super_admin');
}
