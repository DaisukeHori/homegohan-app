// 買い物リストの範囲 (今日の分・明日の分・明後日の分・○日分・1週間分・表示中の週) の始まりと終わりの日付 (#2235 I3)。
// 範囲を選ぶ欄 (ShoppingRangeModal) が各選択肢に出す日付と、買い物リストを作る範囲 (page.tsx の calculateDateRange が
// /api/shopping-list/regenerate へ送る startDate / endDate と、献立があるかの判定に使う範囲) は、どちらもこの関数で求める
// (2 か所で別々に書くと、欄の表示は正しいのに送る範囲だけ 1 日ずれる、という食い違いが起きうるため)。
import { addDaysToDate, formatLocalDate, isCalendarDate } from '@homegohan/shared';
import type { ShoppingRangeSelection, ShoppingRangeType } from './shoppingStore';

/** 1 週間の日数。「1週間分」は今日を含む 7 日、「表示中の週」は週の始まりの日を含む 7 日 */
export const SHOPPING_RANGE_WEEK_DAYS = 7;

/** 「○日分」の日数の下限 (今日の 1 日だけ)。日数の欄の min にも使う */
export const SHOPPING_RANGE_DAYS_MIN = 1;

/**
 * 「○日分」の日数の上限 (2 週間)。日数の欄の max にも使う。
 * 欄の max 属性は打ち込みを止めないので、範囲の外の値 (3000000 や -800000) は clampShoppingRangeDays で丸める
 * (丸めないと、暦の計算で扱える範囲の外の日付になり addDaysToDate が RangeError を投げる)
 */
export const SHOPPING_RANGE_DAYS_MAX = 14;

/**
 * 表示中の週が扱える日付の外 (shoppingRangeDates の currentWeek が null) のときに、範囲を選ぶ欄が日付の代わりに出す文 (#2245 K4)。
 * この週の買い物リストは作れない (依頼の API が範囲の外の日を断る) ので、欄はこの選択肢を選べなくする
 */
export const SHOPPING_RANGE_CURRENT_WEEK_UNAVAILABLE_LABEL = 'この週は選べません';

/** 買い物リストを作る範囲が求まらない (shoppingRangeRequest が null) ときに、作らずに出す知らせの文 (#2245 K4) */
export const SHOPPING_RANGE_UNAVAILABLE_MESSAGE = '表示中の週の日付が扱える範囲の外です。別の範囲を選ぶか、今日の週に戻してからお試しください。';

/** 「明日の分」は今日の 1 日後 */
const TOMORROW_OFFSET_DAYS = 1;

/** 「明後日の分」は今日の 2 日後 */
const DAY_AFTER_TOMORROW_OFFSET_DAYS = 2;

/** 今日の分のほかは、3 食とも買い物リストに入れる */
export const SHOPPING_RANGE_ALL_MEALS = ['breakfast', 'lunch', 'dinner'] as const;

/** 買い物リストの食事の区分 */
export type ShoppingRangeMealType = ShoppingRangeSelection['todayMeals'][number];

/**
 * 「○日分」の日数を SHOPPING_RANGE_DAYS_MIN 〜 SHOPPING_RANGE_DAYS_MAX の整数に丸める。
 * 数でないもの (NaN・Infinity) は下限、小数は切り捨て。
 */
export function clampShoppingRangeDays(daysCount: number): number {
  if (!Number.isFinite(daysCount)) return SHOPPING_RANGE_DAYS_MIN;
  return Math.min(SHOPPING_RANGE_DAYS_MAX, Math.max(SHOPPING_RANGE_DAYS_MIN, Math.trunc(daysCount)));
}

/** 範囲の始まりと終わりの暦日 (YYYY-MM-DD。両端を含む) */
export interface ShoppingRangeDates {
  startDate: string;
  endDate: string;
}

export interface ShoppingRangeBasis {
  /**
   * 時計を 1 回だけ読んだ時刻。この時刻の JST の今日 (formatLocalDate) から暦の計算だけで数える。
   * 買い物リストを作る範囲 (page.tsx の calculateDateRange) には、範囲を選ぶ欄が日付を出すのに読んだ時刻を渡す (#2254 M2)
   */
  now: Date;
  /** 「○日分」の日数 (clampShoppingRangeDays で丸めてから使う) */
  daysCount: number;
  /**
   * カレンダーで表示中の週の始まり (「表示中の週」の範囲。今日から数える範囲とは別)。
   * 週の格子 (page.tsx の getWeekDates) と同じく、端末の 0 時の Date を formatLocalDate で読んだ日を週の始まりにする。
   * JST より東の端末では週の格子ごと 1 日前の日になるが、範囲は格子の 7 日の dateStr (献立の日付) とそろう。
   * 週の格子の作り方を直すときは、この読み方も一緒に変える (ここだけ変えると、範囲と格子の 7 日が 1 日ずれる)。
   * 表示中の週は ?date= (手で打てる URL) や週送りで暦の端 (9999 年・1000 年より前) まで動かせるので、この日は確かめてから使う
   * (shoppingRangeDates の currentWeek。#2245 K4)
   */
  currentWeekStart: Date;
}

