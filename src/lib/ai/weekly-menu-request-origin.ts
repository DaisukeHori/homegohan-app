/**
 * 献立生成のリクエストの行 (weekly_menu_requests) が、週の献立の生成 (POST /api/ai/menu/weekly/request) で作った行かを見分ける (#1867)。
 *
 * 「計画上手」(planner) のバッジは、AI で週の献立を作ったとき (週の献立の生成が成功して献立を保存したとき) にも付ける。
 * 行の mode は生成のエンジン (v4 / v5) で、汎用の献立の生成 (/api/ai/menu/v4/generate・/v5/generate)・1 食の生成・
 * 献立の改善の行と同じ値になるので、どの経路で作った行かは表さない。そこで、週の献立の生成は行を作るときに
 * generated_data へ印 (weeklyRequest: true) を書き、付与する側はこの印だけで見分ける。
 *   - 書くのは POST /api/ai/menu/weekly/request だけ (行を作るとき。weeklyMenuRequestWeeklyOriginData)
 *   - Edge Function (generate-menu-v4 / v5) は generated_data を広げて (...generatedData) 書き足すので、印は消えない
 *     (究極モードの印 generated_data.ultimateMode と同じ。src/lib/ai/weekly-menu-request-ultimate.ts)
 *   - 利用者 (authenticated) は weekly_menu_requests に書けない (#1465) ので、印を自分で付けて planner を取ることはできない
 * 読むのは次の 2 つ。
 *   - GET /api/ai/menu/weekly/status: 本人が状態を確かめたとき、完了 (completed) の行に印があれば planner を付ける
 *   - GET /api/badges: planner が未獲得なら、完了 (completed) で印のある本人の行があるかを見て付ける
 *     (生成の途中で画面を離れ、完了を状態の確認で見なかった人のため)
 * 印は、この変更より後に作った行にだけある。前に作った行には無いので、付与の対象にしない。
 */

/** generated_data の中の印のキー */
export const WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY = 'weeklyRequest' satisfies keyof ReturnType<typeof weeklyMenuRequestWeeklyOriginData>;

/**
 * 状態の確認で、generated_data 全体 (生成中に大きくなる jsonb。#1042) を読まずに印だけを読む列の指定。
 * 結果は weekly_request の名前で受け取る (PostgREST の JSON の取り出し。真偽値のまま返る)
 */
export const WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_SELECT = 'weekly_request:generated_data->weeklyRequest';

/**
 * 印で絞り込むときの列 (->> で text として取り出す) と値。JSON の true は text では 'true' になる。
 * 列の指定は、型つきのクライアントが読めるよう文字列の直書きにする (キーは WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY と同じ。
 * src/__tests__/lib/ai/weekly-menu-request-origin.test.ts が突き合わせる)
 */
export const WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_FILTER_COLUMN = 'generated_data->>weeklyRequest';
export const WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_FILTER_VALUE = 'true';

/** 週の献立の生成が行を作るときに generated_data へ書く印 */
export function weeklyMenuRequestWeeklyOriginData(): { weeklyRequest: true } {
  return { weeklyRequest: true };
}

/** 状態の確認で読んだ印 (weekly_request) が、週の献立の生成の行を表すか。真偽値の true のときだけ */
export function isWeeklyMenuRequestWeeklyOrigin(value: unknown): boolean {
  return value === true;
}
