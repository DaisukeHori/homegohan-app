/**
 * 献立生成のリクエストの行 (weekly_menu_requests) が究極モード (#1142) の生成かの判定 (#1582・#1597・#1609)
 *
 * Web とモバイルの週間献立の画面が、どちらもこの 1 つの関数で見分ける (#1609 で共有にした。以前は
 * Web の src/lib/ai/weekly-menu-request-ultimate.ts とモバイルの apps/mobile/app/menus/weekly/index.tsx に
 * 別々の関数があった)。読む値は次のどれか:
 *   - 行の generated_data.ultimateMode (生成中の行の確認 GET /api/ai/menu/weekly/pending がサーバーで判定する)
 *   - 生成中の行の確認の応答の ultimateMode (Web とモバイルの画面が入り直したときに読む)
 *   - Web が生成を始めたときに localStorage (v4MenuGenerating) へ保存した要求の ultimateMode
 *
 * 真偽値の true のときだけ究極モード。値が無い・読めない (印の無い古い行・古いサーバーの応答) ときは通常の生成として扱う。
 * 行の mode (v4 / v5) と progress.totalSteps は見分けに使わない (どちらも通常の生成と究極モードで同じ値になりうる)。
 */
export function isUltimateModeWeeklyMenuRequest(ultimateMode: unknown): boolean {
  return ultimateMode === true;
}
