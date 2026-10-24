/**
 * 画面で選んだ日付 (YYYY-MM-DD の実在する日付) を受け取るクエリの値の Zod スキーマ (#1433)。
 *
 * 期間の開始日・終了日を timestamptz の列 (created_at など) と比べるルートは、日付の文字列をそのまま渡さず
 * src/lib/jst-day-ranges.ts の jstDayRangeTimestamps / jstOptionalDayRangeTimestamps で JST 0 時の時刻に直してから絞る。
 * 2026-02-30 のような存在しない日付を通すと、時刻に直すところで RangeError になり 500 になるので、入口で 400 にする。
 * 9999-12-31 のような端の日付も、終了日の翌日を求めるところで RangeError になるので、isCalendarDate の範囲
 * (CALENDAR_DATE_MIN 〜 CALENDAR_DATE_MAX。前後 1 年の余白つき) の外は 400 にする。
 */
import { z } from 'zod';
import { invalidCalendarDateMessage } from '@/lib/api/user-api-error-messages';
import { isCalendarDate } from '@/lib/date-utils';

/** CalendarDateSchema の失敗の文の項目の名前 (スキーマはどの項目に使われるかを知らない) */
const CALENDAR_DATE_SCHEMA_LABEL = '日付';

export const CalendarDateSchema = z.string().refine(isCalendarDate, {
  // 文は利用者向けの API の日付の 400 の文と同じ作り手 (invalidCalendarDateMessage) で作る (#1917 で 1 つにそろえた。
  // スキーマは項目名を知らないので、名前は「日付」)
  message: invalidCalendarDateMessage(CALENDAR_DATE_SCHEMA_LABEL),
});

/**
 * 空欄 (空文字) を「指定なし」(undefined) として受ける CalendarDateSchema の省略可能版。
 * 画面の日付の入力が空のまま届きうる API (GET /api/admin/finance/nps の ?from=&to= など) で、
 * 以前の `z.string().optional()` + `if (from)` と同じく、空文字は「その側を絞らない」にする。空でない値は CalendarDateSchema と同じく、実在する日付 (受け付ける範囲の中) だけを通す。
 */
export const OptionalCalendarDateSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  CalendarDateSchema.optional(),
);
