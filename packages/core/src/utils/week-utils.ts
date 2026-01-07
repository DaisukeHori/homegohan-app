/**
 * 週計算のユーティリティ関数
 * 週の開始曜日をユーザー設定に基づいて柔軟に計算する
 */

export type WeekStartDay = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

const DAY_MAP: Record<WeekStartDay, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

const REVERSE_DAY_MAP: Record<number, WeekStartDay> = {
  0: 'sunday',
  1: 'monday',
  2: 'tuesday',
  3: 'wednesday',
  4: 'thursday',
  5: 'friday',
  6: 'saturday'
};

/**
 * 指定した日付を含む週の開始日と終了日を取得
 * @param date 基準日
 * @param weekStartDay 週の開始曜日（デフォルト: monday）
 * @returns { start: Date, end: Date }
 */
export function getWeekRange(date: Date, weekStartDay: WeekStartDay = 'monday'): { start: Date; end: Date } {
  const startDayNum = DAY_MAP[weekStartDay];
  const currentDay = date.getDay();
  const diff = (currentDay - startDayNum + 7) % 7;
  
  const start = new Date(date);
  start.setDate(date.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  
  return { start, end };
}

/**
 * 日付をローカル形式の文字列（YYYY-MM-DD）に変換
 * @param date 日付
 * @returns YYYY-MM-DD形式の文字列
 */
export function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * YYYY-MM-DD形式の文字列をDateに変換
 * @param dateStr YYYY-MM-DD形式の文字列
 * @returns Date
 */
export function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * 指定した日付の曜日を取得（WeekStartDay形式）
 * @param date 日付
 * @returns WeekStartDay
 */
export function getDayOfWeek(date: Date): WeekStartDay {
  return REVERSE_DAY_MAP[date.getDay()];
}

/**
 * 日付が指定した週の範囲内かどうかを判定
 * @param date チェックする日付
 * @param weekStartDate 週の開始日
 * @param weekEndDate 週の終了日
 * @returns boolean
 */
export function isDateInWeek(date: Date, weekStartDate: Date, weekEndDate: Date): boolean {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const start = new Date(weekStartDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(weekEndDate);
  end.setHours(23, 59, 59, 999);
  return d >= start && d <= end;
}

/**
 * 週をn週分ずらす
 * @param date 基準日
 * @param weeks ずらす週数（正: 未来、負: 過去）
 * @param weekStartDay 週の開始曜日
 * @returns { start: Date, end: Date }
 */
export function shiftWeek(date: Date, weeks: number, weekStartDay: WeekStartDay = 'monday'): { start: Date; end: Date } {
  const { start } = getWeekRange(date, weekStartDay);
  const newStart = new Date(start);
  newStart.setDate(newStart.getDate() + weeks * 7);
  return getWeekRange(newStart, weekStartDay);
}

/**
 * 2つの日付間の日数を計算
 * @param start 開始日
 * @param end 終了日
 * @returns 日数（終了日を含む）
 */
export function getDaysBetween(start: Date, end: Date): number {
  const startMs = new Date(start).setHours(0, 0, 0, 0);
  const endMs = new Date(end).setHours(0, 0, 0, 0);
  return Math.floor((endMs - startMs) / (1000 * 60 * 60 * 24)) + 1;
}

/**
 * 指定した日付範囲内のすべての日付を配列で取得
 * @param start 開始日
 * @param end 終了日
 * @returns Date[]
 */
export function getDateRange(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(0, 0, 0, 0);
  
  while (current <= endDate) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  
  return dates;
}

/**
 * 今日から指定した日数後の日付を取得
 * @param days 日数
 * @returns Date
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}
