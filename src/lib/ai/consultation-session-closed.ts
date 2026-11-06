/**
 * 終了した (閉じた) AI 相談への送信の取り決め (#2283)。
 *
 * 問題:
 *   アーカイブ (相談を終了) を受け付けたあとに新しい相談の作成が失敗すると、閉じた相談が今の相談のまま画面に残る。以前は入力欄も
 *   会話の続きの POST (src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts) も相談の status を見ず、閉じた相談に
 *   会話が足されていった。
 *
 * 決まり:
 *   - サーバー: 会話の続きの POST は、所有者の確認のあと、本文を読む前に status が closed なら 409 と
 *     `{ error: AI_CONSULTATION_SESSION_CLOSED_MESSAGE, code: AI_CONSULTATION_SESSION_CLOSED_CODE }` を返す。メッセージの行・
 *     AI の呼び出し・提案の記録 (ai_action_logs) を作らず、AI の利用回数も数えない
 *   - 画面 (Web の src/components/AIChatBubble.tsx): 出している相談が閉じていれば (一覧の status か、閉じたことを応答で知った)、
 *     入力欄・送信・提案の実行・1日献立の作成を止め、同じ文と『新しい相談を始める』を出す。送信が 409 のこの code で返ったときも同じ。
 *     開いたときに出す相談は、終了していない相談を先に選ぶ (終了した相談しか無いときだけ終了した相談を出す。モバイルと同じ)
 *   - モバイルは写しを持つ (apps/mobile/src/lib/ai-consultation-session-closed.ts)
 * サーバーとクライアントの両方から import できるよう、このファイルは Next.js のサーバー専用の部品に依存しない。
 */
import { AI_CONSULTATION_SESSION_CLOSED_CODE, AI_CONSULTATION_SESSION_CLOSED_MESSAGE } from '@/lib/ai/ai-api-messages';

/** ai_consultation_sessions.status の、終了した相談の値 (閉じる route が書く) */
export const CONSULTATION_SESSION_STATUS_CLOSED = 'closed';

/** 終了した相談への送信を拒む状態コード (409 Conflict: 相談の今の状態と合わない) */
export const CONSULTATION_SESSION_CLOSED_STATUS = 409;

/** 相談の行の status が終了か */
export function isConsultationSessionStatusClosed(status: unknown): boolean {
  return status === CONSULTATION_SESSION_STATUS_CLOSED;
}

/** 終了した相談への送信を拒む応答の本文 */
export function consultationSessionClosedBody(): { error: string; code: string } {
  return { error: AI_CONSULTATION_SESSION_CLOSED_MESSAGE, code: AI_CONSULTATION_SESSION_CLOSED_CODE };
}

/**
 * 失敗の応答の状態コード (status) と本文 (body。JSON を読んだもの。読めなければ null) が、終了した相談への送信を拒んだものか。
 * 状態コードと code の両方を見る (409 でもほかの理由の応答は、ふだんの失敗として扱う)。例外は投げない
 */
export function isConsultationSessionClosedFailure(status: number, body: unknown): boolean {
  if (status !== CONSULTATION_SESSION_CLOSED_STATUS) return false;
  if (!body || typeof body !== 'object') return false;
  return (body as { code?: unknown }).code === AI_CONSULTATION_SESSION_CLOSED_CODE;
}

/**
 * 失敗の応答 (res) が、終了した相談への送信を拒んだものか。409 のときだけ本文を読む (ほかの状態コードでは本文に触れない。
 * 呼び出し側があとで本文を読めるように)。本文が読めなければ偽。例外は投げない
 */
export async function isConsultationSessionClosedResponse(res: Pick<Response, 'status' | 'json'>): Promise<boolean> {
  if (res.status !== CONSULTATION_SESSION_CLOSED_STATUS) return false;
  try {
    return isConsultationSessionClosedFailure(res.status, (await res.json()) as unknown);
  } catch {
    return false;
  }
}
