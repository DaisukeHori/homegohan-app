/**
 * 献立生成のリクエストの行 (weekly_menu_requests) が、AI で複数の日の献立をまとめて作った生成の行かを見分ける (#1867)。
 *
 * 「計画上手」(planner) のバッジは、AI で複数の日の献立をまとめて作ったとき (生成が成功して献立を保存したとき) にも付ける。
 * 1 週間分に限らない: 週の途中に AI献立アシスタントの「空欄を埋める」「AI献立だけ変更」(今日から週の終わりまで)・「期間を指定」で
 * 週の残り (7 日未満) を作ったときも付く。1 日分 (1 日の改善)・1 食分の生成では付けない。
 * 行の mode は生成のエンジン (v4 / v5) で、1 食の生成・1 日の生成・献立の改善の行と同じ値になるので、複数の日の生成かを表さない。
 * そこで、複数の日の生成は行を作るときに generated_data へ印 (weeklyRequest: true) を書き、付与する側はこの印だけで見分ける。
 * 印の名前 (weeklyRequest) は、印を入れた最初の版 (1 週間分の生成だけに書いた) の名残。前に作った行にもこの名前で入っていて、
 * DB のトリガー・状態の確認・バッジの一覧がこの名前で読むので変えない。
 * 印を書くのは、利用者が AI で複数の日の献立を作る次の経路 (行を作るとき):
 *   - POST /api/ai/menu/v4/generate・/v5/generate (Web の「AI献立アシスタント」(V4GenerateModal)・AI のチャット・モバイル):
 *     生成の対象の枠 (targetSlots) が複数の日 (異なる日付が MULTI_DAY_MENU_GENERATION_MIN_DAYS 日以上) にわたるときだけ
 *     (weeklyMenuRequestWeeklyOriginDataForDates。1 食・1 日の生成、1 日分の献立の改善には書かない)
 *   - AI 相談のアクションの 1 週間分の生成 (generate_week_menu。src/lib/ai/consultation-action-executor.ts。いつも 7 日分):
 *     同じく weeklyMenuRequestWeeklyOriginDataForDates で書く (1 日分 (generate_day_menu)・1 食 (generate_single_meal) には書かない)
 *   - POST /api/ai/menu/weekly/request (旧来の週の献立の生成。いつも開始日から 7 日分): いつも書く (weeklyMenuRequestWeeklyOriginData)
 * 印の性質:
 *   - Edge Function (generate-menu-v4 / v5) は generated_data を広げて (...generatedData) 書き足すので、印は消えない
 *     (究極モードの印 generated_data.ultimateMode と同じ。src/lib/ai/weekly-menu-request-ultimate.ts)
 *   - 利用者 (authenticated) は weekly_menu_requests に書けない (#1465) ので、印を自分で付けて planner を取ることはできない
 * 印を見て planner を付けるのは次の 3 つ。どれも印だけを見るので、印を書く条件 (何日分から) を変えても変わらない。
 *   - DB のトリガー weekly_menu_requests_award_planner (supabase/migrations/20261018060000_planner_badge_award_on_weekly_menu_completed.sql):
 *     行が completed になった時点で、印があれば行の持ち主に付ける。これが付与の本体。書き手 (Edge Function など) を見分けず、
 *     画面が完了をどう知るか (Web の週間献立の画面は行の変化 (Realtime) で知り、状態の確認のポーリングは代替。モバイルは Realtime と
 *     行の直接の読み取りで知り、状態の確認を呼ばない。モバイルにはバッジの一覧の画面も無い) にも依らずに付く
 *   - GET /api/ai/menu/weekly/status: 本人が状態を確かめたとき、完了 (completed) の行に印があれば付ける (トリガーが付け損ねたときの保険)
 *   - GET /api/badges: planner が未獲得なら、完了 (completed) で印のある本人の行があるかを見て付ける (同じく保険)
 * 印は、書く条件を入れた変更より後に作った行にだけある。前に作った行には無いので、付与の対象にしない
 * (2 日以上 7 日未満の生成の行も、2 日以上で書くようにした変更より前に作ったものには印が無い)。
 */

/** generated_data の中の印のキー */
export const WEEKLY_MENU_REQUEST_WEEKLY_ORIGIN_KEY = 'weeklyRequest' satisfies keyof ReturnType<typeof weeklyMenuRequestWeeklyOriginData>;

/**
 * 「AI で複数の日の献立をまとめて作った」とみなす、生成の対象の異なる日付の数の下限 (複数 = 2 日以上)。
 * planner の説明 (supabase/migrations/20261018070000_planner_badge_description_multi_day.sql の「AIで複数の日の献立をはじめてまとめて作りました」) と
 * 使い方ガイドの吹き出し (planner_bubble の「AI で複数の日の献立をまとめて作る」) が約束する「複数の日」をそのまま数にしたもの。
 * 1 日分 (1 日の改善)・1 食分の生成は 1 日なので届かない。週の途中に今週の残りを作る生成 (7 日未満) は届く。
 * 運用で変える値ではない (変えるなら説明と吹き出しの文も同時に変える) ので、環境変数にはしない
 */
export const MULTI_DAY_MENU_GENERATION_MIN_DAYS = 2;

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

/** 複数の日の生成が行を作るときに generated_data へ書く印 (いつも 1 週間分を作る POST /api/ai/menu/weekly/request が使う) */
export function weeklyMenuRequestWeeklyOriginData(): { weeklyRequest: true } {
  return { weeklyRequest: true };
}

/**
 * 生成の対象の枠の日付 (YYYY-MM-DD。重複してよい) が複数の日 (異なる日付が MULTI_DAY_MENU_GENERATION_MIN_DAYS 日以上) にわたるか。
 * 枠の数ではなく異なる日付で数える (1 日 3 食 = 3 枠は 1 日、2 日の夕食だけ = 2 枠は 2 日)
 */
export function coversMultipleDaysOfMenuGeneration(dates: readonly string[]): boolean {
  return new Set(dates).size >= MULTI_DAY_MENU_GENERATION_MIN_DAYS;
}

/**
 * 生成の対象の枠の日付から、行を作るときに generated_data へ広げて書く値を返す。
 * 複数の日にわたるときだけ印 ({ weeklyRequest: true })、そうでなければ何も書かない ({})。
 * 枠を対象にする生成 (POST /api/ai/menu/v4/generate・/v5/generate・AI 相談の 1 週間分の生成) が使う
 */
export function weeklyMenuRequestWeeklyOriginDataForDates(dates: readonly string[]): { weeklyRequest?: true } {
  return coversMultipleDaysOfMenuGeneration(dates) ? weeklyMenuRequestWeeklyOriginData() : {};
}

/** 状態の確認で読んだ印 (weekly_request) が、複数の日の献立の生成の行を表すか。真偽値の true のときだけ */
export function isWeeklyMenuRequestWeeklyOrigin(value: unknown): boolean {
  return value === true;
}
