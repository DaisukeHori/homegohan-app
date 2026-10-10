/**
 * JST (Asia/Tokyo, UTC+9) の日付ヘルパー - Edge Functions 用の純粋関数
 *
 * Edge Runtime (Deno) のタイムゾーンは UTC。そのため
 * `new Date().toISOString().split('T')[0]` は UTC の暦日になり、
 * JST 00:00〜08:59 の間は「前日」を返してしまう (#1210)。
 * DB の日付列 (user_daily_meals.day_date など) は JST の暦日で入っているので、
 * 「今日」や「ある時刻が属する日」を求めるときは、このファイルの関数を使う。
 *
 * 週・月・日の集計期間 (calculateJstPeriod) も同じ理由で JST の暦で求める (#1211)。
 * 「今日から N 日さかのぼる」期間 (calculateJstLookbackPeriod / addDaysToDate) も同じ (#1407)。
 * new Date().getDay() / getDate() / getMonth() はどれも実行環境 (UTC) のローカル時刻で答えるので、
 * 月曜の JST 00:00〜08:59 (UTC ではまだ日曜) は週の開始日が 1 週間前の月曜になっていた。
 *
 * Web / Mobile 側の同等ヘルパーは packages/shared/src/date-utils.ts の
 * formatLocalDate / todayLocal / calculatePeriodLocal (src/lib/date-utils.ts から import できる)。
 * Edge Functions は packages/shared (workspace パッケージ) を import していないため、
 * 同じ結果を返す実装をここに置く。こちらは Intl やタイムゾーンデータに頼らず、
 * 固定オフセットで求める (日本は夏時間が無く、JST は常に UTC+9 なので結果は同じ)。
 * 2 つの実装が一致することは tests/jst-date.test.ts と tests/jst-period.test.ts で確認している。
 */

/** JST の UTC からのオフセット (ミリ秒)。日本は夏時間が無いので常に +9 時間。 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 全期間 (all_time) の集計の開始日 */
const ALL_TIME_START = '2024-01-01';

/**
 * その時刻が属する JST の暦日を YYYY-MM-DD で返す。
 * 例: 2026-07-12T16:00:00Z (JST 7/13 01:00) → "2026-07-13"
 *
 * 不正な Date (Invalid Date) を渡すと RangeError になる (変な日付を黙って返さない)。
 */
export function formatJstDate(date: Date): string {
  // 9 時間進めた時刻の「UTC の暦日」が、元の時刻の「JST の暦日」になる
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * JST の「今日」を YYYY-MM-DD で返す。
 * now はテスト用に差し替えられる (省略時は現在時刻)。
 */
export function todayJst(now: Date = new Date()): string {
  return formatJstDate(now);
}

/**
 * now が属する JST の「月」(1〜12) を返す (#1433)。
 * `new Date().getMonth() + 1` は実行環境 (Edge は UTC) のローカル時刻で答えるので、
 * 月初 1 日の JST 00:00〜08:59 は前月になる。旬の食材 (seasonalContext.month) など「今の月」を JST で決めるときに使う。
 * Web / Mobile 側の同等の関数は packages/shared の monthLocal。
 *
 * 不正な Date (Invalid Date) を渡すと RangeError になる。
 */
export function monthJst(now: Date = new Date()): number {
  return Number(formatJstDate(now).slice(5, 7));
}

/**
 * 集計期間 (segment_stats / user_metrics / user_segment_rankings の period_type) の、
 * now が属する期間の開始日と終了日 (どちらも YYYY-MM-DD で、その日を含む) を JST の暦で返す (#1211)。
 *
 *   - daily    : JST の今日だけ
 *   - weekly   : JST の月曜日から日曜日までの 7 日間
 *   - monthly  : JST の 1 日から末日まで
 *   - all_time : 2024-01-01 から JST の今日まで
 *   - それ以外 : JST の今日の 7 日前から今日まで
 *
 * 保存する側 (Edge Function calculate-segment-stats) と、読み出す側 (Web の /api/comparison/rankings。
 * packages/shared の calculatePeriodLocal) は、同じ period_start を使わないと、保存した集計を引けない。
 * 2 つの実装が一致することは tests/jst-period.test.ts で確認している。
 *
 * JST の今日 (YYYY-MM-DD) を UTC の 0 時として扱い、暦の計算だけを UTC の関数で行う。
 * 実行環境のタイムゾーンやサマータイムに左右されない。
 *
 * 不正な Date (Invalid Date) を渡すと RangeError になる。
 */
export function calculateJstPeriod(
  periodType: string,
  now: Date = new Date(),
): { periodStart: string; periodEnd: string } {
  const [year, month, day] = formatJstDate(now).split('-').map(Number);
  // 年・月 (1〜12)・日 → YYYY-MM-DD。日や月が範囲を超えても、繰り上がり・繰り下がりは Date.UTC が処理する
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
      return { periodStart: ALL_TIME_START, periodEnd: dayOf(0) };
    default:
      return { periodStart: dayOf(-7), periodEnd: dayOf(0) };
  }
}

/** 暦で区切る期間の種類 (日・月曜始まりの週・月)。「直前の期間」が 1 つに決まるのは、この 3 つだけ */
export const JST_CALENDAR_PERIOD_TYPES = ['daily', 'weekly', 'monthly'] as const;
export type JstCalendarPeriodType = (typeof JST_CALENDAR_PERIOD_TYPES)[number];

