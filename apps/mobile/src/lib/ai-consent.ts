/**
 * 外国の AI 事業者への提供の同意: サーバーに「同意が必要です」で止められたときに、同意画面へ案内する (T15 / #1154)
 *
 * AI へ送る API は、未同意の利用者のデータを送らずに 403 { error, code: "AI_CONSENT_REQUIRED" } を返す
 * (Web の src/lib/ai/consent-guard.ts。判定の本体は supabase/functions/_shared/ai-consent.ts)。
 * アプリの各 AI 機能の画面は、API の失敗を受けたら、自分のエラー表示の前に handleAiConsentRequiredError(e) を呼ぶ。
 * true が返ったら「同意が必要です」の案内を出したので、自分のエラー表示は出さずに終える。
 *
 *   } catch (e) {
 *     if (handleAiConsentRequiredError(e)) return;
 *     Alert.alert("エラー", getApiErrorMessage(e, "..."));
 *   }
 *
 * 案内の「同意画面を開く」は、アプリの同意画面 (/settings/ai-consent。Web の同じページを WebView で開く) へ移る。
 * 画面を開くと自動で AI に送る処理 (栄養士のコメントなど) は handleAiConsentRequiredError を使わず、
 * isAiConsentRequiredError で見分けて、案内の一文 (AI_CONSENT_AUTOMATIC_LOCKED_NOTE) だけを出す (勝手に案内を出さない)。
 */
import { Alert } from "react-native";
import { router } from "expo-router";

import {
  AI_CONSENT_AUTOMATIC_LOCKED_NOTE,
  AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE,
  AI_CONSENT_REQUIRED_MESSAGE,
  AI_CONSENT_REQUIRED_STATUS,
  AI_CONSENT_SETTINGS_ENTRY_TITLE,
  AI_CONSENT_SKIPPED_NOTE,
  aiSkippedReasonOf,
  aiSummarySkippedNote,
  isAiConsentRequiredBody,
  type AiSkippedReason,
} from "../../../../supabase/functions/_shared/ai-consent";

/**
 * 文面は Web と共用の定義をそのまま使う (2 か所に持たない)。
 *   - AI_CONSENT_AUTOMATIC_LOCKED_NOTE: 画面を開くと自動で作る AI のコメントを、同意が無くて作らなかったときに出す一文
 *   - AI_CONSENT_SKIPPED_NOTE / AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE: 保存と AI の分析を一緒にする画面で、AI の分析を省いたときの一文
 *   - AI_CONSENT_SETTINGS_ENTRY_TITLE: 設定タブの項目の名前 (案内の一文が「設定の「…」から」と指す先)
 *   - aiSkippedReasonOf: 応答の aiSkipped を、出し分けの理由 (consent_required / check_failed) に直す
 *   - aiSummarySkippedNote: AI 相談を閉じた応答の aiSkipped から、要約を省いた旨の一文を選ぶ
 */
export {
  AI_CONSENT_AUTOMATIC_LOCKED_NOTE,
  AI_CONSENT_CHECK_FAILED_SKIPPED_NOTE,
  AI_CONSENT_SETTINGS_ENTRY_TITLE,
  AI_CONSENT_SKIPPED_NOTE,
  aiSkippedReasonOf,
  aiSummarySkippedNote,
  type AiSkippedReason,
};

/** アプリの同意画面 (Web の /settings/ai-consent を WebView で開く画面) */
export const AI_CONSENT_SCREEN_PATH = "/settings/ai-consent";

/** 案内を出してから、次の案内を出さない時間 (ミリ秒)。1 つの操作で複数の API が同時に止められても、案内を重ねない */
const PROMPT_DEDUP_MS = 3_000;

// "HTTP 403 Forbidden: {...}" / HTTP/2 で statusText が空の "HTTP 403 : {...}" (api-error.ts と同じ形)
const HTTP_ERROR_PATTERN = /^HTTP (\d{3})[^:]*:\s*([\s\S]+)$/;

let lastPromptAt = Number.NEGATIVE_INFINITY;

/** テスト用: 案内の重複防止の記録を消す */
export function resetAiConsentPromptForTests(): void {
  lastPromptAt = Number.NEGATIVE_INFINITY;
}

/** API の失敗 (getApi() が投げた Error) が「同意が必要です」(403 + AI_CONSENT_REQUIRED) か */
export function isAiConsentRequiredError(error: unknown): boolean {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== "string") return false;
  const match = HTTP_ERROR_PATTERN.exec(message);
  if (!match || Number(match[1]) !== AI_CONSENT_REQUIRED_STATUS) return false;
  try {
    return isAiConsentRequiredBody(JSON.parse(match[2]));
  } catch {
    return false;
  }
}

/** fetch を直接使う画面 (ストリーミングなど) のための判定。本文は clone して読むので、呼び出し側はあとで本文を読める */
export async function isAiConsentRequiredResponse(res: Response): Promise<boolean> {
  if (res.status !== AI_CONSENT_REQUIRED_STATUS) return false;
  try {
    return isAiConsentRequiredBody(await res.clone().json());
  } catch {
    return false;
  }
}

/** 「同意が必要です」の案内を出す (同意画面へ移るボタン付き)。短い間に何度呼ばれても 1 回だけ出す */
export function promptAiConsentRequired(): void {
  const now = Date.now();
  if (now - lastPromptAt < PROMPT_DEDUP_MS) return;
  lastPromptAt = now;
  Alert.alert("同意が必要です", AI_CONSENT_REQUIRED_MESSAGE, [
    { text: "閉じる", style: "cancel" },
    { text: "同意画面を開く", onPress: () => router.push(AI_CONSENT_SCREEN_PATH) },
  ]);
}

/** API の失敗が「同意が必要です」なら案内を出して true を返す。呼び出し側は true なら自分のエラー表示を省く */
export function handleAiConsentRequiredError(error: unknown): boolean {
  if (!isAiConsentRequiredError(error)) return false;
  promptAiConsentRequired();
  return true;
}
