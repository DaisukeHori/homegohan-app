/**
 * サービスを一時的に止めているときの 503 の取り決め (#1148 / #1457)
 *
 * サーバーは、次の 2 つの場合に 503 を返す。Web とモバイルの画面は、本文の文字列 (JSON) をそのまま出さず、
 * ここに置いた固定の文を出す。サーバー・Web・モバイルの 3 か所で同じ値を使うため、置き場はこのファイルの 1 つにする。
 *
 *   - AI 相談の緊急停止 (feature_flags の ai_chat_enabled が OFF。src/lib/ai/ai-chat-gate.ts)
 *       503 { error: <文>, code: 'AI_CHAT_DISABLED', retryAfter }
 *   - メンテナンス中 (feature_flags の maintenance_mode が ON。ミドルウェアが src/lib/maintenance-mode.ts で返す)
 *       503 { error: <文>, code: 'MAINTENANCE_MODE', retryAfter }
 * どちらも同じ平らな形で、error は文字列 (Web の画面が本文の data.error をそのまま出しても、落ちずに固定の文になる。#1486)。
 * #1486 より前のメンテナンス中の本文は入れ子 ({ error: { code, message } }) だった。読む側 (codeOfBody) は、その形も受ける。
 */

/** 503 の状態コード (サービスを一時的に止めている) */
export const SERVICE_UNAVAILABLE_STATUS = 503;

export const AI_CHAT_DISABLED_CODE = 'AI_CHAT_DISABLED';
export const AI_CHAT_DISABLED_MESSAGE =
  'AI相談は現在、一時的にご利用いただけません。しばらくしてから、もう一度お試しください。';

export const MAINTENANCE_API_CODE = 'MAINTENANCE_MODE';
export const MAINTENANCE_MESSAGE = 'ただいまメンテナンス中です。しばらくしてから、もう一度お試しください。';

/** 503 の本文の code ごとの、画面に出す固定の文 */
const SERVICE_UNAVAILABLE_MESSAGES: Readonly<Record<string, string>> = {
  [AI_CHAT_DISABLED_CODE]: AI_CHAT_DISABLED_MESSAGE,
  [MAINTENANCE_API_CODE]: MAINTENANCE_MESSAGE,
};

/**
 * 本文の code を読む。いまの平らな形 { code } (AI 相談の緊急停止・メンテナンス中) を先に見る。
 * #1486 より前のメンテナンス中の入れ子の形 { error: { code } } も受ける (配布済みの古いサーバーとの組み合わせで、判定を変えないため)
 */
function codeOfBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { code, error } = body as { code?: unknown; error?: unknown };
  if (typeof code === 'string') return code;
  if (error && typeof error === 'object') {
    const nested = (error as { code?: unknown }).code;
    if (typeof nested === 'string') return nested;
  }
  return null;
}

/**
 * 503 の本文 (JSON を読んだもの) から、画面に出す固定の文を返す。
 * AI 相談の緊急停止・メンテナンス中のどちらでもなければ null。本文の文字列は使わない (固定の文を返す)。
 */
export function serviceUnavailableMessageOfBody(body: unknown): string | null {
  const code = codeOfBody(body);
  if (code === null) return null;
  return Object.prototype.hasOwnProperty.call(SERVICE_UNAVAILABLE_MESSAGES, code)
    ? SERVICE_UNAVAILABLE_MESSAGES[code]
    : null;
}
