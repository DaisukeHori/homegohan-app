/**
 * 退会 (POST /api/account/delete) に失敗したとき、アプリの画面 (app/settings/account.tsx) に出す文を決める (#1447)
 *
 * これまでは例外の message をそのまま出していたので、
 *   - 組織のオーナー・家族の代表者 (409) のとき、`HTTP 409 Conflict: {"error":"ACCOUNT_DELETE_BLOCKED_ORG_OWNER",...}` という
 *     生の文字列 (組織の名前の入った JSON) が出て、譲渡や解散が先だということが読み取れなかった
 *   - ほかの失敗でも、`HTTP 500 ...: {...}` のような生の文字列が出ていた
 *
 * 決め方 (上から順に):
 *   1. 通信できなかった (圏外・待ち時間切れ): 「通信できません」の固定の文 (src/lib/api-error.ts の NETWORK_ERROR_MESSAGES)
 *   2. メンテナンス中などの 503: getApi() が置き換えた ServiceUnavailableError の固定の文 (src/lib/service-unavailable.ts)
 *   3. 409 (組織のオーナー・家族の代表者): サーバーの本文の message (src/lib/account-deletion.ts の findBlocker が書く、
 *      譲渡や解散が先だという利用者向けの固定の文)。本文に無ければ定型の文
 *   4. 401 (ログインが切れている): 「もう一度ログインしてから」の固定の文 (kind: 'unauthorized')。画面はこのあとログアウトして
 *      入口へ戻す (Web の設定画面がログインの画面へ移すのと揃える。#1562)
 *   5. それ以外: 汎用の「削除に失敗しました」
 *
 * 文面は Web の設定画面 (src/lib/account-self-service.ts の ACCOUNT_DELETE_FAILED_MESSAGE /
 * ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE) と同じ。アプリは src/ の Web のコードを読み込まないので、ここに同じ値を持つ
 * (tests/account-deletion-blocked-message.test.ts が両方の値の一致を確かめる)。
 */
import { isHttpNetworkError } from "@homegohan/core";

import { NETWORK_ERROR_MESSAGES } from "./api-error";
import { isServiceUnavailableError } from "./service-unavailable";

/** 退会に失敗したとき (409 以外の失敗) に出す文。アカウントは消えていないので、もう一度試せる */
export const ACCOUNT_DELETE_FAILED_MESSAGE = "アカウントの削除に失敗しました。時間をおいて再度お試しください。";

/** 退会できなかった (409) のに、サーバーの本文に理由の文が無かったときに出す文 */
export const ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE =
  "組織のオーナー、または家族グループの代表者のため、退会できません。先にオーナー・代表者を譲渡するか、組織・家族グループを解散してください。";

/** ログインが切れていて退会の API を呼べなかったときに出す文 (#1562)。アカウントは消えていない */
export const ACCOUNT_DELETE_SESSION_EXPIRED_MESSAGE =
  "ログインの有効期限が切れています。もう一度ログインしてから、退会をやり直してください。";

/** 組織のオーナー・家族の代表者なので退会できない応答の HTTP のステータス */
const HTTP_CONFLICT = 409;
/** ログインが切れている (サーバーがセッションを確かめられない) 応答の HTTP のステータス */
const HTTP_UNAUTHORIZED = 401;

// "HTTP 409 Conflict: {...}" / HTTP/2 で statusText が空の "HTTP 409 : {...}" (src/lib/api-error.ts と同じ形)
const HTTP_ERROR_PATTERN = /^HTTP (\d{3})[^:]*:\s*([\s\S]+)$/;

/** 409 の本文から、利用者向けの理由の文を取り出す。無ければ null */
function blockedMessageOfBody(bodyText: string): string | null {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" && message.trim() !== "" ? message : null;
}

/**
 * 退会の API の失敗 (例外) から、画面に出す文を返す。生の例外の文 (HTTP のステータスや JSON) は出さない。
 * 409 (組織のオーナー・家族の代表者) のときは kind: 'blocked'、401 (ログインが切れている) のときは kind: 'unauthorized'、
 * それ以外は kind: 'failed'。
 */
export function accountDeletionErrorOf(error: unknown): { kind: "blocked" | "unauthorized" | "failed"; message: string } {
  if (isHttpNetworkError(error)) return { kind: "failed", message: NETWORK_ERROR_MESSAGES[error.kind] };
  if (isServiceUnavailableError(error)) return { kind: "failed", message: error.message };

  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const match = HTTP_ERROR_PATTERN.exec(raw);
  if (match && Number(match[1]) === HTTP_CONFLICT) {
    return { kind: "blocked", message: blockedMessageOfBody(match[2]) ?? ACCOUNT_DELETE_BLOCKED_FALLBACK_MESSAGE };
  }
  if (match && Number(match[1]) === HTTP_UNAUTHORIZED) {
    return { kind: "unauthorized", message: ACCOUNT_DELETE_SESSION_EXPIRED_MESSAGE };
  }
  return { kind: "failed", message: ACCOUNT_DELETE_FAILED_MESSAGE };
}
