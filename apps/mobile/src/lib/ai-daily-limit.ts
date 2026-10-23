/**
 * AI の 1 日の利用回数の上限 (#1149 / T40): サーバーに「今日の上限に達しました」で止められたときの文 (モバイル)
 *
 * AI へ送る API は、上限に達していれば送らずに 429 { error, code: "AI_DAILY_LIMIT", limit, retryAfter } を返し、
 * ご利用中のプランでは使えない機能なら 403 { error, code: "AI_FEATURE_NOT_IN_PLAN", feature } を返す (billing/03 §8.8)。
 * @homegohan/core の createHttpClient はこれを `HTTP 429 Too Many Requests: {...}` の Error にして投げるので、
 * 画面が e.message をそのまま出すと、生の文字列 (JSON) が出てしまう。
 * getApi() (src/lib/api.ts) は、この Error を AiDailyLimitError (message が固定の文) に置き換えて投げ直す。
 * そのため、各画面の `Alert.alert("エラー", e.message)` や getApiErrorMessage(e, ...) は、そのまま
 * 「今日の AI の利用回数の上限 (N 回) に達しました。明日 0 時から使えます。」(N はプランごとの上限) などの固定の文を出す。
 * 文は本文の error をそのまま使わず、limit・feature から作る (supabase/functions/_shared/ai-daily-limit.ts。Web と共用)。
 *
 * getApi() を通らない生の fetch (ストリーミングで受ける AI 相談の送信・1 食の作り直し) には、getApi() の置き換えが効かない。
 * これらは失敗の応答から errorOfFailedResponse (src/lib/failed-response.ts) で Error を作って投げる
 * (429 AI_DAILY_LIMIT なら AiDailyLimitError。503 の緊急停止・メンテナンス中 (#1457) も同じ関数で固定の文にする)。
 * 生の fetch で AI の API を呼ぶ場所が、この関数を通っているかは tests/ai-daily-limit-mobile-raw-fetch.test.ts が見張る。
 */
import {
  AI_DAILY_LIMIT_STATUS,
  AI_FEATURE_NOT_IN_PLAN_STATUS,
  aiDailyLimitMessageOfStatusAndBody,
} from "../../../../supabase/functions/_shared/ai-daily-limit";

export {
  AI_AUTO_SAFETY_CAP_MESSAGE,
  AI_DAILY_LIMIT_FALLBACK_MESSAGE,
  aiDailyLimitMessage,
} from "../../../../supabase/functions/_shared/ai-daily-limit";

// "HTTP 429 Too Many Requests: {...}" / HTTP/2 で statusText が空の "HTTP 429 : {...}" (api-error.ts と同じ形)
const HTTP_ERROR_PATTERN = /^HTTP (\d{3})[^:]*:\s*([\s\S]+)$/;

/** 「今日の AI の利用回数の上限に達しました」で止められたことを表す例外。message は画面にそのまま出せる固定の文 */
export class AiDailyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiDailyLimitError";
  }
}

export function isAiDailyLimitError(error: unknown): error is AiDailyLimitError {
  return error instanceof AiDailyLimitError;
}

/**
 * API クライアントが投げた Error が「止めた」(HTTP 429 + AI_DAILY_LIMIT の本文、または HTTP 403 + AI_FEATURE_NOT_IN_PLAN の本文) なら、
 * 画面に出す文の AiDailyLimitError を返す。組が合わないもの (レート制限の 429・同意の 403・403 + AI_DAILY_LIMIT)・ほかの状態・
 * JSON でない本文は null。
 */
export function aiDailyLimitErrorOf(error: unknown): AiDailyLimitError | null {
  if (isAiDailyLimitError(error)) return error;
  const raw = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof raw !== "string") return null;
  const match = HTTP_ERROR_PATTERN.exec(raw);
  if (!match) return null;
  const status = Number(match[1]);
  if (status !== AI_DAILY_LIMIT_STATUS && status !== AI_FEATURE_NOT_IN_PLAN_STATUS) return null;
  try {
    const message = aiDailyLimitMessageOfStatusAndBody(status, JSON.parse(match[2]));
    return message ? new AiDailyLimitError(message) : null;
  } catch {
    return null;
  }
}
