/**
 * AI の 1 日の利用回数の上限 (#1149 / T40): サーバーに「今日の上限に達しました」で止められたときの文 (モバイル)
 *
 * AI へ送る API は、上限に達していれば送らずに 429 { error, code: "AI_DAILY_LIMIT", limit, retryAfter } を返す。
 * @homegohan/core の createHttpClient はこれを `HTTP 429 Too Many Requests: {...}` の Error にして投げるので、
 * 画面が e.message をそのまま出すと、生の文字列 (JSON) が出てしまう。
 * getApi() (src/lib/api.ts) は、この Error を AiDailyLimitError (message が固定の文) に置き換えて投げ直す。
 * そのため、各画面の `Alert.alert("エラー", e.message)` や getApiErrorMessage(e, ...) は、そのまま
 * 「今日の AI の利用回数の上限 (10 回) に達しました。明日 0 時から使えます。」を出す。
 * 文は本文の error をそのまま使わず、limit から作る (supabase/functions/_shared/ai-daily-limit.ts。Web と共用)。
 */
import {
  AI_DAILY_LIMIT_STATUS,
  aiDailyLimitMessageOfBody,
} from "../../../../supabase/functions/_shared/ai-daily-limit";

export { AI_DAILY_LIMIT_FALLBACK_MESSAGE, aiDailyLimitMessage } from "../../../../supabase/functions/_shared/ai-daily-limit";

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
 * API クライアントが投げた Error が「上限に達して止めた」(429 + AI_DAILY_LIMIT) なら、画面に出す文の AiDailyLimitError を返す。
 * それ以外 (ほかの 429 = レート制限・ほかの状態・JSON でない本文) は null。
 */
export function aiDailyLimitErrorOf(error: unknown): AiDailyLimitError | null {
  if (isAiDailyLimitError(error)) return error;
  const raw = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof raw !== "string") return null;
  const match = HTTP_ERROR_PATTERN.exec(raw);
  if (!match || Number(match[1]) !== AI_DAILY_LIMIT_STATUS) return null;
  try {
    const message = aiDailyLimitMessageOfBody(JSON.parse(match[2]));
    return message ? new AiDailyLimitError(message) : null;
  } catch {
    return null;
  }
}
