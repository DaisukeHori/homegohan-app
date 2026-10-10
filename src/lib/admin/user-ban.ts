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
 * #1030 修正: 一時 BAN の解除予定日時 (`unbanAt`) を `user_profiles.unban_at`
 * (20260710210030 migration で追加) に永続化する。従来は監査ログにしか
 * 記録されず、判定時比較による自動解除が不可能だった。
 *
 * #1172: DB の読み書きに失敗したとき、error には DB の生のエラー文ではなく固定の文を入れる
 * (呼び出し側がそのまま応答の本文に入れても漏れないように)。元のエラーは cause に入る。
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

/**
 * BAN できなかった理由の種類 (#1172)。
 *   - 'internal': DB の読み書きに失敗した。error は固定の文 (BAN_INTERNAL_ERROR_MESSAGE)。元のエラーは cause にだけ入る
 *   - 'not_found' / 'super_admin': こちらで決めた規則で断った。error はこちらが書いた文なので、そのまま利用者に見せてよい
 */
export type ApplyUserBanFailureKind = 'internal' | 'not_found' | 'super_admin';

/** DB の読み書きに失敗したときの error (固定の文)。DB の生のエラー文は応答の本文に出さない (#1172) */
export const BAN_INTERNAL_ERROR_MESSAGE = 'BAN の適用に失敗しました';

export interface ApplyUserBanResult {
  success: boolean;
  /**
   * temporary BAN の解除予定日時 (呼び出し側の監査ログ記録用)。
   * #1030: `user_profiles.unban_at` にも永続化されるため、requireUser/
   * requireRole/middleware の判定時比較により unban_at 経過後は自動的に
   * アクセスが回復する。
   */
  unbanAt: string | null;
  /** 失敗したときの、利用者に見せてよい文 (DB の生のエラー文は入らない) */
  error?: string;
  /** 失敗したときの理由の種類 */
  kind?: ApplyUserBanFailureKind;
  /**
   * kind が 'internal' のときだけ入る、DB が返した元のエラー (supabase-js のエラーオブジェクト)。
   * 呼び出し側は構造化ログ・監査ログにだけ残し、応答の本文には入れない
   */
  cause?: unknown;
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
    return { success: false, unbanAt: null, error: BAN_INTERNAL_ERROR_MESSAGE, kind: 'internal', cause: profileError };
  }
  if (!profile) {
    return { success: false, unbanAt: null, error: 'BAN 対象ユーザーが見つかりません', kind: 'not_found' };
  }

  const roles = (profile as { roles?: unknown }).roles;
  if (Array.isArray(roles) && roles.includes('super_admin')) {
    return {
      success: false,
      unbanAt: null,
      error: 'super_admin ユーザーを BAN することはできません',
      kind: 'super_admin',
    };
  }

  let unbanAt: string | null = null;
  if (banType === 'temporary' && durationDays) {
    const unbanDate = new Date();
    unbanDate.setDate(unbanDate.getDate() + durationDays);
    unbanAt = unbanDate.toISOString();
  }

  const { error: updateError } = await supabaseAdmin
    .from('user_profiles')
    .update({
      frozen_at: new Date().toISOString(),
      frozen_reason: reason,
      frozen_by: actorId,
      unban_at: unbanAt,
    } as Record<string, unknown>)
    .eq('id', userId);

  if (updateError) {
    return { success: false, unbanAt: null, error: BAN_INTERNAL_ERROR_MESSAGE, kind: 'internal', cause: updateError };
  }

  return { success: true, unbanAt };
}
