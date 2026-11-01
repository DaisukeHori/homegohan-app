/**
 * AI 相談の提案の実行の結果を、チャットに出す一文にする (#2183 Z1。#2189 W2 で Web とモバイルの共有にした)。
 *
 * 問題:
 *   実行の API (POST /api/ai/consultation/actions/[actionId]/execute) は、アクションが失敗したときも 200 で
 *   `{ success: false, result }` を返す。画面 (Web の src/components/AIChatBubble.tsx) は `res.ok` だけを見て、
 *   失敗しても『✅ …を実行しました！』と出していた。会話の続きの POST の自動実行 (SSE の finalData の actionResult) は、
 *   失敗したときに何も出さず、無言で失敗していた。モバイルの AI 相談のシート (apps/mobile/src/components/ai/AIAdvisorSheet.tsx) は
 *   actionResult を読まず、成功しても失敗しても無言だった (#2189 W2)。
 *
 * 決まり:
 *   - 実行できたと出すのは `success === true` のときだけ。それ以外 (false・欠けている) は失敗の文を出す
 *   - 失敗の文は、result.error が空でない文字列ならその文 (実行の側は result.error に固定の日本語の文だけを入れる。
 *     src/lib/ai/consultation-action-executor.ts の logActionDbFailure の説明)。result.error が無い失敗の分岐
 *     (例: `{ itemId, updated: false }`・自動実行の例外で result が null) は、固定の文 AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE
 *   - このファイルは Web のブラウザとモバイルで読み込む (サーバー・DOM・React Native の依存を import しない)
 *
 * Web の既存の import (@/lib/ai/consultation-action-outcome) は、src/lib/ai/consultation-action-outcome.ts がここを読み直すだけ。
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

/**
 * 提案の種類ごとの名前 (成功の一文『✅ {名前}を実行しました！』に使う)。
 * 鍵は実行の側 (src/lib/ai/consultation-action-executor.ts の runConsultationAction の case) の種類と一致させる
 * (一致は tests/consultation-action-labels-shared-2189.test.ts が確かめる)。モバイルの AI 相談のシートが使う。
 * Web の AIChatBubble.tsx は自分の表 (アイコンと色つき) を持つ
 */
export const CONSULTATION_ACTION_LABELS: Readonly<Record<string, string>> = {
  // 献立
  generate_day_menu: '1日の献立を作成',
  generate_week_menu: '1週間の献立を作成',
  generate_single_meal: '1食を作成',
  update_meal: '献立を変更',
  delete_meal: '献立を削除',
  complete_meal: '食事を完了',
  // 買い物リスト
  add_to_shopping_list: '買い物リストに追加',
  update_shopping_item: '買い物リストを更新',
  delete_shopping_item: '買い物リストから削除',
  check_shopping_item: '買い物をチェック',
  // 冷蔵庫 / パントリー
  add_pantry_item: '冷蔵庫に追加',
  update_pantry_item: '冷蔵庫を更新',
  delete_pantry_item: '冷蔵庫から削除',
  // レシピ
  suggest_recipe: 'レシピを提案',
  like_recipe: 'レシピにいいね',
  add_recipe_to_collection: 'コレクションに追加',
  // 栄養目標
  update_nutrition_target: '栄養目標を更新',
  // 健康目標
  set_health_goal: '健康目標を設定',
  update_health_goal: '健康目標を更新',
  delete_health_goal: '健康目標を削除',
  // 健康記録
  add_health_record: '健康記録を追加',
  update_health_record: '健康記録を更新',
  // プロフィール
  update_profile_preferences: '好み・習慣を更新',
};

/** CONSULTATION_ACTION_LABELS に無い種類 (または種類が分からない) ときの名前 */
export const CONSULTATION_ACTION_LABEL_FALLBACK = 'アクション';

/** 提案の種類の名前。表に無い種類・文字列でない値は CONSULTATION_ACTION_LABEL_FALLBACK */
export function consultationActionLabelOf(type: unknown): string {
  if (typeof type !== 'string') return CONSULTATION_ACTION_LABEL_FALLBACK;
  return Object.prototype.hasOwnProperty.call(CONSULTATION_ACTION_LABELS, type)
    ? CONSULTATION_ACTION_LABELS[type]
    : CONSULTATION_ACTION_LABEL_FALLBACK;
}

/** 自動実行の結果 (成功・失敗) と、結果のメッセージに使う種類 */
export interface ConsultationAutoActionOutcome {
  outcome: ConsultationActionOutcome;
  /** 実行した提案の種類 (分からなければ null) */
  actionType: string | null;
}

/**
 * 会話の続きの POST (SSE) の最後の finalData から、自動実行の結果の一文を作る。
 * finalData.actionResult は messages route の executeAndFinalizeAction の戻り値 (`{ success, result }`。種類は入っていない) なので、
 * 種類は提案 (finalData.aiMessage.proposedActions.type) から引く。actionResult が無い (提案が無く実行していない) ときは null
 * (Web の AIChatBubble.tsx の showAutoActionOutcome と同じ扱い)
 */
export function consultationAutoActionOutcomeOf(finalData: unknown): ConsultationAutoActionOutcome | null {
  if (typeof finalData !== 'object' || finalData === null || !('actionResult' in finalData)) return null;
  const actionResult: unknown = finalData.actionResult;
  if (typeof actionResult !== 'object' || actionResult === null) return null;
  const actionType = autoActionTypeOf(actionResult, 'aiMessage' in finalData ? finalData.aiMessage : null);
  return {
    outcome: consultationActionOutcomeOf({
      success: 'success' in actionResult ? actionResult.success : undefined,
      result: 'result' in actionResult ? actionResult.result : undefined,
      label: consultationActionLabelOf(actionType),
    }),
    actionType,
  };
}

/** 自動実行した提案の種類。actionResult.actionType が文字列ならそれ、無ければ aiMessage.proposedActions.type */
function autoActionTypeOf(actionResult: object, aiMessage: unknown): string | null {
  if ('actionType' in actionResult && typeof actionResult.actionType === 'string') return actionResult.actionType;
  if (typeof aiMessage !== 'object' || aiMessage === null || !('proposedActions' in aiMessage)) return null;
  const proposed: unknown = aiMessage.proposedActions;
  if (typeof proposed !== 'object' || proposed === null || !('type' in proposed)) return null;
  return typeof proposed.type === 'string' ? proposed.type : null;
}
