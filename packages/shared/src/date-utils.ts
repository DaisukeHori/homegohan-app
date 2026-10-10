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

/** YYYY-MM-DD の形 (ゼロ埋め) */
const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 暦日 (YYYY-MM-DD) から offsetDays 日ずらした暦日を YYYY-MM-DD で返す (#1433)。負の数で過去の日。
 * 例: ("2027-01-01", -30) → "2026-12-02" / ("2028-03-01", -1) → "2028-02-29"
 *
 * 暦の計算だけをする (時刻もタイムゾーンも持たない) ので、formatLocalDate / todayLocal で求めた JST の暦日を渡せば、
 * 結果も JST の暦日になる。月末・年末・うるう日の繰り上がり・繰り下がりは Date.UTC が処理する。
 * 実行環境のタイムゾーンやサマータイムに左右されない
 * (`new Date(dateStr)` に Date#setDate (ローカル時刻) を当てて toISOString (UTC) で戻す書き方は、実行環境のタイムゾーンで結果が変わる)。
 *
 * Edge Functions 用の同じ関数は supabase/functions/_shared/jst-date.ts の addDaysToDate (#1407)。
 * 2 つの実装が一致することは tests/jst-date-shift.test.ts で確認している。
 *
 * 形の違う日付・存在しない日付 (2026-02-30 など)・整数でない日数を渡すと RangeError になる (変な日付を黙って返さない)。
 */
export function addDaysToDate(day: string, offsetDays: number): string {
  if (!YMD_PATTERN.test(day)) {
    throw new RangeError(`Invalid date (expected YYYY-MM-DD): ${day}`);
  }
  if (!Number.isInteger(offsetDays)) {
    throw new RangeError(`offsetDays must be an integer: ${offsetDays}`);
  }
  const [year, month, date] = day.split('-').map(Number);
  // 存在しない日付 (2026-02-30 → 3/2 に繰り上がる) は、0 日ずらしても元の文字列に戻らないので弾く
  if (new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10) !== day) {
    throw new RangeError(`Invalid date (no such day): ${day}`);
  }
  return new Date(Date.UTC(year, month - 1, date + offsetDays)).toISOString().slice(0, 10);
}

/**
 * 文字列が YYYY-MM-DD の形で、実在する日付か (2026-02-30 などは false) (#1433)。
 * addDaysToDate に渡す前の入力の確認に使う。
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !YMD_PATTERN.test(value)) return false;
  const [year, month, date] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10) === value;
}

/**
 * 現地時刻 (デフォルト Asia/Tokyo) の「月」(1〜12) を返す (#1433)。
 * `new Date().getMonth() + 1` は実行環境 (Vercel / Edge は UTC) のローカル時刻で答えるので、
 * 月初 1 日の JST 00:00〜08:59 は前月になる。旬の食材など「今の月」を JST で決めるときに使う。
 */
export function monthLocal(now: Date = new Date(), timeZone = 'Asia/Tokyo'): number {
  return Number(formatLocalDate(now, timeZone).slice(5, 7));
}

/** JST の UTC からのオフセット (ISO 8601 の表記)。日本は夏時間が無いので常に +09:00 */
const JST_ISO_OFFSET = '+09:00';

/**
 * JST の暦日 (YYYY-MM-DD) の JST 0 時を、timestamptz 列と比べられる ISO 8601 (UTC) の時刻にする (#1433)。
 * 例: "2026-10-10" → "2026-10-09T15:00:00.000Z"
 *
 * 日付の文字列 ("2026-10-10") を timestamptz 列にそのまま渡すと、DB のタイムゾーン (UTC) の 0 時として解釈され、
 * JST と 9 時間ずれる (JST の 0:00〜8:59 に起きたことが「前日」に数えられる)。
 * Edge Functions 用の同等の関数は supabase/functions/_shared/jst-date.ts の jstDayRangeToTimestamps (from が同じ値)。
 * 2 つの実装が一致することは tests/jst-date-shift.test.ts で確認している。
 *
 * 形の違う日付・存在しない日付を渡すと RangeError になる。
 */
export function jstDayStartTimestamp(day: string): string {
  // 存在しない日付・形の違う日付は addDaysToDate が RangeError にする
  addDaysToDate(day, 0);
  return new Date(`${day}T00:00:00${JST_ISO_OFFSET}`).toISOString();
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
