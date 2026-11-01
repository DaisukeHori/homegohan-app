/**
 * 利用者の凍結の呼び名 (運営の画面と、その画面がそのまま出す API の文で使う語)。#2183 Z4
 *
 * 凍結の画面の見出し「ユーザー凍結」(#2178 Y2) と同じ「凍結」の系にそろえ、英字の BAN は画面・API の文に出さない
 * (tests/ops-ban-wording-2183.test.tsx がソースの文字を走査して確かめる)。
 * 内部の鍵 (ban_type・delete_and_temp_ban / delete_and_perm_ban・ban_duration_days・監査の admin.user.ban・定数名・
 * API の JSON の鍵) は画面の語ではないので変えない。
 */

/** 凍結のフォームの「種類」の欄名 (ban_type の欄) */
export const FREEZE_TYPE_LABEL = '凍結の種類';
/** 期間つきの凍結 (ban_type = temporary・審査の delete_and_temp_ban) */
export const TEMPORARY_FREEZE_LABEL = '一時凍結';
/** 期間の無い凍結 (ban_type = permanent・審査の delete_and_perm_ban)。利用者へのメールの「無期限の凍結」と同じ語 */
export const PERMANENT_FREEZE_LABEL = '無期限凍結';
/** 一時凍結の日数の欄名 (凍結のフォームの duration_days・審査のフォームの ban_duration_days) */
export const FREEZE_DURATION_DAYS_LABEL = '凍結の期間 (日数)';

/** 一時凍結の日数が範囲の外・整数でないときの文 */
export function freezeDurationDaysRangeMessage(min: number, max: number): string {
  return `凍結の期間は ${min}〜${max} の整数 (日数) で入力してください`;
}

/** 凍結のフォームで無期限凍結にできたときの文 */
export const PERMANENT_FREEZE_DONE_MESSAGE = '無期限で凍結しました';

/** 凍結のフォームで一時凍結にできたときの文 */
export function temporaryFreezeDoneMessage(days: number): string {
  return `${days} 日間凍結しました`;
}

/** 審査のフォームで、判定に伴って投稿者を凍結できたときの文 (応答の ban_applied が true) */
export const CONTENT_OWNER_FROZEN_MESSAGE = '投稿者を凍結しました';
