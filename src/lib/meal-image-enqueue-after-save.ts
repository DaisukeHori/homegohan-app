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
 *   - 積み込みの例外のときは、印を書いた後の献立の料理 (dishes) と updated_at を読み直して結果 (mealAfterMark) に入れる。
 *     呼び出し側は応答の行にそれを重ねる (withMealAfterEnqueueThrew)。重ねないと、DB では料理が見送りの状態なのに、応答は
 *     書き直す前の行 ('pending') のままで、画面は次の読み込みまで「生成中」を出していた (#2206 G4)
 *   - 印の書き込みが失敗した (error) ときは、読み直した行の料理に見送りの印を重ねて返す (#2227 H4)。ジョブが無いので、
 *     DB の 'pending' のまま返すと画面は「生成中」に残る (画像はできない)
 *   - 読み直しに失敗したときは、印を書けた・印の書き込みが失敗したなら、応答の行の料理に見送りの印を重ねる
 *     (failuresToOverlay。#2227 H4)。updated_at は分からないので重ねない
 *   - 積み込みの例外を受けるのは、行を 1 つも積む前に失敗したときだけ (enqueueMealImageJobs は積み始めたあとは投げない。
 *     runMealImageEnqueueAftercare。#2227 H4)。なので、ここでは全部のジョブの料理を印の対象にし、1 回を戻してよい。
 *     enqueueMealImageJobs は自分の数え戻し (積む種が無い・1 行も積めなかった) が投げても外へ出さないので、ここで受ける
 *     例外のときは、まだ戻していない (#2235 I5)
 *   - ここでの数え戻しが投げても、印付けと読み直しは続ける。数え戻しはやり直さず、app_logs に残す (#2235 I5。
 *     数え戻しは一部だけ戻して投げることがあり、やり直すと二重に戻しうる)
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { toLoggableError } from '@/lib/api/errors';
import { createLogger } from '@/lib/db-logger';
import {
  ENQUEUE_FAILED_MEAL_COLUMNS,
  countMealImageJobsToProcess,
  isCatalogProductMeal,
  markDishImagesEnqueueFailed,
  markEnqueueFailedDishesInMeal,
  type EnqueueMealImageJobsResult,
  type MealImageDish,
  type MealImageJobSeed,
} from '@/lib/meal-image';
import { enqueueMealImageJobs, triggerMealImageJobProcessing } from '@/lib/meal-image-jobs';
import { refundAiUsage, type AiUsageResult } from '@/lib/plan/entitlements';

/** ログの名前 (ロガーは使うときに作る。import のときに作ると、ロガーを差し替えるテストの初期化の順に依存する) */
const ENQUEUE_AFTER_SAVE_LOG_NAME = 'lib/meal-image-enqueue-after-save';

/** 積み込みの例外のログの文 */
export const MEAL_IMAGE_ENQUEUE_THREW_LOG_MESSAGE = '献立の保存のあと、料理画像のジョブを積めませんでした (献立の保存は済んでいます)';
/** 積み込みの例外のあとの数え戻しが投げたときのログの文 (#2235 I5) */
export const MEAL_IMAGE_REFUND_AFTER_ENQUEUE_THREW_LOG_MESSAGE =
  '料理画像のジョブを積めなかったあと、数えた料理画像の 1 回を戻せませんでした (やり直していません)';
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

/**
 * 積み込みの例外のあと、印を書いた後の献立から読み直す列 (応答の行に重ねる。#2206 G4)。
 * 印の書き込みが失敗したときに読み直した料理へ印を重ねるので、商品の献立か (isCatalogProductMeal) を見る列も読む (#2227 H4)
 */
export const MEAL_AFTER_ENQUEUE_THREW_COLUMNS = ENQUEUE_FAILED_MEAL_COLUMNS;

/** 積み込みの例外のあと、印を書いた後の献立の料理と updated_at (読み直せなかったときは null) */
export interface MealAfterEnqueueThrew {
  dishes: unknown;
  updated_at: unknown;
}

/** ジョブを積めなかった料理 (見送りの印の対象) */
export interface EnqueueFailedDish {
  dishIndex: number;
  subjectHash: string;
}

export type EnqueueMealImageJobsAfterSaveOutcome =
  | { status: 'enqueued'; enqueued: EnqueueMealImageJobsResult; triggered: boolean }
  | {
      status: 'enqueue_threw';
      mealAfterMark: MealAfterEnqueueThrew | null;
      /**
       * 読み直せなかった (mealAfterMark が null) ときに、応答の行の料理へ見送りの印を重ねる料理 (#2227 H4)。
       * 印を書けた・印の書き込みが失敗したときはジョブの料理全部。献立が無い・変える料理が無かったときは空
       */
      failuresToOverlay: ReadonlyArray<EnqueueFailedDish>;
    };

/** 料理の配列 (どれもオブジェクト) なら MealImageDish の配列として返す。違えば null (印を重ねない) */
function asMealImageDishes(value: unknown): MealImageDish[] | null {
  if (!Array.isArray(value)) return null;
  const dishes: MealImageDish[] = [];
  for (const dish of value) {
    if (dish === null || typeof dish !== 'object' || Array.isArray(dish)) return null;
    dishes.push({ ...dish });
  }
  return dishes;
}

/** 料理に見送りの印を重ねる (markDishImagesEnqueueFailed と同じ決まり)。重ねる料理が無ければ渡した値のまま */
function overlayEnqueueFailedMarks(
  dishes: unknown,
  failures: ReadonlyArray<EnqueueFailedDish>,
  meal: { catalog_product_id?: unknown; source_type?: unknown },
): unknown {
  if (failures.length === 0) return dishes;
  const parsed = asMealImageDishes(dishes);
  if (!parsed) return dishes;
  const marked = markDishImagesEnqueueFailed(parsed, failures, { mealIsCatalog: isCatalogProductMeal(meal) });
  return marked.changed ? marked.dishes : dishes;
}

/**
 * 応答に返す献立の行に、積み込みの例外のあとの料理 (見送りの状態の印を書いた後の dishes) を重ねる (#2206 G4)。
 * updated_at は、行がその列を持つとき (select() の全列や updated_at を選んだ行) だけ重ねる。
 * 読み直せなかったときは、応答の行の料理に見送りの印を重ねる (failuresToOverlay。updated_at は変えない。#2227 H4)。
 * 積めたとき (outcome が null を含む) は行のまま返す
 */
export function withMealAfterEnqueueThrew<Meal extends Record<string, unknown>>(
  meal: Meal,
  outcome: EnqueueMealImageJobsAfterSaveOutcome | null,
): Meal {
  if (outcome?.status !== 'enqueue_threw') return meal;
  if (!outcome.mealAfterMark) {
    const overlaid = overlayEnqueueFailedMarks(meal.dishes, outcome.failuresToOverlay, meal);
    return overlaid === meal.dishes ? meal : { ...meal, dishes: overlaid };
  }
  const { dishes, updated_at: updatedAt } = outcome.mealAfterMark;
  return 'updated_at' in meal ? { ...meal, dishes, updated_at: updatedAt } : { ...meal, dishes };
}

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
    // ジョブを積めていないので、AI へは何も送っていない。数えた 1 回を戻す。
    // 投げても印付けは続ける (やり直さない。二重に戻さないため。#2235 I5)
    try {
      if (params.usage?.allowed) await refundAiUsage(params.userId, 'meal_image_auto', params.usage);
    } catch (refundError) {
      createLogger(ENQUEUE_AFTER_SAVE_LOG_NAME)
        .withUser(params.userId)
        .error(MEAL_IMAGE_REFUND_AFTER_ENQUEUE_THREW_LOG_MESSAGE, toLoggableError(refundError), context);
    }
    // 'pending' のまま残すと、処理するジョブが無いので「料理画像を生成中です」のまま残る。見送りの状態にする
    const failures: EnqueueFailedDish[] = params.jobSeeds.map((seed) => ({ dishIndex: seed.dishIndex, subjectHash: seed.subjectHash }));
    const marked = await markEnqueueFailedDishesInMeal({
      failures,
      mealId: params.plannedMealId,
      db: params.userDb,
      loadMeal: () => params.userDb.from('planned_meals').select(ENQUEUE_FAILED_MEAL_COLUMNS).eq('id', params.plannedMealId).maybeSingle(),
    });
    if (marked.status === 'error') {
      createLogger(ENQUEUE_AFTER_SAVE_LOG_NAME)
        .withUser(params.userId)
        .warn('Failed to mark dishes whose meal image jobs were not enqueued', { ...context, error: marked.message });
    }
    // 印を書けなかった (error) ときは、DB の料理は 'pending' のまま。応答には印を重ねる (ジョブが無く画像はできない。#2227 H4)
    const markFailed = marked.status === 'error';
    const failuresToOverlay = marked.status === 'updated' || markFailed ? failures : [];
    return {
      status: 'enqueue_threw',
      mealAfterMark: await readMealAfterMark(params, context, markFailed ? failures : []),
      failuresToOverlay,
    };
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

/**
 * 積み込みの例外のあと、印を書いた後の献立の料理と updated_at を読み直す (応答の行に重ねるため。#2206 G4)。
 * 献立が消えたときも、読めた今の行を返す (応答は DB の今の値に合わせる)。
 * 印の書き込みが失敗したときは、読めた行の料理に見送りの印を重ねる (overlayFailures。updated_at は DB の値のまま。#2227 H4)。
 * 読めなかったときは null (呼び出し側が応答の行に印を重ねる。ログに残す)
 */
async function readMealAfterMark(
  params: EnqueueMealImageJobsAfterSaveParams,
  context: Readonly<Record<string, unknown>>,
  overlayFailures: ReadonlyArray<EnqueueFailedDish>,
): Promise<MealAfterEnqueueThrew | null> {
  try {
    const { data, error } = await params.userDb
      .from('planned_meals')
      .select(MEAL_AFTER_ENQUEUE_THREW_COLUMNS)
      .eq('id', params.plannedMealId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row: Record<string, unknown> = data;
    return { dishes: overlayEnqueueFailedMarks(row.dishes, overlayFailures, row), updated_at: row.updated_at };
  } catch (readError) {
    createLogger(ENQUEUE_AFTER_SAVE_LOG_NAME)
      .withUser(params.userId)
      .warn('Failed to reload the meal after marking dishes whose meal image jobs were not enqueued', {
        ...context,
        error: toLoggableError(readError).message,
      });
    return null;
  }
}
