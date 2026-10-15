/**
 * e2e で使う「JST の今週の月曜日」(#1564)。
 *
 * 献立の週のページは、ブラウザ (playwright.config.ts の timezoneId: "Asia/Tokyo") のローカル時刻 = JST で
 * 今週の月曜日を決める。テストの側 (Node のプロセス) で `new Date().getDay()` / `setDate` / `toISOString` を使って
 * 月曜日を作ると、プロセスのタイムゾーン (CI は UTC) の週になり、JST の月曜 0:00〜8:59 は 1 週間前の月曜日になる
 * (`getDate() - getDay() + 1` の形は、日曜日に次の週の月曜日にもなる)。
 *
 * 暦の計算は packages/shared の calculatePeriodLocal ("weekly" = JST の月曜日から日曜日まで) にまかせ、
 * ここでは新しい日付の計算をしない。前後の週は addDaysToDate、今日は todayLocal を使う。
 */
import { calculatePeriodLocal } from "../../../packages/shared/src/date-utils";

/** now (既定は今) が属する、JST の月曜日始まりの週の月曜日 (YYYY-MM-DD)。プロセスのタイムゾーンに左右されない */
export function jstThisMonday(now: Date = new Date()): string {
  return calculatePeriodLocal("weekly", now).periodStart;
}