export function isJstCalendarPeriodType(periodType: unknown): periodType is JstCalendarPeriodType {
  return typeof periodType === 'string' && (JST_CALENDAR_PERIOD_TYPES as readonly string[]).includes(periodType);
}

/** 期間の開始日の JST 0 時から、この分だけ前の時刻を「直前の期間の最後の瞬間」とする (Date の最小単位の 1 ミリ秒) */
const LAST_MOMENT_BEFORE_MS = 1;

/**
 * now が属する期間 (calculateJstPeriod) の、1 つ前の期間の開始日と終了日を JST の暦で返す (#1406)。
 *   - daily   : JST の昨日
 *   - weekly  : JST の先週の月曜日から日曜日まで
 *   - monthly : JST の先月の 1 日から末日まで
 * 例: (weekly, JST 月曜 2026-10-12 0:05) → { periodStart: "2026-10-05", periodEnd: "2026-10-11" }
 *
 * 1 時間ごとの定期実行は、期間の最後の 1 時間 (例: 日曜 23:05〜23:59) の記録を、その期間の集計に入れられない
 * (次の回はもう次の期間を集計する)。期間が切り替わった直後の回が、この関数で直前の期間を 1 回だけ集計し直す。
 * 今の期間の開始日の JST 0 時の 1 ミリ秒前 (= 直前の期間の最後の瞬間) が属する期間を、calculateJstPeriod で求める。
 *
 * all_time などの暦で区切らない種類には「直前の期間」が無いので RangeError。不正な Date (Invalid Date) も RangeError。
 */
export function calculateJstPreviousPeriod(
  periodType: string,
  now: Date = new Date(),
): { periodStart: string; periodEnd: string } {
  if (!isJstCalendarPeriodType(periodType)) {
    throw new RangeError(`No previous period for periodType: ${periodType}`);
  }
  const { periodStart } = calculateJstPeriod(periodType, now);
  // "YYYY-MM-DDT00:00:00Z" から 9 時間引いた時刻が、その日の JST 0 時
  const currentStartMs = Date.parse(`${periodStart}T00:00:00Z`) - JST_OFFSET_MS;
  return calculateJstPeriod(periodType, new Date(currentStartMs - LAST_MOMENT_BEFORE_MS));
}

/** YYYY-MM-DD の形 (ゼロ埋め) */
const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 暦日 (YYYY-MM-DD) から offsetDays 日ずらした暦日を YYYY-MM-DD で返す (#1407)。負の数で過去の日。
 * 例: ("2027-01-01", -30) → "2026-12-02" / ("2028-03-01", -1) → "2028-02-29"
 *
 * 暦の計算だけをする (時刻もタイムゾーンも持たない) ので、formatJstDate で求めた JST の暦日を渡せば、
 * 結果も JST の暦日になる。月末・年末・うるう日の繰り上がり・繰り下がりは Date.UTC が処理する。
 * 実行環境のタイムゾーンやサマータイムに左右されない (Date#setDate / getDate はローカル時刻なので使わない)。
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
 * now が属する JST の暦日 (今日) を終了日、その lookbackDays 日前を開始日とする期間 (どちらの日も含む。YYYY-MM-DD) を返す (#1407)。
 * 例: (7, JST 2026-07-13 03:00) → { periodStart: "2026-07-06", periodEnd: "2026-07-13" }
 *
 * calculateJstPeriod (週は月曜始まり・月は 1 日始まりの暦の区切り) と違い、「今日からさかのぼって N 日」の期間。
 * 健康インサイトの生成 (generate-health-insights) が、日付の列 (health_records.record_date) を
 * `record_date >= periodStart AND record_date <= periodEnd` で絞るのに使う。
 *
 * 不正な Date (Invalid Date)・負の数や整数でない日数を渡すと RangeError になる。
 */
export function calculateJstLookbackPeriod(
  lookbackDays: number,
  now: Date = new Date(),
): { periodStart: string; periodEnd: string } {
  if (!Number.isInteger(lookbackDays) || lookbackDays < 0) {
    throw new RangeError(`lookbackDays must be a non-negative integer: ${lookbackDays}`);
  }
  const periodEnd = formatJstDate(now);
  return { periodStart: addDaysToDate(periodEnd, -lookbackDays), periodEnd };
}

/**
 * JST の暦日の範囲 (開始日〜終了日。どちらの日も含む。YYYY-MM-DD) を、timestamptz 列を絞る時刻の範囲にする (#1211)。
 * from は開始日の JST 0 時 (含む)、before は終了日の翌日の JST 0 時 (含まない)。
 * `列 >= from AND 列 < before` で絞る。
 * 例: ("2026-07-13", "2026-07-19") → { from: "2026-07-12T15:00:00.000Z", before: "2026-07-19T15:00:00.000Z" }
 *
 * 日付の文字列を timestamptz 列にそのまま渡すと、DB のタイムゾーン (UTC) の 0 時として解釈され、JST と 9 時間ずれる。
 *
 * 不正な日付を渡すと RangeError になる。
 */
export function jstDayRangeToTimestamps(startDay: string, endDay: string): { from: string; before: string } {
  // "YYYY-MM-DDT00:00:00Z" から 9 時間引いた時刻が、その日の JST 0 時
  const jstMidnightMs = (day: string) => Date.parse(`${day}T00:00:00Z`) - JST_OFFSET_MS;
  return {
    from: new Date(jstMidnightMs(startDay)).toISOString(),
    before: new Date(jstMidnightMs(endDay) + DAY_MS).toISOString(),
  };
}
