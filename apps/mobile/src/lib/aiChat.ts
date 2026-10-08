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

/**
 * 送信がサーバーに届いたかどうか分からない失敗か。
 * タイムアウト・通信の切断・呼び出し側の中断。このときは履歴を取り直して確かめる。
 * HTTP のエラー応答 (4xx / 5xx) は、サーバーが処理しなかったと分かるので含めない。
 *
 * 共通 API クライアント (packages/core) のエラーは name で見分ける:
 *   HttpTimeoutError.name = 'TimeoutError' / HttpNetworkError.name = 'HttpNetworkError'
 * (名前が変わったら __tests__/lib/ai-chat.test.ts が落ちる)
 */
export function isUncertainSendFailure(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'HttpNetworkError' || name === 'AbortError';
}

/** isUncertainSendFailure のうち、時間切れ (タイムアウト) のもの。文言をタイムアウト用にする */
export function isTimeoutFailure(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
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
