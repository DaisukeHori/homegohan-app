/**
 * サービスを一時的に止めているときの 503 を、画面に出せる固定の文にする (モバイル。#1457)
 *
 * サーバーは、AI 相談の緊急停止 (503 + code AI_CHAT_DISABLED) とメンテナンス中 (503 + code MAINTENANCE_MODE) に
 * 503 を返す。AI の機能の手前で同意の状況を読めなかったとき (503 + code AI_CONSENT_CHECK_FAILED。#1154) も、
 * 時間をおけば通る見込みの「いまは使えない」なので、同じ扱いにする (#1486)。@homegohan/core の createHttpClient はこれを `HTTP 503 Service Unavailable: {...}` の Error にして投げ、
 * 生の fetch の画面は `HTTP 503: {...}` の Error を自分で作る。画面が e.message をそのまま出すと、
 * 「HTTP 503 …: {"error":…}」のような生の文字列 (JSON) が出てしまう。
 *
 * - getApi() (src/lib/api.ts) は、この Error を ServiceUnavailableError (message が固定の文) に置き換えて投げ直す。
 *   そのため、各画面の `setError(e.message)` や `Alert.alert("エラー", e.message)` は、そのまま固定の文を出す。
 * - getApi() を通らない生の fetch (ストリーミングで受ける AI 相談の送信) は、失敗の応答から errorOfFailedResponse
 *   (src/lib/failed-response.ts。429 AI_DAILY_LIMIT の判定と共用) で Error を作って投げる
 *   (503 の止めている理由が分かれば ServiceUnavailableError)。
 *   生の fetch で AI 相談の送信をする場所がこの関数を通っているかは、tests/mobile-service-unavailable-raw-fetch.test.ts が見張る。
 *
 * 文はサーバーの本文の文字列を使わず、code から決めた固定の文にする。緊急停止・メンテナンス中は
 * packages/shared/src/service-unavailable.ts (Web と共用)、同意の状況を読めなかったときは
 * supabase/functions/_shared/ai-consent.ts の AI_CONSENT_CHECK_FAILED_MESSAGE (サーバーが本文に入れる文と同じ値)。
 */
import { SERVICE_UNAVAILABLE_STATUS, serviceUnavailableMessageOfBody } from "@homegohan/shared";

import {
  AI_CONSENT_CHECK_FAILED_CODE,
  AI_CONSENT_CHECK_FAILED_MESSAGE,
} from "../../../../supabase/functions/_shared/ai-consent";

// "HTTP 503 Service Unavailable: {...}" / HTTP/2 で statusText が空の "HTTP 503 : {...}" / 生の fetch の "HTTP 503: {...}"
// (api-error.ts と同じ形)
const HTTP_ERROR_PATTERN = /^HTTP (\d{3})[^:]*:\s*([\s\S]+)$/;

/**
 * 503 の本文 (JSON を読んだもの) から、画面に出す固定の文を返す。どれでもなければ null。
 *   - AI 相談の緊急停止・メンテナンス中: packages/shared の serviceUnavailableMessageOfBody
 *   - 同意の状況を読めなかった (AI_CONSENT_CHECK_FAILED。#1486): AI_CONSENT_CHECK_FAILED_MESSAGE
 */
function unavailableMessageOfBody(body: unknown): string | null {
  const shared = serviceUnavailableMessageOfBody(body);
  if (shared) return shared;
  if (body && typeof body === "object" && (body as { code?: unknown }).code === AI_CONSENT_CHECK_FAILED_CODE) {
    return AI_CONSENT_CHECK_FAILED_MESSAGE;
  }
  return null;
}

/** 緊急停止・メンテナンス中・同意の状況を読めなかったことで止められたことを Alert で出すときの見出し */
export const SERVICE_UNAVAILABLE_ALERT_TITLE = "ご利用いただけません";

/** AI 相談の緊急停止・メンテナンス中・同意の状況を読めなかった 503 で止められたことを表す例外。message は画面にそのまま出せる固定の文 */
export class ServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

export function isServiceUnavailableError(error: unknown): error is ServiceUnavailableError {
  return error instanceof ServiceUnavailableError;
}

/**
 * API クライアントが投げた Error が、AI 相談の緊急停止・メンテナンス中・同意の状況を読めなかった 503 なら、
 * 固定の文の ServiceUnavailableError を返す。
 * それ以外 (ほかの状態・ほかの 503・JSON でない本文) は null。例外は投げない。
 */
export function serviceUnavailableErrorOf(error: unknown): ServiceUnavailableError | null {
  if (isServiceUnavailableError(error)) return error;
  const raw = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof raw !== "string") return null;
  const match = HTTP_ERROR_PATTERN.exec(raw);
  if (!match || Number(match[1]) !== SERVICE_UNAVAILABLE_STATUS) return null;
  try {
    const message = unavailableMessageOfBody(JSON.parse(match[2]));
    return message ? new ServiceUnavailableError(message) : null;
  } catch {
    return null;
  }
}

/**
 * 生の fetch で、応答の本文をすでに JSON として読んだ場所が使う。
 * 状態が 503 で、AI 相談の緊急停止・メンテナンス中・同意の状況を読めなかったなら固定の文、それ以外は null。
 */
export function serviceUnavailableMessageOf(status: number, body: unknown): string | null {
  return status === SERVICE_UNAVAILABLE_STATUS ? unavailableMessageOfBody(body) : null;
}
