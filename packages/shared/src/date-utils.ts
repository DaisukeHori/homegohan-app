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
 * 集計期間（segment_stats / user_metrics / user_segment_rankings の period_type）の、
 * now が属する期間の開始日と終了日（どちらも YYYY-MM-DD で、その日を含む）を、
 * 日本時間（Asia/Tokyo, JST）の暦で返す（#1211）。
 *
 *   - daily    : JST の今日だけ
 *   - weekly   : JST の月曜日から日曜日までの 7 日間
 *   - monthly  : JST の 1 日から末日まで
 *   - all_time : 2024-01-01 から JST の今日まで
 *   - それ以外 : JST の今日の 7 日前から今日まで
 *
 * new Date().getDay() / getDate() / getMonth() は実行環境（Vercel は UTC）のローカル時刻で答えるため、
 * 月曜の JST 00:00〜08:59（UTC ではまだ日曜）に、週の開始日が 1 週間前の月曜になっていた。
 *
 * 集計を保存する Edge Function（calculate-segment-stats）は、同じ期間を
 * supabase/functions/_shared/jst-date.ts の calculateJstPeriod で求める。
 * 読み出す側（/api/comparison/rankings）が違う period_start で引くと、保存した集計が見つからないので、
 * タイムゾーンは引数にせず JST に固定している（2 つの実装が一致することは tests/jst-period.test.ts で確認している）。
 *
 * JST の今日（YYYY-MM-DD）を UTC の 0 時として扱い、暦の計算だけを UTC の関数で行う。
 * 実行環境のタイムゾーンやサマータイムに左右されない。
 *
 * 不正な Date（Invalid Date）を渡すと RangeError になる。
 */
export function calculatePeriodLocal(
  periodType: string,
  now: Date = new Date(),
): { periodStart: string; periodEnd: string } {
  const [year, month, day] = formatLocalDate(now, 'Asia/Tokyo').split('-').map(Number);
  // 年・月（1〜12）・日 → YYYY-MM-DD。日や月が範囲を超えても、繰り上がり・繰り下がりは Date.UTC が処理する
  const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
  // JST の今日から offsetDays 日ずらした日
  const dayOf = (offsetDays: number) => ymd(year, month, day + offsetDays);

  switch (periodType) {
    case 'daily':
      return { periodStart: dayOf(0), periodEnd: dayOf(0) };
    case 'weekly': {
      // 月曜日起点。getUTCDay() は日曜 0 〜 土曜 6 なので、月曜日からの経過日数は (曜日 + 6) % 7
      const sinceMonday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
      return { periodStart: dayOf(-sinceMonday), periodEnd: dayOf(6 - sinceMonday) };
    }
    case 'monthly':
      // 翌月の 0 日 = 当月の末日
      return { periodStart: ymd(year, month, 1), periodEnd: ymd(year, month + 1, 0) };
    case 'all_time':
      return { periodStart: '2024-01-01', periodEnd: dayOf(0) };
    default:
      return { periodStart: dayOf(-7), periodEnd: dayOf(0) };
  }
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
