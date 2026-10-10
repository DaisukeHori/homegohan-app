// #1433: サーバー (Next.js の API ルート) で「今日」・期間・月を JST (Asia/Tokyo) の暦日で決めるための純粋関数。
//
// Vercel の実行環境のタイムゾーンは UTC。そのため
//   - `new Date().toISOString().slice(0, 10)` / `.split('T')[0]` は UTC の暦日になり、JST の 0:00〜8:59 は「前日」になる
//   - `new Date()` に setDate(getDate() - N) (ローカル時刻) を当てて toISOString (UTC) で戻す書き方は、
//     実行環境のタイムゾーン (と夏時間) で結果が変わる
// DB の日付列 (user_daily_meals.day_date / health_records.record_date など) は JST の暦日で入っているので、
// 「今日」や「N 日前」はここの関数で求める。
//
// 暦日は packages/shared の formatLocalDate (Asia/Tokyo) で求め、日数のずらしは addDaysToDate (暦の計算だけ) で行う。
// どちらも実行環境のタイムゾーンに左右されない。Edge Functions 側の同じ考え方の関数は
// supabase/functions/_shared/jst-date.ts (todayJst / addDaysToDate / calculateJstLookbackPeriod)。
// 境界 (JST 0:00 ちょうど・8:59:59・月初・月末・年末) と、実行環境のタイムゾーンを変えても結果が同じことは
// tests/jst-day-ranges.test.ts で確かめる。

import { addDaysToDate, formatLocalDate, isCalendarDate } from '@/lib/date-utils';

// 入力の確認 (YYYY-MM-DD の実在する日付か) は、ルートからここ経由でも使えるようにする
export { isCalendarDate };

/** 暦日を決めるタイムゾーン。DB の日付列は JST の暦日 */
const JST_TIME_ZONE = 'Asia/Tokyo';

/** 1 週間の日数 */
const DAYS_PER_WEEK = 7;

/** その時刻が属する JST の暦日 (今日) を YYYY-MM-DD で返す */
export function jstToday(now: Date = new Date()): string {
  return formatLocalDate(now, JST_TIME_ZONE);
}

/**
 * JST の今日から offsetDays 日ずらした暦日を YYYY-MM-DD で返す。負の数で過去の日。
 * 例: (-7, JST 2026-10-01 03:00) → "2026-09-24"
 */
export function jstDayOffset(offsetDays: number, now: Date = new Date()): string {
  return addDaysToDate(jstToday(now), offsetDays);
}

// ---------------------------------------------------------------------------
// 栄養分析 (POST /api/ai/nutrition-analysis) の期間
// ---------------------------------------------------------------------------

/** 「週」の分析期間の日数 (今日を含む 7 日間。以前の setDate(getDate() - 6) と同じ日数) */
export const NUTRITION_ANALYSIS_WEEK_DAYS = 7;
/** 「月」の分析期間の日数 (今日を含む 30 日間。以前の setDate(getDate() - 29) と同じ日数) */
export const NUTRITION_ANALYSIS_MONTH_DAYS = 30;

/**
 * 栄養分析の期間 (開始日・終了日。どちらの日も含む。YYYY-MM-DD) を JST の暦日で返す。
 *   - week  : JST の今日を含む 7 日間
 *   - month : JST の今日を含む 30 日間
 *   - それ以外 (today) : JST の今日だけ
 */
export function nutritionAnalysisRange(period: string, now: Date = new Date()): { startDate: string; endDate: string } {
  const endDate = jstToday(now);
  const spanDays =
    period === 'week' ? NUTRITION_ANALYSIS_WEEK_DAYS : period === 'month' ? NUTRITION_ANALYSIS_MONTH_DAYS : 1;
  return { startDate: addDaysToDate(endDate, -(spanDays - 1)), endDate };
}

// ---------------------------------------------------------------------------
// バッジ (GET /api/badges) の連続日数
// ---------------------------------------------------------------------------

/**
 * 食事を記録した日 (YYYY-MM-DD) の集まりから、JST の今日から過去へ途切れずに続く日数を返す。
 * 今日の記録がまだ無いときは、昨日から数える (以前のルートと同じ数え方)。
 * 例: 今日 = 10/10、記録 = {10/9, 10/8, 10/6} → 2
 *
 * 以前のルートは「記録した日の数」回だけ調べていたので、今日の記録が無いと最後の 1 日を調べ損ねていた
 * (記録 = {10/9, 10/8} で 1 になっていた)。今日の分の 1 回を足して調べる。
 */
