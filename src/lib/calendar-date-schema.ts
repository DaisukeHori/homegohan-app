/**
 * 画面で選んだ日付 (YYYY-MM-DD の実在する日付) を受け取るクエリの値の Zod スキーマ (#1433)。
 *
 * 期間の開始日・終了日を timestamptz の列 (created_at など) と比べるルートは、日付の文字列をそのまま渡さず
 * src/lib/jst-day-ranges.ts の jstDayRangeTimestamps / jstOptionalDayRangeTimestamps で JST 0 時の時刻に直してから絞る。
 * 2026-02-30 のような存在しない日付を通すと、時刻に直すところで RangeError になり 500 になるので、入口で 400 にする。
 */
import { z } from 'zod';
import { isCalendarDate } from '@/lib/date-utils';

export const CalendarDateSchema = z.string().refine(isCalendarDate, {
  message: 'YYYY-MM-DD の実在する日付を指定してください',
});

/**
 * 空欄 (空文字) を「指定なし」(undefined) として受ける CalendarDateSchema の省略可能版。
 * 画面の日付の入力が空のまま届きうる API (GET /api/admin/finance/nps の ?from=&to= など) で、
 * 以前の `z.string().optional()` + `if (from)` と同じく、空文字は「その側を絞らない」にする。空でない値は実在する日付だけを通す。
 */
export const OptionalCalendarDateSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  CalendarDateSchema.optional(),
);
