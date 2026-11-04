// 買い物リストの範囲 (今日の分・明日の分・明後日の分・○日分・1週間分・表示中の週) の始まりと終わりの日付 (#2235 I3)。
// 範囲を選ぶ欄 (ShoppingRangeModal) が各選択肢に出す日付と、買い物リストを作る範囲 (page.tsx の calculateDateRange が
// /api/shopping-list/regenerate へ送る startDate / endDate と、献立があるかの判定に使う範囲) は、どちらもこの関数で求める
// (2 か所で別々に書くと、欄の表示は正しいのに送る範囲だけ 1 日ずれる、という食い違いが起きうるため)。
import { addDaysToDate, formatLocalDate } from '@homegohan/shared';
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
  /** 時計を 1 回だけ読んだ時刻。この時刻の JST の今日 (formatLocalDate) から暦の計算だけで数える */
  now: Date;
  /** 「○日分」の日数 (clampShoppingRangeDays で丸めてから使う) */
  daysCount: number;
  /** カレンダーで表示中の週の始まり (「表示中の週」の範囲。今日から数える範囲とは別) */
  currentWeekStart: Date;
}

/**
 * 選択肢 type の範囲の始まりと終わり。
 * 今日から数える範囲は、now の JST の今日から addDaysToDate (暦の計算) でずらす。端末のローカル時刻で日をずらしてから
 * JST の日付にすると (new Date + setDate + formatLocalDate)、端末の夏時間の切り替えの日に 23 / 25 時間しか進まず、JST の日付が 1 日ずれうる。
 * 「指定」(custom) は今日だけ (この関数を入れる前の calculateDateRange の default と同じ)。
 */
export function shoppingRangeDates(type: ShoppingRangeType, basis: ShoppingRangeBasis): ShoppingRangeDates {
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
    case 'currentWeek': {
      const weekStart = formatLocalDate(basis.currentWeekStart);
      return { startDate: weekStart, endDate: addDaysToDate(weekStart, SHOPPING_RANGE_WEEK_DAYS - 1) };
    }
  }
}

/** 買い物リストを作る依頼の範囲 (/api/shopping-list/regenerate へ送る startDate / endDate / mealTypes) */
export interface ShoppingRangeRequest extends ShoppingRangeDates {
  mealTypes: readonly ShoppingRangeMealType[];
}

/** 選んだ範囲 range から、買い物リストを作る依頼の範囲を求める (今日の分だけは選んだ食事、ほかは 3 食とも) */
export function shoppingRangeRequest(
  range: ShoppingRangeSelection,
  basis: Omit<ShoppingRangeBasis, 'daysCount'>,
): ShoppingRangeRequest {
  return {
    ...shoppingRangeDates(range.type, { ...basis, daysCount: range.daysCount }),
    mealTypes: range.type === 'today' ? range.todayMeals : SHOPPING_RANGE_ALL_MEALS,
  };
}
