/**
 * POST /api/menu-plans/add の date_offset_days (献立の開始日を JST の今日から何日ずらすか) の上限 (#1463)。
 *
 * 以前は上限が無く、巨大な値 (1e9 など) を送ると、開始日を求める addDaysToDate が暦の計算で扱える範囲の外に出て
 * RangeError を投げ、500 になっていた。利用者が値を選ぶ画面は無く、送るのはハンズオンツアー (Web) の見本の献立
 * (packages/handson-tour-shared の MOCK_MENU_RESPONSE) の 1 = 明日だけなので、献立の計画として意味のある範囲だけを受け付け、外は 400 にする。
 *
 * 既定の上限は 366 日 (前後 1 年。うるう年の日数)。献立は週・月の単位で立てるので、1 年より先 (前) の開始日は計画として
 * 使い道が無い。packages/shared の CALENDAR_DATE_SHIFT_MARGIN_DAYS (外から受け取った日付をずらす余白) と同じ 1 年に
 * そろえている。運用で変えるときは、環境変数 MENU_PLANS_ADD_MAX_DATE_OFFSET_DAYS (正の整数) で上書きする。
 * 上書きしても、開始日が暦の計算で扱える範囲 (0100-01-01〜9999-12-31) の外に出る値はルートが 400 にする (500 にはしない)。
 */

/** date_offset_days の既定の上限 (絶対値。前後 1 年 = うるう年の日数) */
export const MENU_PLANS_ADD_DEFAULT_MAX_DATE_OFFSET_DAYS = 366;

/**
 * date_offset_days の上限 (絶対値)。環境変数 MENU_PLANS_ADD_MAX_DATE_OFFSET_DAYS が正の整数ならその値、
 * 未設定・正の整数でない (空・0・負・小数・数字でない) ときは MENU_PLANS_ADD_DEFAULT_MAX_DATE_OFFSET_DAYS
 */
export function menuPlansAddMaxDateOffsetDays(
  value: string | undefined = process.env.MENU_PLANS_ADD_MAX_DATE_OFFSET_DAYS,
): number {
  if (value === undefined || value.trim() === '') return MENU_PLANS_ADD_DEFAULT_MAX_DATE_OFFSET_DAYS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : MENU_PLANS_ADD_DEFAULT_MAX_DATE_OFFSET_DAYS;
}

/**
 * 本文の date_offset_days を、開始日のずらしの日数 (整数) にする。
 *   - 数値でない・有限でない (NaN / Infinity)・無い → 0 (今日。以前と同じ)
 *   - 小数 → 0 の方向へ切り捨て (以前と同じ)
 *   - 切り捨てた絶対値が上限 (menuPlansAddMaxDateOffsetDays) を超える → null (ルートが 400 にする)
 */
export function parseMenuPlanDateOffsetDays(value: unknown, maxAbsDays: number = menuPlansAddMaxDateOffsetDays()): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const offsetDays = Math.trunc(value);
  return Math.abs(offsetDays) > maxAbsDays ? null : offsetDays;
}
