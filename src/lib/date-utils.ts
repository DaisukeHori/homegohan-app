/**
 * 日付ユーティリティ — @homegohan/shared からの再エクスポート。
 *
 * 既存のインポートパス "@/lib/date-utils" を維持しつつ、
 * 実装の canonical ソースを packages/shared に一本化する。
 */
export { formatLocalDate, todayLocal, parseLocalDate, addDays, daysUntilLocal, calculatePeriodLocal, formatExpiry, formatDateJa, addDaysToDate, isCalendarDate, monthLocal, jstDayStartTimestamp, CALENDAR_DATE_MIN, CALENDAR_DATE_MAX, CALENDAR_DATE_REQUIREMENT, CALENDAR_DATE_SHIFT_MARGIN_DAYS } from '@homegohan/shared';
