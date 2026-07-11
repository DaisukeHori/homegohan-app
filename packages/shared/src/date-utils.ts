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

/**
 * 現地時刻（デフォルト Asia/Tokyo）の「今日」から dateStr (YYYY-MM-DD) までの残日数。
 * `new Date(dateStr)` の UTC 解釈によるタイムゾーンずれを避けるため parseLocalDate/todayLocal を使用する。
 * 過去日は負の値、当日は 0 を返す。
 */
export function daysUntilLocal(dateStr: string | null | undefined, timeZone = 'Asia/Tokyo'): number | null {
  if (!dateStr) return null;
  const target = parseLocalDate(dateStr);
  const now = parseLocalDate(todayLocal(timeZone));
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * 賞味期限などの残日数を統一文言に変換する（UI 一貫性 #1053）。
 * 「(0日)」「今日まで」「期限間近」等の混在を解消し、常にこの表記に揃える。
 */
export function formatExpiry(daysLeft: number | null): string {
  if (daysLeft === null) return '';
  if (daysLeft < 0) return '期限切れ';
  if (daysLeft === 0) return '今日まで';
  if (daysLeft === 1) return '明日まで';
  return `あと${daysLeft}日`;
}

/**
 * YYYY-MM-DD を日本語の日付表記に整形する（UI 一貫性 #1053）。
 * `includeYear: false`（デフォルト）では「7月8日」、true では「2026年7月8日」。
 */
export function formatDateJa(dateStr: string, opts: { includeYear?: boolean } = {}): string {
  const { includeYear = false } = opts;
  const d = parseLocalDate(dateStr);
  return includeYear
    ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getMonth() + 1}月${d.getDate()}日`;
}
