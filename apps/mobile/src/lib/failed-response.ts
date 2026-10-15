/**
 * getApi() を通らない生の fetch で、API が失敗の応答を返したときに投げる Error を作る (モバイル)
 *
 * サーバーが「止めた」ことを表す次の 2 つの応答は、本文の文字列 (JSON) ではなく、画面にそのまま出せる固定の文の例外にする。
 *   - 429 AI_DAILY_LIMIT (今日の AI の利用回数の上限に達した。#1149): AiDailyLimitError (src/lib/ai-daily-limit.ts)
 *   - 503 AI_CHAT_DISABLED (AI 相談の緊急停止中)・503 MAINTENANCE_MODE (メンテナンス中) (#1457)・
 *     503 AI_CONSENT_CHECK_FAILED (同意の状況を読めなかった。#1486): ServiceUnavailableError (src/lib/service-unavailable.ts)
 * getApi() (src/lib/api.ts の withFriendlyErrors) は、同じ 2 つの判定で getApi() の Error を置き換える。
 * 生の fetch (ストリーミングで受ける AI 相談の送信・1 食の作り直し・献立の削除や完了の切り替え・書き出し・買い物リストの全削除)
 * にはその置き換えが効かないので、この関数を通す。
 * 通しているかは tests/ai-daily-limit-mobile-raw-fetch.test.ts (アプリの API を呼ぶ生の fetch の全部。#1486) と
 * tests/mobile-service-unavailable-raw-fetch.test.ts (AI 相談を呼ぶファイル) が見張る。
 */
import { aiDailyLimitErrorOf, isAiDailyLimitError, type AiDailyLimitError } from "./ai-daily-limit";
import {
  isServiceUnavailableError,
  SERVICE_UNAVAILABLE_ALERT_TITLE,
  serviceUnavailableErrorOf,
  type ServiceUnavailableError,
} from "./service-unavailable";

/** 上限 (429 AI_DAILY_LIMIT) を Alert で出すときの見出し (#1149 で決めた見出しのまま) */
const AI_DAILY_LIMIT_ALERT_TITLE = "エラー";

/** サーバーに止められたことを表す例外 (message は画面にそのまま出せる固定の文) */
export type StoppedByServerError = AiDailyLimitError | ServiceUnavailableError;

export function isStoppedByServerError(error: unknown): error is StoppedByServerError {
  return isAiDailyLimitError(error) || isServiceUnavailableError(error);
}

/** 止められたことを Alert で出すときの見出し: 緊急停止・メンテナンス中 (#1457)・同意の状況を読めなかった (#1486) は「ご利用いただけません」、上限 (#1149) は「エラー」 */
export function stoppedByServerAlertTitleOf(error: StoppedByServerError): string {
  return isServiceUnavailableError(error) ? SERVICE_UNAVAILABLE_ALERT_TITLE : AI_DAILY_LIMIT_ALERT_TITLE;
}

/**
 * 失敗の応答の状態と本文から、投げる Error を作る。
 *   - 429 AI_DAILY_LIMIT: 固定の文の AiDailyLimitError
 *   - 503 AI_CHAT_DISABLED / MAINTENANCE_MODE / AI_CONSENT_CHECK_FAILED: 固定の文の ServiceUnavailableError
 *   - それ以外: これまでどおり `HTTP <状態>: <本文>` の Error。同意の 403 の見分け (isAiConsentRequiredError /
 *     handleAiConsentRequiredError) はこの形の message を読むので、形を変えない
 */
export function errorOfFailedResponse(status: number, bodyText: string): Error {
  const raw = new Error(`HTTP ${status}: ${bodyText}`);
  return aiDailyLimitErrorOf(raw) ?? serviceUnavailableErrorOf(raw) ?? raw;
}
