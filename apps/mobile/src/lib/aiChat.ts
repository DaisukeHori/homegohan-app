/**
 * AI 相談チャット (AIAdvisorSheet / app/ai/[sessionId].tsx) の送信まわりの共通部品 (#1049 F7-18)。
 *
 * 以前の送信は `POST .../messages?stream=true` を RN 標準の fetch で呼び、26 秒で AbortController を
 * 発火していた。RN 標準の fetch はレスポンスを最後まで溜めてから返す (ReadableStream の body も無い) ので、
 *   - 26 秒は「応答の先頭が来るまで」ではなく「応答が完全に終わるまで」の制限になっていた。
 *     サーバー側の AI 呼び出しだけで最大 25 秒、そのあと重要度判定 (最大 5 秒) と保存があるので、
 *     サーバーが成功していても 26 秒を超えるとタイムアウト表示になっていた。
 *   - 中断したあとは履歴を取り直さなかった。ユーザーのメッセージも AI の返信もサーバーには保存済みでも、
 *     画面では送信が失敗した扱いになり、入力が消えたように見えた。
 * 今は、ストリーミングではない通常の POST (Web 版が使っているのと同じ) を共通 API クライアントで呼び、
 * 応答が来るまで十分に待つ。待ち切れなかったときや通信が切れたときは、サーバーの履歴を取り直して
 * 返信が届いていたかを確かめる。
 */

import { isHttpNetworkError } from '@homegohan/core';

/**
 * AI 相談 1 通の送信を待つ上限 (ミリ秒)。
 * サーバーは AI 呼び出し最大 25 秒 (失敗時は直接 OpenAI へ再度 25 秒) + 重要度判定最大 5 秒 + 保存で、
 * 通常は 30 秒前後、最悪でも 60 秒弱で終わる。それより十分長くしておく。
 */
export const AI_CHAT_TIMEOUT_MS = 75_000;

/** タイムアウトのときに画面へ出す文言 (2 つの画面で同じにする) */
export const AI_CHAT_TIMEOUT_MESSAGE = '応答がタイムアウトしました。しばらく待ってから再度お試しください。';

/** POST /api/ai/consultation/sessions/:id/messages の応答 (ストリーミングでない場合) */
export type AiChatPostResponse = {
  success?: boolean;
  userMessage?: {
    id?: string;
    content?: string;
    isImportant?: boolean;
    importanceReason?: string | null;
    createdAt?: string;
  } | null;
  aiMessage?: {
    id?: string;
    content?: string;
    proposedActions?: unknown;
    createdAt?: string;
  } | null;
  /** サーバーがアクションを自動実行して成功した */
  actionExecuted?: boolean;
};

/** fetch が中断されたときの例外 (DOMException / Error の name が AbortError) */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * 送信がサーバーに届いたかどうか分からない失敗か。
 * 応答を受け取れなかったとき (共通 API クライアントの HttpNetworkError。待ち時間切れ 'timeout' も、通信の切断 'offline' も)
 * と、呼び出し側の中断 (AbortError)。このときは履歴を取り直して確かめる。
 * HTTP のエラー応答 (4xx / 5xx) は、サーバーが処理しなかったと分かるので含めない。
 * 成功 (2xx) なのに本文が JSON でなかった (HttpParseError) ときも、サーバーが処理を終えたかどうかは分からないが、
 * 送信そのものは届いている (応答を受け取れている) ので、ここでは対象外にする。
 */
export function isUncertainSendFailure(error: unknown): boolean {
  return isHttpNetworkError(error) || isAbortError(error);
}

/** isUncertainSendFailure のうち、時間切れ (タイムアウト) のもの。文言をタイムアウト用にする */
export function isTimeoutFailure(error: unknown): boolean {
  if (isHttpNetworkError(error)) return error.kind === 'timeout';
  return isAbortError(error);
}

/**
 * 画面だけにあって、サーバーの履歴には無いメッセージか。
 *   - `welcome`   : 履歴が空のときに出す挨拶 (AIAdvisorSheet)
 *   - `local-…`   : 送信中の仮メッセージ (楽観的 UI)
 *   - `summary-…` : セッションを閉じたときに画面へ出す要約 (AIAdvisorSheet)
 * 返信の id がサーバーの応答に無いときに画面で付ける `ai-…` は含めない。
 * 返信はサーバーが保存してから返すので、`ai-…` のメッセージもサーバーの履歴に入っている (数えるのが正しい)。
 */
export function isLocalOnlyMessage(message: { id: string }): boolean {
  return message.id === 'welcome' || message.id.startsWith('local-') || message.id.startsWith('summary-');
}

/**
 * 送信前に確定していた (= サーバーの履歴に入っている) メッセージの数。hasReplyAfterSend の persistedBefore に渡す。
 * 画面だけのメッセージ (isLocalOnlyMessage) を数えると、取り直した履歴の件数と比べたときに実際より多くなり、
 * 返信が届いているのに「届いていない」と判定して、タイムアウトのアラートを出してしまう。
 */
export function countPersistedMessages(messages: ReadonlyArray<{ id: string }>): number {
  return messages.filter((message) => !isLocalOnlyMessage(message)).length;
}

/**
 * 取り直した履歴に、今回の送信に対する返信が入っているか。
 *
 * サーバーは送信を受けるとまずユーザーのメッセージを保存し、AI の返信ができたらそれを保存する。
 * 送信前の確定済みメッセージ数を `persistedBefore` とすると、両方保存されていれば
 * 履歴は `persistedBefore + 2` 件以上になり、最後は AI の返信になる。
 * (同じ文面を以前にも送っていても取り違えないよう、文面ではなく件数で見る)
 */
export function hasReplyAfterSend(
  messages: ReadonlyArray<{ role: string }>,
  persistedBefore: number,
): boolean {
  if (messages.length < persistedBefore + 2) return false;
  return messages[messages.length - 1]?.role === 'assistant';
}
