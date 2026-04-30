/**
 * 現地時刻(Asia/Tokyo)の YYYY-MM-DD を返す。
 * UTC 偏移によるズレを防ぐ。
 */
export function formatLocalDate(date: Date = new Date(), timeZone = 'Asia/Tokyo'): string {
  return date.toLocaleDateString('sv-SE', { timeZone });
}

/**
 * 現地時刻の今日(YYYY-MM-DD)
 */
export function todayLocal(timeZone = 'Asia/Tokyo'): string {
  return formatLocalDate(new Date(), timeZone);
}
