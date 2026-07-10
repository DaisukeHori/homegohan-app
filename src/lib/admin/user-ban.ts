/**
 * ユーザー BAN (凍結) 適用ヘルパー
 *
 * #1041 round-2 (D) 修正: モデレーション経由の BAN が `admin_set_user_roles` で
 * `user_profiles.roles` に文字列 `'banned'` を追加するだけの実装だった。
 * `'banned'` は公式 12 ロール外であり (`20260508130000_user_profiles_frozen_at.sql`
 * に明記)、アプリ内のどこからも読まれない。`/admin/users` の `is_banned` は
 * `frozen_at` のみから算出されるため、BAN 適用が管理画面に一切反映されず
 * 偽成功になっていた。
 *
 * `/api/admin/users/[id]/freeze` (POST/DELETE) と同じ
 * `frozen_at`/`frozen_reason`/`frozen_by` 更新機構に統一する。
 *
 * 呼び出し側は必ず authz (requireRole 等) を通した後に、service-role
 * クライアント (`getSupabaseAdmin()`) を渡すこと (user_profiles の他ユーザー
 * 行の更新は RLS で拒否されるため)。
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type BanType = 'temporary' | 'permanent';

export interface ApplyUserBanParams {
  /** BAN 対象ユーザー (コンテンツ所有者。通報者ではない) */
  userId: string;
  /** 実行者 (frozen_by に記録) */
  actorId: string;
  banType: BanType;
  /** frozen_reason に記録する理由文字列 */
  reason: string;
  /** temporary の場合の凍結日数。permanent では無視される */
  durationDays?: number | null;
}

export interface ApplyUserBanResult {
  success: boolean;
  /**
   * temporary BAN の解除予定日時 (呼び出し側の監査ログ記録用)。
   * 注意: この値を永続化する列は存在しない (freeze route と同じ制約、要 migration)。
   * 自動解除バッチは無いため、運用者が手動で unfreeze する必要がある。
   */
  unbanAt: string | null;
  error?: string;
}

/**
 * 対象ユーザーの frozen_at/frozen_reason/frozen_by を更新して BAN を適用する。
 * super_admin ユーザーは BAN 対象から除外する (freeze route と同じ保護)。
 *
 * @param supabaseAdmin service-role クライアント (呼び出し側で authz 済みであること)
 */
export async function applyUserBan(
  supabaseAdmin: SupabaseClient<any>,
  params: ApplyUserBanParams,
): Promise<ApplyUserBanResult> {
  const { userId, actorId, banType, reason, durationDays } = params;

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .select('id, roles')
    .eq('id', userId)
    .maybeSingle();

  if (profileError) {
    return { success: false, unbanAt: null, error: profileError.message };
  }
  if (!profile) {
    return { success: false, unbanAt: null, error: 'BAN 対象ユーザーが見つかりません' };
  }

  const roles = (profile as { roles?: unknown }).roles;
  if (Array.isArray(roles) && roles.includes('super_admin')) {
    return { success: false, unbanAt: null, error: 'super_admin ユーザーを BAN することはできません' };
  }

  const { error: updateError } = await supabaseAdmin
    .from('user_profiles')
    .update({
      frozen_at: new Date().toISOString(),
      frozen_reason: reason,
      frozen_by: actorId,
    } as Record<string, unknown>)
    .eq('id', userId);

  if (updateError) {
    return { success: false, unbanAt: null, error: updateError.message };
  }

  let unbanAt: string | null = null;
  if (banType === 'temporary' && durationDays) {
    const unbanDate = new Date();
    unbanDate.setDate(unbanDate.getDate() + durationDays);
    unbanAt = unbanDate.toISOString();
  }

  return { success: true, unbanAt };
}
