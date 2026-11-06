/**
 * モバイルの AI 相談 (src/components/ai/AIAdvisorSheet.tsx) で、終了した (閉じた) 相談への入力と送信を止めるための文と見分け方
 * (#2283)。
 *
 * アーカイブを受け付けたあとに新しい相談の作成が失敗すると、閉じた相談が今の相談のまま画面に残る。以前は入力欄も会話の続きの POST
 * も相談の status を見ず、閉じた相談に会話が足されていった。いまはサーバーが 409 と
 * `{ error: <この文>, code: CONSULTATION_SESSION_CLOSED_CODE }` で拒み、画面は出している相談が終了なら入力欄・送信・1日献立の作成を
 * 止めて、この文と『新しい相談を始める』を出す (Web の AI 相談 (src/components/AIChatBubble.tsx) と同じ)。
 *
 * モバイルはルートの src/ を import できない (リポジトリ直下の .easignore が /src/ を除外し、EAS のビルドのアーカイブに入らない)
 * ので、Web とサーバーの文・code・状態コード (src/lib/ai/ai-api-messages.ts・src/lib/ai/consultation-session-closed.ts) をここに
 * 写して持つ。一致は tests/ai-consultation-session-closed-2283.test.ts が突き合わせて確かめる。
 * 古い版のモバイル (配布済み) は 409 を汎用の送信の失敗として出す。
 */

/** 終了した相談への送信を止めたときに出す一文 (Web とサーバーの AI_CONSULTATION_SESSION_CLOSED_MESSAGE と同じ文) */
export const CONSULTATION_SESSION_CLOSED_MESSAGE = "この相談は終了しています。新しい相談を始めてください";

/** 終了した相談への送信を拒んだ応答の code (サーバーの AI_CONSULTATION_SESSION_CLOSED_CODE と同じ) */
export const CONSULTATION_SESSION_CLOSED_CODE = "AI_CONSULTATION_SESSION_CLOSED";

/** 終了した相談への送信を拒む状態コード (サーバーの CONSULTATION_SESSION_CLOSED_STATUS と同じ。409 Conflict) */
export const CONSULTATION_SESSION_CLOSED_STATUS = 409;

/** 相談の一覧の status の、終了した相談の値 (サーバーの CONSULTATION_SESSION_STATUS_CLOSED と同じ) */
export const CONSULTATION_SESSION_STATUS_CLOSED = "closed";

/** 相談の一覧の status が終了か */
export function isConsultationSessionStatusClosed(status: unknown): boolean {
  return status === CONSULTATION_SESSION_STATUS_CLOSED;
}

/**
 * 送信の失敗の応答の状態コード (status) と本文の文字列 (bodyText) が、終了した相談への送信を拒んだものか。状態コードと code の
 * 両方を見る (409 でもほかの理由の応答は、ふだんの失敗として扱う)。本文が JSON でなければ偽。例外は投げない
 */
export function isConsultationSessionClosedFailure(status: number, bodyText: string): boolean {
  if (status !== CONSULTATION_SESSION_CLOSED_STATUS) return false;
  try {
    const body: unknown = JSON.parse(bodyText);
    if (!body || typeof body !== "object") return false;
    return (body as { code?: unknown }).code === CONSULTATION_SESSION_CLOSED_CODE;
  } catch {
    return false;
  }
}

/** 送信が終了した相談として拒まれた (409 と code) ことを、送信の流れの catch に渡す例外 */
export class ConsultationSessionClosedError extends Error {
  constructor() {
    super(CONSULTATION_SESSION_CLOSED_MESSAGE);
    this.name = "ConsultationSessionClosedError";
  }
}

export function isConsultationSessionClosedError(error: unknown): error is ConsultationSessionClosedError {
  return error instanceof ConsultationSessionClosedError;
}
