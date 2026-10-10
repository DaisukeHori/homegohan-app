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
 *   - WEEKLY_MENU_REQUEST_STALE_MESSAGE ('stale_request_timeout'): 状態の確認で、進まなくなった行を失敗にした
 *   - WEEKLY_MENU_REQUEST_CANCELLED_MESSAGE ('中止しました'): 利用者が中止した (UX2-11)
 *   - WEEKLY_MENU_REQUEST_FAILED_MESSAGE: それ以外の失敗の固定の文
 *
 * 書く側 (src/app/api の route と、それが呼ぶ markWeeklyMenuRequestFailed) は weeklyMenuRequestStoredErrorMessage を通して書く。
 * 読む側 (GET /api/ai/menu/weekly/status) は weeklyMenuRequestErrorMessageForResponse を通して返す。
 * 読む側でも絞るのは、この変更より前に書かれた行と、Edge Function (generate-menu-v4 / v5) が自分で書く行
 * (例外の文面をそのまま書いている) にも、生の文が入っているため。
 */
import {
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  AI_CONSENT_REQUIRED_MESSAGE,
} from '../../supabase/functions/_shared/ai-consent';

/** それ以外の失敗の固定の文 (画面が error_message の無いときに出す既定の文と同じ) */
export const WEEKLY_MENU_REQUEST_FAILED_MESSAGE = '献立の生成に失敗しました。もう一度お試しください。';
/** 進まなくなった行を状態の確認で失敗にしたときの文 (GET /api/ai/menu/weekly/status・pending の route が書く) */
export const WEEKLY_MENU_REQUEST_STALE_MESSAGE = 'stale_request_timeout';
/** 利用者が中止したときの文 (POST /api/ai/menu/weekly/status が書く) */
export const WEEKLY_MENU_REQUEST_CANCELLED_MESSAGE = '中止しました';

/** 行に書いてよい文・画面へそのまま返してよい文 (こちらで書いた文だけ) */
const KNOWN_WEEKLY_MENU_REQUEST_ERROR_MESSAGES: ReadonlySet<string> = new Set([
  AI_CONSENT_REQUIRED_MESSAGE,
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  WEEKLY_MENU_REQUEST_STALE_MESSAGE,
  WEEKLY_MENU_REQUEST_CANCELLED_MESSAGE,
  WEEKLY_MENU_REQUEST_FAILED_MESSAGE,
]);

/** こちらで書いた文 (上の一覧のどれか) か */
export function isKnownWeeklyMenuRequestErrorMessage(value: unknown): value is string {
  return typeof value === 'string' && KNOWN_WEEKLY_MENU_REQUEST_ERROR_MESSAGES.has(value);
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
