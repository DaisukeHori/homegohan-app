/**
 * 献立生成のリクエストの行 (weekly_menu_requests) が究極モード (#1142) の生成かを見分ける (#1582)
 *
 * 行の mode は生成のエンジン (v4 / v5) で、究極モードかどうかは表さない (通常の生成も「献立を改善」も v4 / v5 になる)。
 * 究極モードかどうかは、行の generated_data.ultimateMode だけで見分ける。
 *   - 書くのは、生成を受け付けたところ (v4 / v5 の生成の route と AI 相談のアクション。行を作るときに
 *     weeklyMenuRequestUltimateModeData で書く) と、Edge Function の工程 1 (generate-menu-v4 / v5 が generated_data に書く)
 *   - progress.totalSteps は見分けに使わない。行を作ったときの totalSteps は枠の数 (targetSlots.length。2 日分の 3 食なら 6)
 *     や AI 相談の固定値 (1 / 3 / 21) で、通常の生成でも 6 になることがあるため
 * 生成中の行の確認 (GET /api/ai/menu/weekly/pending) は、この判定の結果を ultimateMode として返す
 * (Web の週間献立画面は、画面に入り直したときの進捗カードの種類をこれで決める。モバイルの週間献立のネイティブの画面は #1598 で消した)。
 *
 * 判定そのもの (isUltimateModeWeeklyMenuRequest。真偽値の true のときだけ究極モード) は、Web とモバイルで同じ基準にするため
 * @homegohan/shared (packages/shared/src/weekly-menu-ultimate-mode.ts) に置く (#1609)。ここには書く側の値と読む列の指定だけを置く。
 */

/**
 * 生成中の行の確認で、generated_data 全体 (生成中に大きくなる jsonb。#1042) を読まずに ultimateMode だけを読む列の指定。
 * 結果は ultimate_mode の名前で受け取る (PostgREST の JSON の取り出し。真偽値のまま返る)
 */
export const WEEKLY_MENU_REQUEST_ULTIMATE_MODE_SELECT = 'ultimate_mode:generated_data->ultimateMode';

/**
 * 行を作るときに generated_data へ書く値。生成を受け付けた時点から、行だけで究極モードかを見分けられるようにする
 * (Edge Function の工程 1 が generated_data を書くまでの間も、画面に入り直したときに正しい進捗カードを出すため)。
 * Edge Function は generated_data を広げて (...generatedData) 書き足すので、この値は消えない。
 */
export function weeklyMenuRequestUltimateModeData(ultimateMode: boolean): { ultimateMode: boolean } {
  return { ultimateMode };
}
