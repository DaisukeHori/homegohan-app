/**
 * 買い物リストの作り直しのリクエストの行 (shopping_list_requests.result) を、画面へ返すときの形 (#1172)
 *
 * result は Edge Function (regenerate-shopping-list-v2) が書く。成功は { stats }、失敗は { error }。
 * 失敗の error には、同意の判定で止めたときの人向けの文のほかに、catch で捕まえた例外の文面がそのまま入る
 * (DB (PostgREST) の生のエラー文・外部の AI の応答の本文 'Fast LLM API error: 500 - ...' など)。
 * GET /api/shopping-list/regenerate/status は result を応答の本文に入れ、Web とアプリの画面は result.error を
 * そのまま表示するので、ここで絞る。元の文は Edge Function が構造化ログ (app_logs) に残している。
 *
 * そのまま返してよい result.error (画面が見分ける、こちらで書いた文) は次のものだけ。それ以外は固定の文にする。
 *   - AI_CONSENT_REQUIRED_MESSAGE / AI_CONSENT_CHECK_FAILED_MESSAGE: 同意の判定で止めた (T15 / #1154)。
 *     Edge Function が aiConsentDeniedStoredMessage で書き、画面は aiConsentReasonOfStoredError でこの文を見分けて同意画面へ案内する
 *   - SHOPPING_LIST_REQUEST_FAILED_MESSAGE: それ以外の失敗の固定の文
 *
 * 絞るのは読む側 (GET /api/shopping-list/regenerate/status) だけ。Supabase Realtime で行を直接受ける画面の経路と、
 * 書く側 (Edge Function) はこの変更の範囲の外 (献立生成の行 weekly_menu_requests.error_message の Edge Function の書き手と同じ扱い)。
 * この表はアカウントのデータ書き出しには出さない (src/lib/account-export-tables.ts の ACCOUNT_EXPORT_EXCLUDED)。
 */
import { aiConsentReasonOfStoredError } from '../../supabase/functions/_shared/ai-consent';

/** それ以外の失敗の固定の文 */
export const SHOPPING_LIST_REQUEST_FAILED_MESSAGE = '買い物リストの再生成に失敗しました。もう一度お試しください。';

/** result.error として画面へそのまま返してよい文か (こちらで書いた文だけ) */
function isKnownShoppingListRequestErrorMessage(value: unknown): value is string {
  return value === SHOPPING_LIST_REQUEST_FAILED_MESSAGE || aiConsentReasonOfStoredError(value) !== null;
}

/**
 * 行の result.error を応答の本文に入れるときの文。
 * 空 (null・undefined・空文字) はそのまま返す (画面は自分の既定の文を出す)。こちらで書いた文はそのまま、
 * それ以外 (文字列でない値を含む) は固定の文にする。
 */
export function shoppingListRequestErrorMessageForResponse(stored: unknown): string | null | undefined {
  if (stored === null || stored === undefined || stored === '') return stored;
  return isKnownShoppingListRequestErrorMessage(stored) ? stored : SHOPPING_LIST_REQUEST_FAILED_MESSAGE;
}

/**
 * 行の result を応答の本文に入れるときの形。
 *   - null・undefined は null
 *   - オブジェクトでない値 (文字列・数・配列) は null。書き手 (Edge Function) はオブジェクトしか書かないので、
 *     それ以外の形は中身を確かめずに返さない
 *   - オブジェクトは、error だけを shoppingListRequestErrorMessageForResponse で絞り、ほかの項目 (成功の stats など) はそのまま
 */
export function shoppingListRequestResultForResponse(result: unknown): Record<string, unknown> | null {
  if (result === null || result === undefined || typeof result !== 'object' || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  if (!('error' in record)) return record;
  return { ...record, error: shoppingListRequestErrorMessageForResponse(record.error) };
}
