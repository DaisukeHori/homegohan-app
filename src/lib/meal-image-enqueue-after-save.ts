/**
 * 献立 (planned_meals) を保存したあとに、料理画像のジョブを積んで処理を起こす (#2201 U4)。
 * AI 相談の update_meal (src/lib/ai/consultation-action-executor.ts) と、料理を保存する 4 つの route
 * (POST /api/meals・PATCH /api/meals/[id]・POST /api/meal-plans/meals・PATCH /api/meal-plans/meals/[id]) が使う。
 *
 * 問題 (直す前):
 *   - 積み込み (getAiQueueWriter・enqueueMealImageJobs) で例外が出ると、料理は 'pending' (料理画像を生成中) で保存済みなのに
 *     ジョブが無く、生成中のまま残った (route は例外が外へ出て 500。保存は済んでいるのに、数えた料理画像の 1 回も戻さなかった)
 *   - AI 相談の update_meal は積み込みと処理の起動 (triggerMealImageJobProcessing) を 1 つの try に入れていたので、積み込みが
 *     成功したあとに処理の起動が投げても 1 回を数え戻していた (ジョブは cron が後で処理するので、安全弁を 1 回ぶん少なく数える)
 *
 * 決まり:
 *   - 積み込みの例外: 数えた 1 回を戻し (AI へは何も送っていない)、ジョブの無い料理を保存済みの献立の上で見送りの状態
 *     ('failed' + 'enqueue_failed'。行ごとの書き込みに失敗した料理と同じ印。markEnqueueFailedDishesInMeal) に書き直す。
 *     献立の保存は成功のまま (例外を外へ出さない)
 *   - 処理の起動の例外: ログに残すだけ。数え戻さない (積んだジョブは pg_cron の process-pending-meal-image-jobs が拾う)
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { toLoggableError } from '@/lib/api/errors';
import { createLogger } from '@/lib/db-logger';
import {
  ENQUEUE_FAILED_MEAL_COLUMNS,
  countMealImageJobsToProcess,
  markEnqueueFailedDishesInMeal,
  type EnqueueMealImageJobsResult,
  type MealImageJobSeed,
} from '@/lib/meal-image';
import { enqueueMealImageJobs, triggerMealImageJobProcessing } from '@/lib/meal-image-jobs';
import { refundAiUsage, type AiUsageResult } from '@/lib/plan/entitlements';

/** ログの名前 (ロガーは使うときに作る。import のときに作ると、ロガーを差し替えるテストの初期化の順に依存する) */
const ENQUEUE_AFTER_SAVE_LOG_NAME = 'lib/meal-image-enqueue-after-save';

/** 積み込みの例外のログの文 */
export const MEAL_IMAGE_ENQUEUE_THREW_LOG_MESSAGE = '献立の保存のあと、料理画像のジョブを積めませんでした (献立の保存は済んでいます)';
/** 処理の起動の例外のログの文 */
export const MEAL_IMAGE_TRIGGER_THREW_LOG_MESSAGE =
  '料理画像のジョブの処理を起こせませんでした (ジョブは積めています。定期の処理が拾います)';

export interface EnqueueMealImageJobsAfterSaveParams {
  /**
   * 利用者のセッションのクライアント。積み込みの例外のとき、ジョブの無い料理の印を保存済みの献立に書く
   * (献立を保存したのと同じクライアント。本人の行だけの RLS)
   */
  userDb: Pick<SupabaseClient, 'from'>;
  plannedMealId: string;
  userId: string;
  triggerSource: string;
  jobSeeds: MealImageJobSeed[];
  requestId?: string | null;
  /** この操作で数えた料理画像の 1 回 (consumeAiUsage(userId, 'meal_image_auto') の結果。数えていなければ null) */
  usage: AiUsageResult | null;
  /** ログに足す文脈 (action_id など) */
  logContext?: Readonly<Record<string, unknown>>;
}

export type EnqueueMealImageJobsAfterSaveOutcome =
  | { status: 'enqueued'; enqueued: EnqueueMealImageJobsResult; triggered: boolean }
  | { status: 'enqueue_threw' };

export async function enqueueMealImageJobsAfterSave(
  params: EnqueueMealImageJobsAfterSaveParams,
): Promise<EnqueueMealImageJobsAfterSaveOutcome> {
  const context = { planned_meal_id: params.plannedMealId, ...params.logContext };
  let enqueued: EnqueueMealImageJobsResult;
  try {
    // meal_image_jobs は利用者 (authenticated) から書けない (#1465)。service role で積む。
    // 1 行も積めなかったとき (重複・書き込みの失敗) は、enqueueMealImageJobs が数えた 1 回を戻す (#1487)
    const queueDb = getAiQueueWriter();
    enqueued = await enqueueMealImageJobs({
      supabase: queueDb,
      plannedMealId: params.plannedMealId,
      userId: params.userId,
      triggerSource: params.triggerSource,
      jobSeeds: params.jobSeeds,
      requestId: params.requestId ?? null,
      usage: params.usage,
    });
  } catch (enqueueError) {
    createLogger(ENQUEUE_AFTER_SAVE_LOG_NAME)
      .withUser(params.userId)
      .error(MEAL_IMAGE_ENQUEUE_THREW_LOG_MESSAGE, toLoggableError(enqueueError), context);
    // ジョブを積めていないので、AI へは何も送っていない。数えた 1 回を戻す
    if (params.usage?.allowed) await refundAiUsage(params.userId, 'meal_image_auto', params.usage);
    // 'pending' のまま残すと、処理するジョブが無いので「料理画像を生成中です」のまま残る。見送りの状態にする
    const marked = await markEnqueueFailedDishesInMeal({
      failures: params.jobSeeds.map((seed) => ({ dishIndex: seed.dishIndex, subjectHash: seed.subjectHash })),
      mealId: params.plannedMealId,
      db: params.userDb,
      loadMeal: () => params.userDb.from('planned_meals').select(ENQUEUE_FAILED_MEAL_COLUMNS).eq('id', params.plannedMealId).maybeSingle(),
    });
    if (marked.status === 'error') {
      createLogger(ENQUEUE_AFTER_SAVE_LOG_NAME)
        .withUser(params.userId)
        .warn('Failed to mark dishes whose meal image jobs were not enqueued', { ...context, error: marked.message });
    }
    return { status: 'enqueue_threw' };
  }

  // 積めた行と、同じ料理の待ちのジョブがあるときだけ処理を起こす (書き込みの失敗だけなら空振りの呼び出しを出さない。#1532)
  const jobsToProcess = countMealImageJobsToProcess(enqueued);
  if (jobsToProcess === 0) return { status: 'enqueued', enqueued, triggered: false };
  try {
    await triggerMealImageJobProcessing({ plannedMealId: params.plannedMealId, limit: jobsToProcess });
  } catch (triggerError) {
    // ジョブは積めているので数え戻さない (定期の処理 process-pending-meal-image-jobs が拾う)
    createLogger(ENQUEUE_AFTER_SAVE_LOG_NAME)
      .withUser(params.userId)
      .warn(MEAL_IMAGE_TRIGGER_THREW_LOG_MESSAGE, { ...context, error: toLoggableError(triggerError).message });
    return { status: 'enqueued', enqueued, triggered: false };
  }
  return { status: 'enqueued', enqueued, triggered: true };
}
