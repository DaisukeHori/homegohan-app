// #1433: 健康グラフ (app/health/graphs.tsx) の日付の範囲を JST の暦日で決める純粋関数。
//
// 以前は new Date() に setDate (端末のローカル時刻) を当て、toISOString (UTC) の先頭 10 文字で日付にしていた。
// UTC の暦日は JST の 0:00〜8:59 に前日になるので、その時間帯は
//   - グラフの最後の日が昨日になり、今日の記録 (health_records.record_date は JST の暦日) がグラフに出なかった
//   - 取得の開始日も 1 日前にずれていた
// 暦日は packages/shared の formatLocalDate (Asia/Tokyo) で求め、日数のずらしは addDaysToDate (暦の計算だけ) で行う。
// どちらも端末のタイムゾーンに左右されない。境界の確認は tests/jst-day-ranges.test.ts。

import { addDaysToDate, formatLocalDate } from "@homegohan/shared";

/**
 * 記録を取得する開始日 (YYYY-MM-DD)。JST の今日の days 日前 (以前と同じ日数)。
 * 例: (30, JST 2026-10-01 03:00) → "2026-09-01"
 */
export function healthGraphFetchStartDate(days: number, now: Date = new Date()): string {
  return addDaysToDate(formatLocalDate(now), -days);
}

/**
 * グラフの横軸の日付 (YYYY-MM-DD)。JST の今日を最後の日とする days 日分 (古い順)。
 * 例: (7, JST 2026-10-01 03:00) → ["2026-09-25", …, "2026-10-01"]
 */
export function healthGraphDateSlots(days: number, now: Date = new Date()): string[] {
  const today = formatLocalDate(now);
  const slots: string[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    slots.push(addDaysToDate(today, -offset));
  }
  return slots;
}
