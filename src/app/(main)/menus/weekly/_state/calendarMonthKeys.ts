// 献立表 (/menus/weekly) の月のカレンダーの印を月ごとに読むときの月の鍵 ('YYYY-MM') (#2206 G1・#2259 P2)。
// 鍵は読んだ月の覚え (page.tsx の fetchedMonthsRef)・取り直しの置き場所の鍵 (mealDatesKey) になり、月の初日と末日 (monthRangeOf) に戻す。
import { formatCalendarDate } from '@homegohan/shared';

/** 'YYYY-MM-DD' の頭の 'YYYY-MM' の長さ */
const YEAR_MONTH_LENGTH = 'YYYY-MM'.length;

/**
 * 暦日の Date (端末の 0 時の Date。年月日を端末の暦で読む) の月の鍵 ('YYYY-MM')。
 * 年は formatCalendarDate と同じく 0 埋めの 4 桁 (#2259 P2。以前は年を getFullYear() のまま書き、1000 年より前の月を '101-01' と書いた。
 * #2254 M2 で献立表の addDaysStr を直したのと同じ形)
 */
export const monthKeyOf = (date: Date): string => formatCalendarDate(date).slice(0, YEAR_MONTH_LENGTH);

/** 範囲 [startDate, endDate] (暦日の Date) にかかる月の鍵 ('YYYY-MM') を古い順に */
export const monthKeysBetween = (startDate: Date, endDate: Date): string[] => {
  const keys: string[] = [];
  const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const lastMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  while (cursor <= lastMonth) {
    keys.push(monthKeyOf(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return keys;
};
