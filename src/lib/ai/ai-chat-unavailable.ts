/**
 * AI 相談が緊急停止中 (feature_flags の ai_chat_enabled が OFF) のときの、サーバーの応答の取り決め (#1148)
 *
 * サーバー (src/lib/ai/ai-chat-gate.ts) は 503 と { error: <やさしい文面>, code: 'AI_CHAT_DISABLED', retryAfter } を返す。
 * クライアント (Web の AI チャット) は、この文面をそのまま画面に出す。
 * サーバーとクライアントの両方から import できるよう、このファイルは Next.js のサーバー専用の部品に依存しない。
 */

// 文と code の置き場は packages/shared/src/service-unavailable.ts の 1 つ (モバイルも同じ値を使う。#1457)
import { AI_CHAT_DISABLED_CODE, AI_CHAT_DISABLED_MESSAGE, SERVICE_UNAVAILABLE_STATUS } from '@homegohan/shared';

export { AI_CHAT_DISABLED_CODE, AI_CHAT_DISABLED_MESSAGE };

/**
 * AI 相談の API が返した 503 の本文から、画面に出す文面を取り出す。
 * AI 相談の緊急停止の応答 (code が AI_CHAT_DISABLED) でなければ null (メンテナンス中などは、呼び出し側の既定の表示にする)。
 * 本文が JSON でない・読めないときも null。例外は投げない。
 */
export async function readAiChatUnavailableMessage(res: Pick<Response, 'status' | 'json'>): Promise<string | null> {
  if (res.status !== SERVICE_UNAVAILABLE_STATUS) return null;
  try {
    const body = (await res.json()) as { code?: unknown; error?: unknown } | null;
    if (body && body.code === AI_CHAT_DISABLED_CODE) {
      return typeof body.error === 'string' && body.error.length > 0 ? body.error : AI_CHAT_DISABLED_MESSAGE;
    }
  } catch {
    // 本文が読めなくても、呼び出し側の既定の表示に任せる
  }
  return null;
}
