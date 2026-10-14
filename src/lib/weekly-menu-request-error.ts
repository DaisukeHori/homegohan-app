/**
 * 献立生成のリクエストの行 (weekly_menu_requests.error_message) に書く失敗の文と、画面へ返す文 (#1172)
 *
 * error_message は GET /api/ai/menu/weekly/status が応答の本文 (errorMessage / error_message) に入れ、
 * Web とアプリの週の献立の画面がそのまま表示する。そのため、ここには DB (PostgREST) の生のエラー文・例外の文面・
 * Edge Function の応答の本文 (状態コード・本文) を入れない。原因は構造化ログ (app_logs) にだけ残す。
 *
 * 行に書いてよい文 (画面が見分ける、こちらで書いた文) は次のものだけ。それ以外の失敗は固定の文にする。
 *   - AI_CONSENT_REQUIRED_MESSAGE / AI_CONSENT_CHECK_FAILED_MESSAGE: 同意の判定で止めた (T15 / #1154)。
 *     画面は aiConsentReasonOfStoredError でこの文を見分けて同意画面へ案内する
 *   - aiDailyLimitMessage(n) など (isAiDailyLimitMessage): 1 日の上限で止めた (#1149。Edge Function が書く)
 *   - WEEKLY_MENU_REQUEST_STALE_MESSAGE ('stale_request_timeout'): 状態の確認で、進まなくなった行を失敗にした
 *   - WEEKLY_MENU_REQUEST_CANCELLED_MESSAGE ('中止しました'): 利用者が中止した (UX2-11)
 *   - MENU_REQUEST_EXISTING_PROTECTED_MESSAGE / MENU_REQUEST_PARTIAL_SAVE_MESSAGE: Edge Function が保存の結果で書く定型の文 (#1478)
 *   - WEEKLY_MENU_REQUEST_FAILED_MESSAGE: それ以外の失敗の固定の文
 *
 * 書く側 (src/app/api の route と、それが呼ぶ markWeeklyMenuRequestFailed) は weeklyMenuRequestStoredErrorMessage を通して書く。
 * Edge Function (generate-menu-v4 / v5) も、例外の文面は書かず、supabase/functions/_shared/stored-failure-messages.ts の
 * 定型の文を書く (#1478)。
 * 読む側 (GET /api/ai/menu/weekly/status・アカウントのデータ書き出し (src/lib/account-export-tables.ts)) は
 * weeklyMenuRequestErrorMessageForResponse を、Realtime や直接の select で行を受ける画面 (src/hooks/useV4MenuGeneration.ts) は
 * weeklyMenuRequestErrorMessageForDisplay を通す。
 * 読む側でも絞るのは、#1172 / #1478 より前に書かれた行に、生の文が入っているため。
 */
import {
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  AI_CONSENT_REQUIRED_MESSAGE,
} from '../../supabase/functions/_shared/ai-consent';
import { isAiDailyLimitMessage } from '../../supabase/functions/_shared/ai-daily-limit';
import {
  MENU_REQUEST_CANCELLED_MESSAGE,
  MENU_REQUEST_FAILED_MESSAGE,
  MENU_REQUEST_FIXED_MESSAGES,
  MENU_REQUEST_STALE_MESSAGE,
} from '../../supabase/functions/_shared/stored-failure-messages';

/** それ以外の失敗の固定の文 (画面が error_message の無いときに出す既定の文と同じ。Edge Function と共用の定型の文) */
export const WEEKLY_MENU_REQUEST_FAILED_MESSAGE = MENU_REQUEST_FAILED_MESSAGE;
/** 進まなくなった行を失敗にしたときの文 (src/lib/weekly-menu-request-stale.ts の markWeeklyMenuRequestStaleIfUnchanged が書く。呼ぶのは GET /api/ai/menu/weekly/status・weekly/pending・meal/pending と POST /api/ai/menu/weekly/cleanup) */
export const WEEKLY_MENU_REQUEST_STALE_MESSAGE = MENU_REQUEST_STALE_MESSAGE;
/** 利用者が中止したときの文 (POST /api/ai/menu/weekly/status が書く) */
export const WEEKLY_MENU_REQUEST_CANCELLED_MESSAGE = MENU_REQUEST_CANCELLED_MESSAGE;

/** 行に書いてよい文・画面へそのまま返してよい文 (こちらで書いた文だけ。1 日の上限の文は isAiDailyLimitMessage で別に見る) */
const KNOWN_WEEKLY_MENU_REQUEST_ERROR_MESSAGES: ReadonlySet<string> = new Set([
  AI_CONSENT_REQUIRED_MESSAGE,
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  ...MENU_REQUEST_FIXED_MESSAGES,
]);

/** こちらで書いた文 (上の一覧のどれか、または 1 日の上限で止めたときの文) か */
export function isKnownWeeklyMenuRequestErrorMessage(value: unknown): value is string {
  return (
    typeof value === 'string' && (KNOWN_WEEKLY_MENU_REQUEST_ERROR_MESSAGES.has(value) || isAiDailyLimitMessage(value))
  );
}

/**
 * 行の error_message に書く文。こちらで書いた文はそのまま、それ以外 (内部の文) は固定の文にする。
 * 内部の文は呼び出し側が構造化ログに残す (この関数は記録しない)。
 */
export function weeklyMenuRequestStoredErrorMessage(rawMessage: unknown): string {
  return isKnownWeeklyMenuRequestErrorMessage(rawMessage) ? rawMessage : WEEKLY_MENU_REQUEST_FAILED_MESSAGE;
}

/**
 * 行の error_message を応答の本文に入れるときの文。
 * 空 (null・空文字) は null のまま返す (画面は自分の既定の文を出す)。こちらで書いた文はそのまま、それ以外は固定の文にする。
 */
export function weeklyMenuRequestErrorMessageForResponse(stored: unknown): string | null {
  if (stored === null || stored === undefined || stored === '') return null;
  return weeklyMenuRequestStoredErrorMessage(stored);
}

/**
 * Realtime や直接の select で受けた行の error_message を画面に出すときの文 (#1478)。
 * 絞り方は weeklyMenuRequestErrorMessageForResponse と同じ (空は null・こちらで書いた文はそのまま・それ以外は固定の文)。
 * null のときは、画面が自分の既定の文を出す
 */
export function weeklyMenuRequestErrorMessageForDisplay(stored: unknown): string | null {
  return weeklyMenuRequestErrorMessageForResponse(stored);
}
