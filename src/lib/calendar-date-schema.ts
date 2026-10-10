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
