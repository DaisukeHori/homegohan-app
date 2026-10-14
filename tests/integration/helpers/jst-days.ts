// #1545: 結合テストで DB の日付列 (user_daily_meals.day_date など) に入れる「今日」「n 日前」を、
// サーバーと同じ JST (Asia/Tokyo) の暦日で作る。
//
// サーバー (API ルート) は「今日」を JST の暦日で決める (src/lib/jst-day-ranges.ts の jstToday / consecutiveDayStreak など)。
// テストは TZ=UTC で流れるので、`new Date()` → `toISOString().split('T')[0]` で作ると UTC の暦日になり、
// JST の 0:00〜8:59 はサーバーの「昨日」を「今日」として入れてしまう。ここではテストの日付をサーバーの暦日に揃える。
//
// これは日付の作り方を揃える整理で、badges-api.test.ts の K-8 の赤 (#1545 で報告された
// `expected [] to deeply equal ['first_bite']`) の直しではない。GET /api/badges は食事の数を日付で絞らず、
// 連続日数 (consecutiveDayStreak) は今日の記録が無ければ昨日から数えるので、badges-api.test.ts が入れる日付が
// まるごと 1 日前にずれても、返る数とバッジは変わらない (連続日数が変わらないことは tests/integration-jst-days.test.ts で確かめている)。
// K-8 の赤の原因はまだ分かっていない。
//
// 日付の計算は自前で書かず、サーバーと同じ jstDayOffset (JST の今日 + 暦の計算) をそのまま使う。
// 時計を JST の 0:30 / 9:30 に固定しても、ここで作る「今日」がサーバーの JST の今日と一致することは
// tests/integration-jst-days.test.ts で確かめる。

import { jstDayOffset } from '../../../src/lib/jst-day-ranges';

/**
 * サーバーの JST の今日から daysAgo 日前の暦日を YYYY-MM-DD で返す (0 = 今日)。
 * now は単体テストで時計を固定するときだけ渡す (既定は現在時刻)。
 */
export function jstDaysAgo(daysAgo: number, now: Date = new Date()): string {
  return jstDayOffset(-daysAgo, now);
}
