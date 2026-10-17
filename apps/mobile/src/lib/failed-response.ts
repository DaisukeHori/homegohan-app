/**
 * getApi() を通らない生の fetch で、API が失敗の応答を返したときに投げる Error を作る (モバイル)
 *
 * サーバーが「止めた」ことを表す次の 2 つの応答は、本文の文字列 (JSON) ではなく、画面にそのまま出せる固定の文の例外にする。
 *   - 429 AI_DAILY_LIMIT (今日の AI の利用回数の上限に達した。#1149): AiDailyLimitError (src/lib/ai-daily-limit.ts)
 *   - 503 AI_CHAT_DISABLED (AI 相談の緊急停止中)・503 MAINTENANCE_MODE (メンテナンス中) (#1457)・
 *     503 AI_CONSENT_CHECK_FAILED (同意の状況を読めなかった。#1486): ServiceUnavailableError (src/lib/service-unavailable.ts)
 *   - 403 LEGAL_CONSENT_REQUIRED (規約への同意が必要。#1442): 固定の文の LegalConsentRequiredError (src/lib/legal-consent.ts)。
 *     見分けるときに LegalConsentProvider へ知らせ、ゲートがルートの Stack を同意画面 1 つに畳む
 *   - 403 AUTH_ACCOUNT_FROZEN (アカウントが凍結されている。#1861): 固定の文の AccountFrozenError (src/lib/account-frozen.ts)。
 *     見分けるときに AccountFrozenProvider へ知らせ、ゲートがルートの Stack を凍結の画面 1 つに畳む
 * getApi() (src/lib/api.ts の withFriendlyErrors) は、同じ 2 つの判定で getApi() の Error を置き換える。
 * 生の fetch (ストリーミングで受ける AI 相談の送信・1 食の作り直し・献立の削除や完了の切り替え・書き出し・買い物リストの全削除)
 * にはその置き換えが効かないので、この関数を通す。
 * 通しているかは tests/ai-daily-limit-mobile-raw-fetch.test.ts (アプリの API を呼ぶ生の fetch の全部。#1486) と
 * tests/mobile-service-unavailable-raw-fetch.test.ts (AI 相談を呼ぶファイル) が見張る。
 */
import { accountFrozenErrorOf, isAccountFrozenError, type AccountFrozenError } from "./account-frozen";
import { aiDailyLimitErrorOf, isAiDailyLimitError, type AiDailyLimitError } from "./ai-daily-limit";
import { isLegalConsentRequiredError, legalConsentRequiredErrorOf, type LegalConsentRequiredError } from "./legal-consent";
import {
  isServiceUnavailableError,
  SERVICE_UNAVAILABLE_ALERT_TITLE,
  serviceUnavailableErrorOf,
  type ServiceUnavailableError,
} from "./service-unavailable";

/** 上限 (429 AI_DAILY_LIMIT) を Alert で出すときの見出し (#1149 で決めた見出しのまま) */
const AI_DAILY_LIMIT_ALERT_TITLE = "エラー";

/** 規約への同意が必要 (403 LEGAL_CONSENT_REQUIRED) を Alert で出すときの見出し (AI 同意の案内 promptAiConsentRequired と同じ語) */
const LEGAL_CONSENT_ALERT_TITLE = "同意が必要です";

/** サーバーに止められたことを表す例外 (message は画面にそのまま出せる固定の文) */
export type StoppedByServerError =
  | AiDailyLimitError
  | ServiceUnavailableError
  | LegalConsentRequiredError
  | AccountFrozenError;

export function isStoppedByServerError(error: unknown): error is StoppedByServerError {
  return (
    isAiDailyLimitError(error) ||
    isServiceUnavailableError(error) ||
    isLegalConsentRequiredError(error) ||
    isAccountFrozenError(error)
  );
}

/**
 * 止められたことを Alert で出すときの見出し: 緊急停止・メンテナンス中 (#1457)・同意の状況を読めなかった (#1486)・
 * アカウントの凍結 (#1861。文が「アカウントが凍結されています」) は「ご利用いただけません」、上限 (#1149) は「エラー」
 */
export function stoppedByServerAlertTitleOf(error: StoppedByServerError): string {
  if (isLegalConsentRequiredError(error)) return LEGAL_CONSENT_ALERT_TITLE;
  if (isAccountFrozenError(error)) return SERVICE_UNAVAILABLE_ALERT_TITLE;
  return isServiceUnavailableError(error) ? SERVICE_UNAVAILABLE_ALERT_TITLE : AI_DAILY_LIMIT_ALERT_TITLE;
}

/**
 * 失敗の応答の状態と本文から、投げる Error を作る。
 *   - 429 AI_DAILY_LIMIT: 固定の文の AiDailyLimitError
 *   - 503 AI_CHAT_DISABLED / MAINTENANCE_MODE / AI_CONSENT_CHECK_FAILED: 固定の文の ServiceUnavailableError
 *   - 403 LEGAL_CONSENT_REQUIRED: 固定の文の LegalConsentRequiredError / 403 AUTH_ACCOUNT_FROZEN: 固定の文の AccountFrozenError (#1861)
 *   - それ以外: これまでどおり `HTTP <状態>: <本文>` の Error。同意の 403 の見分け (isAiConsentRequiredError /
 *     handleAiConsentRequiredError) はこの形の message を読むので、形を変えない
 */
export function errorOfFailedResponse(status: number, bodyText: string): Error {
  const raw = new Error(`HTTP ${status}: ${bodyText}`);
  return (
    aiDailyLimitErrorOf(raw) ??
    serviceUnavailableErrorOf(raw) ??
    legalConsentRequiredErrorOf(raw) ??
    accountFrozenErrorOf(raw) ??
    raw
  );
}