export function consecutiveDayStreak(recordedDays: Iterable<string>, now: Date = new Date()): number {
  const days = new Set(recordedDays);
  const today = jstToday(now);
  let streak = 0;
  // 今日 (i = 0) に記録が無くても、記録した日の数だけ昨日以前を調べられるように、1 回多く回す
  for (let i = 0; i <= days.size; i++) {
    if (days.has(addDaysToDate(today, -i))) {
      streak++;
    } else if (i > 0) {
      break;
    }
  }
  return streak;
}

// ---------------------------------------------------------------------------
// 単一食事の生成待ち (GET /api/ai/menu/meal/pending) の週
// ---------------------------------------------------------------------------

/** 日曜日の曜日番号 (Date#getUTCDay は日曜 0 〜 土曜 6) */
const SUNDAY = 0;

/**
 * 暦日 (YYYY-MM-DD) を含む、日曜日から土曜日までの週を返す。
 * 暦の計算だけで求めるので、実行環境のタイムゾーンに左右されない
 * (以前は new Date(day) (UTC の 0 時) の曜日を getDay (ローカル時刻) で読んでいたので、UTC より西では前日の曜日になっていた)。
 * 例: "2026-10-14" (水) → { startDate: "2026-10-11", endDate: "2026-10-17" }
 *
 * 形の違う日付・存在しない日付は RangeError。
 */
export function sundayWeekRange(day: string): { startDate: string; endDate: string } {
  // 存在しない日付・形の違う日付は addDaysToDate が RangeError にする
  addDaysToDate(day, 0);
  const [year, month, date] = day.split('-').map(Number);
  const sinceSunday = (new Date(Date.UTC(year, month - 1, date)).getUTCDay() - SUNDAY + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  const startDate = addDaysToDate(day, -sinceSunday);
  return { startDate, endDate: addDaysToDate(startDate, DAYS_PER_WEEK - 1) };
}

// ---------------------------------------------------------------------------
// 健康チャレンジ (POST /api/health/challenges) の期間
// ---------------------------------------------------------------------------

/**
 * チャレンジの開始日 (JST の今日) と終了日 (開始日の durationDays 日後) を返す。以前のルートと同じ日数。
 * 例: (7, JST 2026-12-31 08:59) → { startDate: "2026-12-31", endDate: "2027-01-07" }
 */
export function challengePeriod(durationDays: number, now: Date = new Date()): { startDate: string; endDate: string } {
  const startDate = jstToday(now);
  return { startDate, endDate: addDaysToDate(startDate, durationDays) };
}

// ---------------------------------------------------------------------------
// LLM の使用量 (GET /api/super-admin/llm/usage) の期間
// ---------------------------------------------------------------------------

/** 期間の種類ごとの、今日からさかのぼる日数 */
export const LLM_USAGE_LOOKBACK_DAYS = { '1d': 1, '7d': 7, '30d': 30 } as const;
export type LlmUsagePeriod = keyof typeof LLM_USAGE_LOOKBACK_DAYS | 'custom';

/**
 * LLM の使用量を集計する期間 (開始日・終了日。YYYY-MM-DD) を返す。
 *   - 終了日: to が指定されていればそれ、無ければ JST の今日
 *   - 開始日: custom で from が指定されていればそれ、それ以外は JST の今日から N 日前 (1d=1・7d=7・30d=30。以前のルートと同じ日数)
 *     (custom で from が無いときは、以前のルートと同じく 30 日前)
 */
export function llmUsageRange(
  params: { period: LlmUsagePeriod; from?: string; to?: string },
  now: Date = new Date(),
): { fromDate: string; toDate: string } {
  const toDate = params.to ?? jstToday(now);
  if (params.period === 'custom' && params.from) {
    return { fromDate: params.from, toDate };
  }
  const days = params.period === 'custom' ? LLM_USAGE_LOOKBACK_DAYS['30d'] : LLM_USAGE_LOOKBACK_DAYS[params.period];
  return { fromDate: jstDayOffset(-days, now), toDate };
}
