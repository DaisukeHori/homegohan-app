/**
 * モバイルの AI 相談 (src/components/ai/AIAdvisorSheet.tsx) で、相談の一覧・会話の読み込み (GET) と新しい相談の作成 (POST) が
 * 失敗したときに会話に出す一文 (#2272 S1)。
 *
 * 以前は、開いたときの読み込み (initSession) の失敗はようこその一文だけの画面にし、会話の読み込み (loadMessages) の失敗は履歴の
 * ある相談でもようこその一文だけの画面に置き換え (履歴が消えたように見えた)、一覧の読み込み (fetchSessions) の失敗は黙っていた。
 * Web の AI 相談 (src/components/AIChatBubble.tsx) は #2265 Q2 で、どれも理由と次の手 (開き直す・『新しい相談を始める』を押す) の
 * 一文を出すようにした。モバイルはルートの src/ を import できない (リポジトリ直下の .easignore が /src/ を除外し、EAS のビルドの
 * アーカイブに入らない) ので、同じ文をここに写して持つ。文が Web と一致することは tests/mobile-ai-chat-load-failure-2272.test.ts が
 * Web の部品と突き合わせて確かめる。
 *
 * 時間切れ (…_TIMEOUT_MESSAGE) と、失敗の応答 (非 ok)・通信の失敗 (…_FAILED_MESSAGE) で文を分けるのも Web と同じ。
 * 同じ種類の一文は画面に 1 つだけ出す (CHAT_LOAD_FAILURE_NOTE_IDS の id で前の一文を外してから足す。Web と同じ)。
 */
import { isHttpNetworkError } from "@homegohan/core";

import { isConsultationRequestTimeout } from "./ai-consultation-request-time-limit";

export const SESSIONS_LOAD_TIMEOUT_MESSAGE =
  "相談の一覧の読み込みの応答が返りませんでした。チャットを閉じて開き直してください。";
export const SESSIONS_LOAD_FAILED_MESSAGE = "相談の一覧を読み込めませんでした。チャットを閉じて開き直してください。";
export const MESSAGES_LOAD_TIMEOUT_MESSAGE =
  "会話の読み込みの応答が返りませんでした。チャットを閉じて開き直すか、『新しい相談を始める』を押してください。";
export const MESSAGES_LOAD_FAILED_MESSAGE =
  "会話を読み込めませんでした。チャットを閉じて開き直すか、『新しい相談を始める』を押してください。";
/** 作成の応答が返らなかったとき (作成がサーバーで遅れて済むことがある) */
export const SESSION_CREATE_TIMEOUT_MESSAGE =
  "新しい相談の作成の応答が返りませんでした。チャットを閉じて開き直すか、もう一度『新しい相談を始める』を押してください。";
export const SESSION_CREATE_FAILED_MESSAGE =
  "新しい相談を始められませんでした。少し待ってから、もう一度『新しい相談を始める』を押してください。";

/** 読み込みの失敗の一文の種類ごとの id (同じ種類の一文を二重に出さないため、足す前に同じ id の一文を外す。Web と同じ id) */
export const CHAT_LOAD_FAILURE_NOTE_IDS = {
  sessions: "load-failed-sessions",
  messages: "load-failed-messages",
  create: "load-failed-create",
} as const;
export type ChatLoadFailureKind = keyof typeof CHAT_LOAD_FAILURE_NOTE_IDS;

/** 読み込みの失敗の種類と、時間切れかから、会話に出す一文を選ぶ (Web の chatLoadFailureMessageOf と同じ) */
export function chatLoadFailureMessageOf(kind: ChatLoadFailureKind, timedOut: boolean): string {
  switch (kind) {
    case "sessions":
      return timedOut ? SESSIONS_LOAD_TIMEOUT_MESSAGE : SESSIONS_LOAD_FAILED_MESSAGE;
    case "messages":
      return timedOut ? MESSAGES_LOAD_TIMEOUT_MESSAGE : MESSAGES_LOAD_FAILED_MESSAGE;
    case "create":
      return timedOut ? SESSION_CREATE_TIMEOUT_MESSAGE : SESSION_CREATE_FAILED_MESSAGE;
  }
}

/**
 * 読み込み・作成の例外が時間切れか (#2272 S1)。モバイルの読み込みは getApi() の共通クライアントで待ち、待ちの上限を過ぎると
 * kind が 'timeout' の HttpNetworkError を投げる。上限を自分で付けた待ち (withinConsultationRequestTimeLimit・打ち切りの
 * AbortError) も時間切れとして扱う (Web の isConsultationRequestTimeout と同じ判定)。圏外 (kind が 'offline')・失敗の応答は時間切れではない
 */
export function isChatLoadTimeout(error: unknown): boolean {
  if (isHttpNetworkError(error)) return error.kind === "timeout";
  return isConsultationRequestTimeout(error);
}
