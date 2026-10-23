/**
 * API エラーから、画面に出すメッセージを取り出す (#1137, #1168)
 *
 * @homegohan/core の createHttpClient は HTTP エラーを
 *   new Error(`HTTP ${status} ${statusText}: ${JSON.stringify(本文)}`)
 * の形で投げる。運営 API のエラー本文は { error: { code, message } } なので、
 * そのまま出すと「HTTP 403 Forbidden: {"error":{"code":"FORBIDDEN",...}}」のようになる。
 * ここでは本文の message だけを取り出す (Web の運営画面が body.error?.message を出すのと同じ)。
 *
 * サーバーから応答を受け取れなかったとき (圏外・機内モード・待ち時間切れ) は、createHttpClient が
 * HttpNetworkError (kind: 'offline' | 'timeout') を投げる。このときは「通信できません」と案内する文面を返す。
 *
 * AI 相談の緊急停止・メンテナンス中の 503 は、本文の文字列ではなく、code から決めた固定の文を返す (#1457)。
 *
 * 取り出せないとき: HTTP のエラー (本文が JSON でない 502 の HTML など) は fallback、それ以外は Error の message か fallback (#1917 の続き)。
 */

import { isHttpNetworkError, type HttpNetworkErrorKind } from "@homegohan/core";

import { serviceUnavailableErrorOf } from "./service-unavailable";

/**
 * 通信できなかったときに、画面に出す文面。
 * getApi() が createHttpClient に渡すので、各画面が `e.message` をそのまま出しても、この文面になる。
 */
export const NETWORK_ERROR_MESSAGES: Record<HttpNetworkErrorKind, string> = {
  offline: "通信できません。インターネットへの接続を確認して、もう一度お試しください。",
  timeout: "通信できません。応答に時間がかかっています。電波の良い場所で、もう一度お試しください。",
};

// "HTTP 403 Forbidden: {...}" / HTTP/2 で statusText が空の "HTTP 403 : {...}" のどちらにも一致させる
const HTTP_ERROR_PATTERN = /^HTTP \d{3}[^:]*:\s*([\s\S]+)$/;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** { error: { message } } / { error: "..." } / { message: "..." } の順に message を探す */
function messageFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { error, message } = body as { error?: unknown; message?: unknown };
  if (error && typeof error === "object") {
    const nested = nonEmptyString((error as { message?: unknown }).message);
    if (nested) return nested;
  }
  return nonEmptyString(error) ?? nonEmptyString(message);
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (isHttpNetworkError(error)) return NETWORK_ERROR_MESSAGES[error.kind];
  // AI 相談の緊急停止・メンテナンス中の 503 は、本文の文字列ではなく固定の文 (#1457。src/lib/service-unavailable.ts)
  const unavailable = serviceUnavailableErrorOf(error);
  if (unavailable) return unavailable.message;

  const raw = nonEmptyString(typeof error === "string" ? error : (error as { message?: unknown } | null | undefined)?.message);
  if (!raw) return fallback;

  const match = HTTP_ERROR_PATTERN.exec(raw);
  if (match) {
    try {
      const fromBody = messageFromBody(JSON.parse(match[1]));
      if (fromBody) return fromBody;
    } catch {
      // 本文が JSON ではない (ゲートウェイの HTML の 502 など): 下で fallback を返す
    }
  }
  return match ? fallback : raw; // HTTP のエラーで本文から文を取れない: 生の `HTTP <status> …` を出さない (#1917 の続き)
}

/** 日本語の文字 (ひらがな・カタカナ・漢字・全角の記号) */
const JAPANESE_TEXT_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/;

/**
 * getApiErrorMessage と同じく本文の文 (または固定の文) を取り出し、それが日本語の文でなければ fallback を返す (#1917)。
 *
 * getApiErrorMessage は、HTTP のエラーでない例外の文 (生の fetch の通信の失敗 'Network request failed'・Supabase Auth (GoTrue) の
 * 英語の文 'Invalid login credentials' など) をそのまま返す。API の失敗の本文の文は日本語の固定の文なので、日本語でない文は利用者に見せる文ではない。
 * API・Supabase Auth の失敗を Alert に出す画面 (健康の記録・ログイン・登録・パスワードの再設定など) はこちらを使う (#1917 の続き)
 */
export function getJapaneseApiErrorMessage(error: unknown, fallback: string): string {
  const message = getApiErrorMessage(error, fallback);
  return JAPANESE_TEXT_PATTERN.test(message) ? message : fallback;
}

/** API のエラー応答 (`HTTP <status> <statusText>: <本文>`。@homegohan/core の createHttpClient) の状態の数字 */
const API_ERROR_STATUS_PATTERN = /^HTTP (\d{3})\b/;

/**
 * API のエラーから HTTP の状態の数字を取り出す (取り出せなければ undefined)。
 * 通信の失敗 (HttpNetworkError) と、getApi() が固定の文の例外に置き換えた 503 (ServiceUnavailableError) と 429
 * (AiDailyLimitError) は、message が `HTTP ...` で始まらないので undefined になる
 */
export function httpStatusOfApiError(error: unknown): number | undefined {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== "string") return undefined;
  const match = API_ERROR_STATUS_PATTERN.exec(message);
  return match ? Number(match[1]) : undefined;
}
