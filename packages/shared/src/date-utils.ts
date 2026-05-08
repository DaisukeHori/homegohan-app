/**
 * 日付ユーティリティ（純粋関数）
 *
 * Web / Mobile 共通で使用するタイムゾーン対応の日付ヘルパー。
 * DOM / React Native に依存しない純粋関数のみを置く。
 */

/**
 * 現地時刻（デフォルト Asia/Tokyo）の YYYY-MM-DD を返す。
 * UTC 偏移によるズレを防ぐためにロケール 'sv-SE' を使用する。
 */
export function formatLocalDate(date: Date = new Date(), timeZone = 'Asia/Tokyo'): string {
  return date.toLocaleDateString('sv-SE', { timeZone });
}

/**
 * 現地時刻の今日（YYYY-MM-DD）を返す。
 */
export function todayLocal(timeZone = 'Asia/Tokyo'): string {
  return formatLocalDate(new Date(), timeZone);
}

/**
 * YYYY-MM-DD 形式の文字列を Date に変換する（ローカルタイムとして解釈）。
 */
export function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * 指定した日付に days 日加算した Date を返す。
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}
