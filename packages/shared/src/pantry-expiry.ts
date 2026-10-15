/**
 * 食品 (食品庫・冷蔵庫の食材) の期限の判定 (#1602)。
 *
 * 「期限切れ」「期限間近」の判定を Web の全画面でこの 1 か所にまとめる (モバイルの食材・献立の画面も使っていたが、#1598 で消した)。
 * 日付の比べ方は #1594 で揃えた JST の暦日のまま: 期限 (YYYY-MM-DD) と今日 (todayLocal = 日本の暦日) を暦日どうしで比べる。
 * 4 桁の年の YYYY-MM-DD どうしは、文字列の大小が日付の前後と同じ。
 */
import { addDaysToDate, isCalendarDate } from './date-utils';

/**
 * 「期限間近」とみなす期限の範囲 (今日から何日後の期限までか。今日が期限のものも含む) (#1602)。
 * 食品庫・ホーム・週の献立・AI 相談の (Web の) 全画面でこの値を使う
 * (以前はモバイルの献立の食材の表示だけ 1 日以内で、ほかは 3 日以内だった。3 日に揃えた。その画面は #1598 で消した)。
 */
export const PANTRY_EXPIRING_SOON_DAYS = 3;

/** 食品の期限の状態。expired = 期限が今日より前 / expiringSoon = 今日から PANTRY_EXPIRING_SOON_DAYS 日後まで / normal = それ以外 (期限なし・日付でない値も含む) */
export type PantryExpiryStatus = 'expired' | 'expiringSoon' | 'normal';

/**
 * 「期限間近」の範囲の最後の日 (今日 + PANTRY_EXPIRING_SOON_DAYS 日。この日が期限のものまで期限間近)。
 * DB の expiration_date を lte で絞るときにも使う。
 * today は todayLocal() などで求めた日本の暦日 (YYYY-MM-DD)。日付でない値を渡すと addDaysToDate が RangeError にする。
 */
export function pantryExpiringSoonUntil(today: string): string {
  return addDaysToDate(today, PANTRY_EXPIRING_SOON_DAYS);
}

/**
 * 期限 (YYYY-MM-DD) を、今日 (日本の暦日 YYYY-MM-DD) と比べて「期限切れ / 期限間近 / それ以外」に分ける (#1602)。
 *   - 期限が今日より前 → expired (期限の日のうちは期限切れにしない)
 *   - 期限が今日〜今日 + PANTRY_EXPIRING_SOON_DAYS 日 (両端を含む) → expiringSoon
 *   - それより後・期限なし・日付になっていない値 → normal
 * today は画面の今日 (todayLocal()) を渡す。
 */
export function classifyPantryExpiry(expirationDate: unknown, today: string): PantryExpiryStatus {
  if (!isCalendarDate(expirationDate)) return 'normal';
  if (expirationDate < today) return 'expired';
  if (expirationDate <= pantryExpiringSoonUntil(today)) return 'expiringSoon';
  return 'normal';
}
