/**
 * 献立生成のリクエストの行 (weekly_menu_requests) が、AI の週の献立の生成 (1 週間分の献立の生成) の行かを見分ける (#1867)。
 *
 * 「計画上手」(planner) のバッジは、AI で週の献立を作ったとき (週の献立の生成が成功して献立を保存したとき) にも付ける。
 * 行の mode は生成のエンジン (v4 / v5) で、1 食の生成・1 日の生成・献立の改善の行と同じ値になるので、1 週間分の生成かを表さない。
 * そこで、1 週間分の生成は行を作るときに generated_data へ印 (weeklyRequest: true) を書き、付与する側はこの印だけで見分ける。
 * 印を書くのは、利用者が AI で週の献立を作る次の経路 (行を作るとき):
 *   - POST /api/ai/menu/v4/generate・/v5/generate (Web の「AI献立アシスタント」(V4GenerateModal)・AI のチャット・モバイル):
 *     生成の対象の枠 (targetSlots) が 1 週間 (異なる日付が WEEKLY_MENU_GENERATION_MIN_DAYS 日以上) を覆うときだけ
 *     (weeklyMenuRequestWeeklyOriginDataForDates。1 食・1 日・数日の生成、1 日分の献立の改善には書かない)
 *   - AI 相談のアクションの 1 週間分の生成 (generate_week_menu。src/lib/ai/consultation-action-executor.ts。いつも 7 日分):
 *     同じく weeklyMenuRequestWeeklyOriginDataForDates で書く (1 日分 (generate_day_menu)・1 食 (generate_single_meal) には書かない)
 *   - POST /api/ai/menu/weekly/request (旧来の週の献立の生成。いつも開始日から 7 日分): いつも書く (weeklyMenuRequestWeeklyOriginData)
 * 印の性質:
 *   - Edge Function (generate-menu-v4 / v5) は generated_data を広げて (...generatedData) 書き足すので、印は消えない
 *     (究極モードの印 generated_data.ultimateMode と同じ。src/lib/ai/weekly-menu-request-ultimate.ts)
 *   - 利用者 (authenticated) は weekly_menu_requests に書けない (#1465) ので、印を自分で付けて planner を取ることはできない
 * 読むのは次の 2 つ。
 *   - GET /api/ai/menu/weekly/status: 本人が状態を確かめたとき、完了 (completed) の行に印があれば planner を付ける
 *   - GET /api/badges: planner が未獲得なら、完了 (completed) で印のある本人の行があるかを見て付ける
 *     (生成の途中で画面を離れた人や、状態の確認を使わない画面 (モバイルの生成は行の変化を購読して完了を知る) の人のため)
 * 印は、この変更より後に作った行にだけある。前に作った行には無いので、付与の対象にしない。
 */

/** generated_data の中の印のキー */
export const WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY = 'weeklyRequest' satisfies keyof ReturnType<typeof weeklyMenuRequestWeeklyOriginData>;

/**
 * 「AI で 1 週間の献立を作った」とみなす、生成の対象の異なる日付の数の下限 (1 週間 = 7 日)。
 * planner の説明 (supabase/migrations/20261018050000_planner_badge_description_weekly_menu.sql の「AIで1週間の献立をはじめて作りました」) と
 * 使い方ガイドの吹き出し (planner_bubble の「AI で 1 週間の献立を作る」) が約束する「1 週間」をそのまま数にしたもの。
 * 運用で変える値ではない (変えるなら説明と吹き出しの文も同時に変える) ので、環境変数にはしない
 */
export const WEEKLY_MENU_GENERATION_MIN_DAYS = 7;

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

/** 1 週間分の生成が行を作るときに generated_data へ書く印 (いつも 1 週間分を作る POST /api/ai/menu/weekly/request が使う) */
export function weeklyMenuRequestWeeklyOriginData(): { weeklyRequest: true } {
  return { weeklyRequest: true };
}

/**
 * 生成の対象の枠の日付 (YYYY-MM-DD。重複してよい) が 1 週間 (異なる日付が WEEKLY_MENU_GENERATION_MIN_DAYS 日以上) を覆うか。
 * 枠の数ではなく異なる日付で数える (1 日 3 食 × 2 日 = 6 枠は 2 日、7 日の夕食だけ = 7 枠は 7 日)
 */
export function coversWeekOfMenuGeneration(dates: readonly string[]): boolean {
  return new Set(dates).size >= WEEKLY_MENU_GENERATION_MIN_DAYS;
}

/**
 * 生成の対象の枠の日付から、行を作るときに generated_data へ広げて書く値を返す。
 * 1 週間を覆うときだけ印 ({ weeklyRequest: true })、そうでなければ何も書かない ({})。
 * 枠を対象にする生成 (POST /api/ai/menu/v4/generate・/v5/generate・AI 相談の 1 週間分の生成) が使う
 */
export function weeklyMenuRequestWeeklyOriginDataForDates(dates: readonly string[]): { weeklyRequest?: true } {
  return coversWeekOfMenuGeneration(dates) ? weeklyMenuRequestWeeklyOriginData() : {};
}

/** 状態の確認で読んだ印 (weekly_request) が、週の献立の生成の行を表すか。真偽値の true のときだけ */
export function isWeeklyMenuRequestWeeklyOrigin(value: unknown): boolean {
  return value === true;
}
