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
import { PERMANENT_FREEZE_LABEL } from '@/lib/admin/freeze-labels';
import { OPERATOR_ROLE_LABELS, SUPER_ADMIN_ONLY_NOTE } from '@/lib/admin/operator-role-labels';

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
export const BAN_INTERNAL_ERROR_MESSAGE = '凍結に失敗しました';

/**
 * 凍結の UPDATE の条件に使う、super_admin だけを持つ roles の配列のリテラル (PostgREST の cs の値)。
 * 凍結は「読んで確かめた、super_admin でない」のままのときだけ書く: 読んだ roles が NULL なら roles が NULL のまま (.is('roles', null))、
 * そうでなければ roles が super_admin を含まないまま (.not('roles', 'cs', SUPER_ADMIN_ROLES_LITERAL))。読んでから書くまでに別の運営が
 * 対象を super_admin にしていたら 0 行になり、凍結しない (applyUserBan と POST /api/admin/users/{id}/freeze が使う)。
 * PostgREST の or (roles.is.null,roles.not.cs.{…}) は UPDATE で 42703 (column user_profiles.roles does not exist) になるので使わない
 */
export const SUPER_ADMIN_ROLES_LITERAL = '{super_admin}';

/** 読んだ roles が NULL か (NULL なら、凍結の条件は roles が NULL のまま) */
export function isNullRoles(roles: unknown): boolean {
  return roles === null || roles === undefined;
}

function hasSuperAdminRole(roles: unknown): boolean {
  return Array.isArray(roles) && roles.includes('super_admin');
}

/**
 * 運営の画面 (凍結・審査のフォーム) が API の本文の文をそのまま出すので、ロールの呼び名は運営の画面の表示名
 * (src/lib/admin/operator-role-labels.ts) の語にそろえる (#2134 U1-1)。操作の呼び名は「凍結」の系 (src/lib/admin/freeze-labels.ts。#2183 Z4)
 */
/** 対象が super_admin のとき凍結を断る文 (POST /api/admin/users/{id}/freeze の 403 OP_TARGET_PROTECTED) */
export const SUPER_ADMIN_FREEZE_REJECTED_MESSAGE = `${OPERATOR_ROLE_LABELS.super_admin}のユーザーは凍結できません`;
/** 審査の凍結 (applyUserBan) で対象が super_admin のときの文。凍結の route と同じ文 */
export const SUPER_ADMIN_BAN_REJECTED_MESSAGE = SUPER_ADMIN_FREEZE_REJECTED_MESSAGE;
/** super_admin でない運営が無期限凍結 (permanent) を求めたときの文 (凍結の route と審査の route の 403 OP_PERMISSION_DENIED) */
export const PERMANENT_BAN_SUPER_ADMIN_ONLY_MESSAGE = `${PERMANENT_FREEZE_LABEL}は${SUPER_ADMIN_ONLY_NOTE}実行できます`;
const BAN_TARGET_NOT_FOUND_MESSAGE = '凍結の対象のユーザーが見つかりません';

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
 * super_admin ユーザーは BAN 対象から除外する (freeze route と同じ保護)。読んで確かめた後で super_admin に
 * なっていたら書かない (更新を SUPER_ADMIN_ROLES_LITERAL の説明の条件つきにし、0 行なら読み直して kind を決める)。
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
    return { success: false, unbanAt: null, error: BAN_TARGET_NOT_FOUND_MESSAGE, kind: 'not_found' };
  }

  const readRoles = (profile as { roles?: unknown }).roles;
  if (hasSuperAdminRole(readRoles)) {
    return { success: false, unbanAt: null, error: SUPER_ADMIN_BAN_REJECTED_MESSAGE, kind: 'super_admin' };
  }

  let unbanAt: string | null = null;
  if (banType === 'temporary' && durationDays) {
    const unbanDate = new Date();
    unbanDate.setDate(unbanDate.getDate() + durationDays);
    unbanAt = unbanDate.toISOString();
  }

  // 読んで確かめた「super_admin でない」のままのときだけ書く (SUPER_ADMIN_ROLES_LITERAL の説明)
  const freezeUpdate = supabaseAdmin
    .from('user_profiles')
    .update({
      frozen_at: new Date().toISOString(),
      frozen_reason: reason,
      frozen_by: actorId,
      unban_at: unbanAt,
    } as Record<string, unknown>)
    .eq('id', userId);
  const { data: frozen, error: updateError } = await (isNullRoles(readRoles)
    ? freezeUpdate.is('roles', null)
    : freezeUpdate.not('roles', 'cs', SUPER_ADMIN_ROLES_LITERAL)
  )
    .select('id')
    .maybeSingle();

  if (updateError) {
    return { success: false, unbanAt: null, error: BAN_INTERNAL_ERROR_MESSAGE, kind: 'internal', cause: updateError };
  }

  if (!frozen) {
    // 0 行: 読んでから書くまでに、対象が super_admin になった (または消えた)。読み直して理由を決める
    const { data: current, error: rereadError } = await supabaseAdmin
      .from('user_profiles')
      .select('id, roles')
      .eq('id', userId)
      .maybeSingle();
    if (rereadError) {
      return { success: false, unbanAt: null, error: BAN_INTERNAL_ERROR_MESSAGE, kind: 'internal', cause: rereadError };
    }
    if (!current) {
      return { success: false, unbanAt: null, error: BAN_TARGET_NOT_FOUND_MESSAGE, kind: 'not_found' };
    }
    if (hasSuperAdminRole((current as { roles?: unknown }).roles)) {
      return { success: false, unbanAt: null, error: SUPER_ADMIN_BAN_REJECTED_MESSAGE, kind: 'super_admin' };
    }
    // super_admin ではないが、読んでから roles が変わった (NULL だった roles に値が入った・super_admin にされてから外された等)。
    // 書いていないので失敗として返す
    return {
      success: false,
      unbanAt: null,
      error: BAN_INTERNAL_ERROR_MESSAGE,
      kind: 'internal',
      cause: new Error('凍結の条件つきの更新が 0 行で、読み直した対象は super_admin ではなかった (読んでから書くまでに roles が変わった)'),
    };
  }

  return { success: true, unbanAt };
}
