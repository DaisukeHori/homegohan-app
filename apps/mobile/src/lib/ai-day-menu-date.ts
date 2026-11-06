/**
 * モバイルの AI 相談の「1日献立変更」のモーダル (src/components/ai/AIDayMenuModal.tsx) の日付の欄の、既定の日・選べる範囲・
 * 範囲の外のときの理由の一文 (#2283)。
 *
 * 以前のモーダルは、既定が今日で、日付の形と実在だけを見ていたので、過去の日も遠い先の日も依頼できた。Web の AI 相談
 * (src/components/AIChatBubble.tsx) は、既定が明日 (#2245 L1)、選べるのは今日〜DAY_MENU_MAX_OFFSET_DAYS 日後で、範囲の外は
 * 「作成する」を止めて理由の一文 (DAY_MENU_DATE_UNSELECTABLE_MESSAGE) を出す (#2245 K1・L1)。モバイルはルートの src/ を import
 * できない (リポジトリ直下の .easignore が /src/ を除外し、EAS のビルドのアーカイブに入らない) ので、Web の値・文・決め方をここに
 * 写して持つ。一致することは tests/mobile-ai-day-menu-date-2283.test.ts が Web の部品と突き合わせて確かめる。
 *
 * 今日は JST の暦日 (todayLocal)。ずらすのは暦の計算 (addDaysToDate) だけで、端末のタイムゾーンに左右されない (#2235 I8 と同じ)。
 */
import { addDaysToDate, isCalendarDate } from "@homegohan/shared";

/** 1 日分の献立の既定の日を、JST の今日から何日後にするか (表示の日が無い・今日・範囲の外のときの明日。Web と同じ値) */
export const DAY_MENU_DEFAULT_OFFSET_DAYS = 1;

/** 1 日分の献立の日付の欄で選べる最後の日を、JST の今日から何日後にするか (『今日から2週間先まで選択できます』。Web と同じ値) */
export const DAY_MENU_MAX_OFFSET_DAYS = 14;

/** 日付の欄の下に出す、選べる範囲の案内 (Web の日付の欄の下の案内と同じ文) */
export const DAY_MENU_DATE_RANGE_HINT = "今日から2週間先まで選択できます";

/**
 * 日付の欄が空・形の崩れ・範囲の外で「作成する」を止めているときに、欄の下に出す理由の一文 (Web の
 * DAY_MENU_DATE_UNSELECTABLE_MESSAGE と同じ文)
 */
export const DAY_MENU_DATE_UNSELECTABLE_MESSAGE = "この日付では作成できません。今日から2週間先までの日を選んでください";

/** 日付の欄で選べる範囲 (min〜max の暦日。max が null なら上限なし) */
export interface DayMenuDateRange {
  min: string;
  max: string | null;
}

/**
 * JST の暦日 day (YYYY-MM-DD) を offsetDays 日ずらした暦日。描画中に呼ぶので投げない: ずらした先が暦の計算で扱える範囲の外なら
 * null (Web の shiftCalendarDayOrNull と同じ)
 */
function shiftCalendarDayOrNull(day: string, offsetDays: number): string | null {
  try {
    return addDaysToDate(day, offsetDays);
  } catch {
    return null;
  }
}

/** 日付の欄で選べる範囲 (下限は JST の今日、上限は DAY_MENU_MAX_OFFSET_DAYS 日後。上限を計算できなければ null = 上限なし) */
export function dayMenuDateRangeOf(today: string): DayMenuDateRange {
  return { min: today, max: shiftCalendarDayOrNull(today, DAY_MENU_MAX_OFFSET_DAYS) };
}

/**
 * 1 日分の献立を作ってよい日付か。実在する暦日 (isCalendarDate。空の '' や形の崩れは入らない) で、範囲 (min〜max) の中のときだけ
 * (Web の isDayMenuDateSelectable と同じ)
 */
export function isDayMenuDateSelectable(date: string, range: DayMenuDateRange): boolean {
  if (!isCalendarDate(date)) return false;
  // YYYY-MM-DD の同じ桁数の文字列なので、文字列の大小が日付の前後と同じ
  if (date < range.min) return false;
  return range.max === null || date <= range.max;
}

/**
 * 日付の欄の既定の日 (Web の defaultDayMenuDateOf と同じ決め。#2245 L1)。表示の日 (displayedDate) が、今日以外の実在する暦日で
 * 範囲の中ならその日。表示の日が無い・今日・範囲の外なら明日 (今日を黙って作り直さないため)。明日を暦の計算で扱えない日は今日。
 * モバイルの AI 相談はタブの上の丸いボタン (AIFloatingFab) から開き、献立表の表示の日を受け取らないので、今は表示の日が無い (= 明日)
 */
export function defaultDayMenuDateOf(today: string, displayedDate: unknown): string {
  if (
    typeof displayedDate === "string" &&
    displayedDate !== today &&
    isDayMenuDateSelectable(displayedDate, dayMenuDateRangeOf(today))
  ) {
    return displayedDate;
  }
  return shiftCalendarDayOrNull(today, DAY_MENU_DEFAULT_OFFSET_DAYS) ?? today;
}
