/**
 * AI 相談の提案 (ai_action_logs の行) の状態の決まり (#2189 W1-a)。
 *
 * 問題:
 *   - 会話の続きの POST の自動実行と、提案のカードの「実行する」(POST /api/ai/consultation/actions/[actionId]/execute) は、
 *     失敗したときに行を failed にしていた。#2183 Z1 で画面は失敗のあとも提案のカードを残すが、実行の API は pending の行しか
 *     探さないので、残したボタンを押しても 404 で、やり直せなかった
 *   - 自動実行で今日の AI の利用回数の上限 (#1149) に当たったときも failed にしていた (手の実行は pending のまま残す)
 *   - 相談を開き直すと、GET が保存した提案 (proposed_actions) をそのまま返し、実行済みの提案のカードがまた出ていた
 *
 * 決まり:
 *   - 成功したら executed。今日の上限で止めたら pending のまま (明日もう一度実行できる。同意が無くて止めたときと同じ)
 *   - 失敗したら pending のまま残し、残したボタンで本当にやり直せるようにする。ただし、途中まで書いてから失敗しうる種類
 *     (AI_ACTION_TYPES_NOT_RETRYABLE_AFTER_FAILURE) と、対応していない種類は failed にし、画面は「実行する」を出さずに
 *     「もう一度頼んでください」の案内を出す (AI_PROPOSED_ACTION_NOT_EXECUTABLE_GUIDE)
 *   - 実行している間は approved (実行中の印)。pending から approved への書き換えを条件つきの 1 文で行い、書けた 1 本だけが
 *     実行する (2 つの画面から同時に押しても二重に実行しない)。実行が終わったら上の決まりの状態に書き換える
 *   - GET は、行の状態から提案のカードを出すかと「実行する」を出すかを決める (proposedActionViewOf)
 *
 * このファイルはブラウザでも読み込む (サーバーの依存を import しない。型だけ)。
 */
import type { ConsultationActionExecutionResult } from '@/lib/ai/consultation-action-executor';

/** ai_action_logs.status の値 (DB の ai_action_logs_status_check と同じ 5 つ) */
export const AI_ACTION_LOG_STATUS = {
  /** 実行を待っている (自動実行が失敗した・上限や同意で止めた)。「実行する」で実行できる */
  pending: 'pending',
  /** 実行中 (pending から条件つきで書き換えた 1 本だけが実行する) */
  running: 'approved',
  /** 実行できた */
  executed: 'executed',
  /** 失敗し、やり直せない (途中まで書いた可能性がある種類・対応していない種類) */
  failed: 'failed',
  /** 利用者が提案を断った */
  rejected: 'rejected',
} as const;

export type AiActionLogStatus = (typeof AI_ACTION_LOG_STATUS)[keyof typeof AI_ACTION_LOG_STATUS];

/**
 * 失敗したあとにやり直させない種類 (failed にし、画面は「実行する」を出さずに案内を出す)。種類 → 理由。
 *
 * 献立の生成の 3 種類は、生成の依頼 (weekly_menu_requests) を作ってから Edge Function を呼ぶ。呼び出しが時間切れ・5xx で
 * 失敗しても、Edge Function の側は動き続けて献立 (planned_meals) を書いていることがある (invokeGenerateMenuV4WithRetry は
 * 時間切れのあとも呼び出しを止めず、同じ依頼で最大 3 回呼ぶ)。planned_meals には「1 日の 1 区分に 1 行」の一意の制約が無いので、
 * やり直すと同じ食事の枠に献立が 2 つできうる。数えた 1 回 (#1149) も戻していないので、やり直すと 2 回数える。
 * 二重に書かないことを確かめられないので、やり直させない (利用者には AI にもう一度頼んでもらう)。
 *
 * ほかの種類は、途中で失敗しても二重に書かない (src/lib/ai/consultation-action-executor.ts の各 case):
 *   - 書き込みが最後の 1 文で、失敗したら何も書いていない: add_to_shopping_list (行の一括 insert)・add_pantry_item・set_health_goal
 *     (insert 1 文)・like_recipe (確かめてから insert 1 文)
 *   - 同じ値で書き直すだけ (何度実行しても結果が同じ): update_meal・complete_meal・update_shopping_item・check_shopping_item・
 *     update_pantry_item・update_nutrition_target (user_id の upsert)・update_health_goal・add_health_record
 *     (user_id, record_date の upsert)・update_health_record・update_profile_preferences
 *   - 消すだけ (消えていれば「見つからない」の失敗で何も書かない): delete_meal・delete_shopping_item・delete_pantry_item・delete_health_goal
 *   - 読むだけ: suggest_recipe
 *   - コレクションは名前の upsert、レシピの追加は「まだ入っていないときだけ足す」1 文の関数: add_recipe_to_collection
 */
