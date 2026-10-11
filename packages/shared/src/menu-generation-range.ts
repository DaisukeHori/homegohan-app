/**
 * 献立生成 (V4 / V5) の「期間を指定」で選べる日付の上限 (#1463・#1482)。
 *
 * Web (src/components/ai-assistant/V4GenerateModal.tsx)・モバイル (apps/mobile/src/components/menu/V4GenerateModal.tsx)
 * の画面と、サーバー (POST /api/ai/menu/v4/generate・/v5/generate) が同じ値を使う。
 * 画面だけで止めると、API を直接呼んだときに日付の幅の上限が無く、サーバーの行事の検索 (getEventsForRange) が
 * 1 日ずつ数千年分を回りうる (#1482)。値を変えるときは、画面の説明「最大31日」「今日から1ヶ月先まで」と
 * 献立生成の slot の上限 (31 日 × 3 食 = 93) も合わせて変える (tests/menu-generation-range-1482.test.ts が値を固定する)。
 * 画面とサーバーで同じ値でなければならないので、環境変数での上書きは用意しない。
 */
import { addDaysToDate, isCalendarDate } from './date-utils';

/** 「期間を指定」で選べる期間の長さ (開始日を含む日数)。画面の説明「最大31日」 */
export const MENU_GENERATION_RANGE_MAX_DAYS = 31;

/** 「期間を指定」の開始日の上限 (今日から何日先まで)。「1日だけ」の欄の「今日から1ヶ月先まで」と同じ */
export const MENU_GENERATION_RANGE_START_MAX_DAYS_AHEAD = 30;

/** 「期間を指定」の開始日の上限 (今日から MENU_GENERATION_RANGE_START_MAX_DAYS_AHEAD 日先)。today は YYYY-MM-DD の暦日 */
export function menuGenerationRangeStartMax(today: string): string {
  return addDaysToDate(today, MENU_GENERATION_RANGE_START_MAX_DAYS_AHEAD);
}

/**
 * 「期間を指定」の終了日の上限 (開始日を含む MENU_GENERATION_RANGE_MAX_DAYS 日の最後の日 = 開始日 + 30 日)。
 * 開始日が日付でない (空欄・入力の途中など) ときは上限を付けない (undefined)
 */
export function menuGenerationRangeEndMax(start: string): string | undefined {
  return isCalendarDate(start) ? addDaysToDate(start, MENU_GENERATION_RANGE_MAX_DAYS - 1) : undefined;
}

/**
 * 日付の集まりの幅 (最も早い日〜最も遅い日。両端を含む) が MENU_GENERATION_RANGE_MAX_DAYS 日に収まるか。
 * dates は isCalendarDate を通った YYYY-MM-DD の暦日 (4 桁の年の YYYY-MM-DD どうしは、文字列の大小が日付の前後と同じ)。
 * 空なら true
 */
export function isWithinMenuGenerationRange(dates: readonly string[]): boolean {
  if (dates.length === 0) return true;
  let first = dates[0];
  let last = dates[0];
  for (const date of dates) {
    if (date < first) first = date;
    if (date > last) last = date;
  }
  const endMax = menuGenerationRangeEndMax(first);
  return endMax !== undefined && last <= endMax;
}
