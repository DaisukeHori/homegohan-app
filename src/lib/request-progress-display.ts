/**
 * 生成のリクエストの行 (weekly_menu_requests / shopping_list_requests) の progress を、画面に出す前に整える (#1911)
 *
 * 両表の progress 列には DB の既定値がある (supabase/migrations/20251126124224_create_meal_planner_tables.sql の
 * weekly_menu_requests.progress と shopping_list_requests.progress の DEFAULT。phase は 'pending')。
 * その既定値の message は、未完成を表す語 (#1911 で画面から取り除いた語) になっている。
 * progress を渡さずに行を作る経路 (週の献立の依頼 /api/ai/menu/weekly/request・1 食の生成・献立の追加など) では、
 * ワーカーが最初の進捗を書くまでの間、この既定値がそのまま画面 (進捗のカード・AI 相談の吹き出し) に届く。
 * そこで、DB の既定値の文は画面に出さず、ここで決めた文に置き換える。
 *
 * 既定値は phase で見分ける (message の文面には頼らない)。phase 'pending' は、アプリのコード・Edge Function の
 * どこも書かず、書くのは DB の既定値だけ。migrations の DEFAULT がこの phase であることは
 * tests/no-pending-wording-1911.test.ts が確かめる (既定値の文を変えたり、別の DEFAULT を足したりしたときに気づける)。
 */

/** DB の既定値の progress の phase (アプリのコード・Edge Function はこの phase を書かない) */
export const DB_DEFAULT_REQUEST_PROGRESS_PHASE = 'pending';

/** DB の既定値の progress (ワーカーがまだ進捗を書いていない行) のときに、画面に出す文 */
export const REQUEST_PROGRESS_STARTING_MESSAGE = '生成を始めています...';

/**
 * progress を画面に出す形にする。DB の既定値 (phase 'pending') のときだけ message を置き換え、
 * それ以外 (ワーカー・API が書いた進捗) はそのまま返す。phase・割合などほかの項目は変えない。
 */
export function requestProgressForDisplay<T extends { phase?: unknown; message?: unknown }>(progress: T): T {
  if (progress.phase !== DB_DEFAULT_REQUEST_PROGRESS_PHASE) return progress;
  return { ...progress, message: REQUEST_PROGRESS_STARTING_MESSAGE };
}