/**
 * 「表示中の週」の範囲 (週の始まりの日を含む 7 日)。始まりと終わりがどちらも isCalendarDate (CALENDAR_DATE_MIN 〜 CALENDAR_DATE_MAX の
 * 実在する YYYY-MM-DD) のときだけ範囲を返し、そうでなければ null (#2245 K4)。
 * 範囲を選ぶ欄 (ShoppingRangeModal) は描画のたびにこの範囲を求めるので、投げない。週の始まりが暦の計算で扱える範囲の端
 * (9999-12-27 以降) だと addDaysToDate が RangeError を投げ、CALENDAR_DATE_MIN より前の週 ("0100-12-27" など) は isCalendarDate を通らない
 * (#2245 K4 のときは formatLocalDate が 1000 年より前の年を 4 桁で書かず ("100-12-27")、YYYY-MM-DD として読めなかった。#2254 M2 で 4 桁にした)。終わりも確かめるのは、買い物リストを作る依頼 (/api/shopping-list/regenerate) が両端を isCalendarDate で
 * 確かめ、範囲の外の日を 400 で断るため (欄に出しても作れない範囲を出さない)
 */
function currentWeekRangeDates(currentWeekStart: Date): ShoppingRangeDates | null {
  const weekStart = formatLocalDate(currentWeekStart);
  if (!isCalendarDate(weekStart)) return null;
  // 始まりが CALENDAR_DATE_MAX 以下なら、6 日後は暦の計算で扱える範囲の中 (CALENDAR_DATE_SHIFT_MARGIN_DAYS の余白の内側) なので投げない
  const weekEnd = addDaysToDate(weekStart, SHOPPING_RANGE_WEEK_DAYS - 1);
  return isCalendarDate(weekEnd) ? { startDate: weekStart, endDate: weekEnd } : null;
}

/**
 * 選択肢 type の範囲の始まりと終わり。
 * 今日から数える範囲は、now の JST の今日から addDaysToDate (暦の計算) でずらす。端末のローカル時刻で日をずらしてから
 * JST の日付にすると (new Date + setDate + formatLocalDate)、端末の夏時間の切り替えの日に 23 / 25 時間しか進まず、JST の日付が 1 日ずれうる。
 * custom (範囲を選ぶ欄には無い選択肢) は今日だけ (この関数を入れる前の calculateDateRange の default と同じ)。
 * 表示中の週 (currentWeek) だけは、週が扱える日付の外にあると null (currentWeekRangeDates。#2245 K4)。ほかは時計の今日から数えるので null にならない。
 */
export function shoppingRangeDates(type: Exclude<ShoppingRangeType, 'currentWeek'>, basis: ShoppingRangeBasis): ShoppingRangeDates;
export function shoppingRangeDates(type: ShoppingRangeType, basis: ShoppingRangeBasis): ShoppingRangeDates | null;
export function shoppingRangeDates(type: ShoppingRangeType, basis: ShoppingRangeBasis): ShoppingRangeDates | null {
  const today = formatLocalDate(basis.now);
  switch (type) {
    case 'today':
    case 'custom':
      return { startDate: today, endDate: today };
    case 'tomorrow': {
      const tomorrow = addDaysToDate(today, TOMORROW_OFFSET_DAYS);
      return { startDate: tomorrow, endDate: tomorrow };
    }
    case 'dayAfterTomorrow': {
      const dayAfter = addDaysToDate(today, DAY_AFTER_TOMORROW_OFFSET_DAYS);
      return { startDate: dayAfter, endDate: dayAfter };
    }
    case 'week':
      return { startDate: today, endDate: addDaysToDate(today, SHOPPING_RANGE_WEEK_DAYS - 1) };
    case 'days':
      return { startDate: today, endDate: addDaysToDate(today, clampShoppingRangeDays(basis.daysCount) - 1) };
    case 'currentWeek':
      return currentWeekRangeDates(basis.currentWeekStart);
  }
}

/** 買い物リストを作る依頼の範囲 (/api/shopping-list/regenerate へ送る startDate / endDate / mealTypes) */
export interface ShoppingRangeRequest extends ShoppingRangeDates {
  mealTypes: readonly ShoppingRangeMealType[];
}

/**
 * 選んだ範囲 range から、買い物リストを作る依頼の範囲を求める (今日の分だけは選んだ食事、ほかは 3 食とも)。
 * 範囲が求まらない (表示中の週が扱える日付の外。shoppingRangeDates が null) ときは null (#2245 K4)
 */
export function shoppingRangeRequest(
  range: ShoppingRangeSelection,
  basis: Omit<ShoppingRangeBasis, 'daysCount'>,
): ShoppingRangeRequest | null {
  const dates = shoppingRangeDates(range.type, { ...basis, daysCount: range.daysCount });
  if (dates === null) return null;
  return {
    ...dates,
    mealTypes: range.type === 'today' ? range.todayMeals : SHOPPING_RANGE_ALL_MEALS,
  };
}
