/**
 * 日付ユーティリティ — @homegohan/shared からの再エクスポート。
 *
 * 既存のインポートパス "@/lib/date-utils" を維持しつつ、
 * 実装の canonical ソースを packages/shared に一本化する。
 */
export { formatLocalDate, todayLocal, parseLocalDate, addDays, daysUntilLocal, formatExpiry, formatDateJa } from '@homegohan/shared';