export const AI_ACTION_TYPES_NOT_RETRYABLE_AFTER_FAILURE: ReadonlyMap<string, string> = new Map([
  ['generate_day_menu', '献立の生成は、呼び出しが失敗しても Edge Function が献立を書いていることがあり、やり直すと同じ枠に二重に書きうる'],
  ['generate_week_menu', '献立の生成は、呼び出しが失敗しても Edge Function が献立を書いていることがあり、やり直すと同じ枠に二重に書きうる'],
  ['generate_single_meal', '献立の生成は、呼び出しが失敗しても Edge Function が献立を書いていることがあり、やり直すと同じ枠に二重に書きうる'],
]);

/** 実行の結果のうち、行の状態を決めるのに使う部分 */
export type ConsultationActionRunForStatus = Pick<ConsultationActionExecutionResult, 'success' | 'unknownActionType' | 'aiDailyLimit'>;

/** 実行が終わったあとの行の状態 (実行中の印 approved から書き換える先) */
export type AiActionLogStatusAfterRun =
  | typeof AI_ACTION_LOG_STATUS.executed
  | typeof AI_ACTION_LOG_STATUS.failed
  | typeof AI_ACTION_LOG_STATUS.pending;

/** 失敗したあと (結果が失敗・実行の中で例外) の状態: やり直せる種類は pending、やり直させない種類は failed */
export function aiActionLogStatusAfterFailure(actionType: string): AiActionLogStatusAfterRun {
  return AI_ACTION_TYPES_NOT_RETRYABLE_AFTER_FAILURE.has(actionType) ? AI_ACTION_LOG_STATUS.failed : AI_ACTION_LOG_STATUS.pending;
}

/** 実行の結果から、行の状態を決める */
export function aiActionLogStatusAfterRun(actionType: string, run: ConsultationActionRunForStatus): AiActionLogStatusAfterRun {
  // 対応していない種類は、何度実行しても実行できない
  if (run.unknownActionType) return AI_ACTION_LOG_STATUS.failed;
  if (run.success === true) return AI_ACTION_LOG_STATUS.executed;
  // 今日の上限で止めた (実行していない): 明日もう一度実行できる
  if (run.aiDailyLimit) return AI_ACTION_LOG_STATUS.pending;
  return aiActionLogStatusAfterFailure(actionType);
}

/** 提案のカードの出し方 */
export type ProposedActionView =
  /** カードを出さない (実行できた・断った) */
  | 'hidden'
  /** カードと「実行する」を出す (行が pending) */
  | 'executable'
  /** カードは出すが「実行する」は出さず、案内を出す (やり直せない失敗・実行中・行が無い) */
  | 'notExecutable';

/**
 * メッセージの提案に付いた行の状態 (ふつうは 1 行) から、提案のカードの出し方を決める。
 * 行が無い (記録に失敗した) ときは、実行の API が見つけられないので「実行する」を出さない
 */
export function proposedActionViewOf(statuses: readonly string[]): ProposedActionView {
  if (statuses.some((s) => s === AI_ACTION_LOG_STATUS.executed || s === AI_ACTION_LOG_STATUS.rejected)) return 'hidden';
  if (statuses.includes(AI_ACTION_LOG_STATUS.pending)) return 'executable';
  return 'notExecutable';
}

/** 提案のカードで「実行する」の代わりに出す案内 (やり直せない失敗・実行中・記録が無い) */
export const AI_PROPOSED_ACTION_NOT_EXECUTABLE_GUIDE = 'この提案はここからは実行できません。もう一度 AI に頼んでください。';

/**
 * 自動実行の提案を ai_action_logs に記録できなかったときの結果の文 (実行していない)。
 * 行が無いので、カードの「実行する」からも実行できない
 */
export const AI_CONSULTATION_ACTION_LOG_INSERT_FAILED_MESSAGE = '提案を記録できなかったため、実行しませんでした。もう一度 AI に頼んでください。';
