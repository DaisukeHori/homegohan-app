/**
 * 運営管理者 (operator) 権限定義
 * docs/design/membership/05-operator-emergency-ui.md §1 準拠
 */

import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from './errors';

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
 * 未認証なら AuthError (401)、権限不足なら ForbiddenError (403) を throw する。
 */
export async function requireSuperAdmin(): Promise<{ userId: string }> {
  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    throw new AuthError('AUTH_UNAUTHENTICATED', '認証が必要です');
  }

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    throw new AuthError('AUTH_PROFILE_NOT_FOUND', 'プロフィールが見つかりません');
  }

  const roles: string[] = (profile.roles ?? []) as string[];
  if (!roles.includes('super_admin')) {
    throw new ForbiddenError('PERM_DENIED', 'super_admin 権限が必要です');
  }

  return { userId: user.id };
}

/**
 * 指定 userId が super_admin かどうかを boolean で返す。
 * Server Component や Server Action から使用する。
 */
export async function isSuperAdmin(userId: string): Promise<boolean> {
  const supabase = createClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('roles')
    .eq('id', userId)
    .single();

  if (!profile) return false;
  const roles: string[] = (profile.roles ?? []) as string[];
  return roles.includes('super_admin');
}
