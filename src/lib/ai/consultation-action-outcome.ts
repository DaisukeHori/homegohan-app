/**
 * AI 相談の提案の実行の結果を、チャットに出す一文にする (#2183 Z1)。
 *
 * 問題:
 *   実行の API (POST /api/ai/consultation/actions/[actionId]/execute) は、アクションが失敗したときも 200 で
 *   `{ success: false, result }` を返す。画面 (src/components/AIChatBubble.tsx) は `res.ok` だけを見て、
 *   失敗しても『✅ …を実行しました！』と出していた。会話の続きの POST の自動実行 (SSE の finalData の actionResult) は、
 *   失敗したときに何も出さず、無言で失敗していた。
 *
 * 決まり:
 *   - 実行できたと出すのは `success === true` のときだけ。それ以外 (false・欠けている) は失敗の文を出す
 *   - 失敗の文は、result.error が空でない文字列ならその文 (実行の側は result.error に固定の日本語の文だけを入れる。
 *     src/lib/ai/consultation-action-executor.ts の logActionDbFailure の説明)。result.error が無い失敗の分岐
 *     (例: `{ itemId, updated: false }`・自動実行の例外で result が null) は、固定の文 AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE
 *   - このファイルはブラウザで読み込む (サーバーの依存を import しない)
 */

/** 提案の実行が失敗し、結果に失敗の文 (result.error) が無いときにチャットに出す固定の文 */
export const AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE = 'アクションを実行できませんでした';

/** 提案の実行の結果をチャットに出すときの形 */
export type ConsultationActionOutcome =
  | { kind: 'executed'; content: string }
  | { kind: 'failed'; content: string };

/** 実行の結果 (result) から、利用者に見せる失敗の文を取り出す。文が無ければ固定の文 */
export function consultationActionFailureMessageOf(result: unknown): string {
  if (typeof result === 'object' && result !== null && 'error' in result) {
    const error: unknown = result.error;
    if (typeof error === 'string' && error.trim() !== '') return error;
  }
  return AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE;
}

/** 実行できたときにチャットに出す一文 (label はアクションの名前。例『買い物リストに追加』) */
export function consultationActionExecutedMessageOf(label: string): string {
  return `✅ ${label}を実行しました！`;
}

/**
 * 提案の実行の応答 (`{ success, result }`) を、チャットに出す一文にする。
 * success が true でなければ失敗の文 (実行できたとは出さない)
 */
export function consultationActionOutcomeOf(input: {
  success: unknown;
  result: unknown;
  label: string;
}): ConsultationActionOutcome {
  if (input.success === true) {
    return { kind: 'executed', content: consultationActionExecutedMessageOf(input.label) };
  }
  return { kind: 'failed', content: consultationActionFailureMessageOf(input.result) };
}
