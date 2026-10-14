/**
 * 献立の生成のリクエストの行 (weekly_menu_requests.error_message) を画面に出すときの文 (モバイル。#1478)
 *
 * error_message は Edge Function (generate-menu-v4 / v5) と Next.js の API が書き、アプリは Supabase Realtime や
 * 直接の select (src/hooks/useV4MenuGeneration.ts) で受けて、そのまま表示する。
 * 書く側は #1478 から、例外の文面を書かずに定型の文 (supabase/functions/_shared/stored-failure-messages.ts) を書くが、
 * それより前に書かれた行には生の文が残っている。そのため読む側でも、こちらで書いた文だけをそのまま出し、
 * それ以外は汎用の文 (MENU_REQUEST_FAILED_MESSAGE) に寄せる。
 *
 * こちらで書いた文 (Web の src/lib/weekly-menu-request-error.ts の isKnownWeeklyMenuRequestErrorMessage と同じ):
 *   - MENU_REQUEST_FIXED_MESSAGES (失敗・既存の献立を守った・一部だけ保存・進まなくなった・中止)
 *   - 同意の判定で止めたときの文 (aiConsentReasonOfStoredError。画面は handleStoredAiConsentFailure で見分けて同意画面へ案内する)
 *   - 上限で止めたときの文 (isAiDailyLimitMessage。1 日の上限 (#1149) と究極モードの 1 日の上限 (#1142) の文)
 */
import { aiConsentReasonOfStoredError } from "../../../../supabase/functions/_shared/ai-consent";
import { isAiDailyLimitMessage } from "../../../../supabase/functions/_shared/ai-daily-limit";
import {
  MENU_REQUEST_FAILED_MESSAGE,
  MENU_REQUEST_FIXED_MESSAGES,
} from "../../../../supabase/functions/_shared/stored-failure-messages";

export { MENU_REQUEST_FAILED_MESSAGE };

/** こちらで書いた文か */
export function isKnownMenuRequestErrorMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (MENU_REQUEST_FIXED_MESSAGES.includes(value) ||
      aiConsentReasonOfStoredError(value) !== null ||
      isAiDailyLimitMessage(value))
  );
}

/**
 * 行の error_message を画面に出すときの文。空 (null・undefined・空文字) は null (画面は自分の既定の文を出す)、
 * こちらで書いた文はそのまま、それ以外 (文字列でない値を含む) は汎用の文
 */
export function menuRequestErrorMessageForDisplay(stored: unknown): string | null {
  if (stored === null || stored === undefined || stored === "") return null;
  return isKnownMenuRequestErrorMessage(stored) ? stored : MENU_REQUEST_FAILED_MESSAGE;
}
