import type { SupabaseClient } from '@supabase/supabase-js';
import { getEdgeFunctionServiceRoleKey, getSupabaseUrl, isMissingEnvError } from '@/lib/env-required';
import { refundAiUsage, type AiUsageResult } from '@/lib/plan/entitlements';
import { createLogger } from '@/lib/db-logger';
import {
  DEFAULT_MEAL_IMAGE_MODEL,
  buildMealImageJobRecords,
  insertMealImageJobRecords,
  markEnqueueFailedDishesInMeal,
  reconcileDishImages,
  summarizeMealImageJobOutcomes,
  type EnqueueMealImageJobsResult,
  type MealImageDish,
  type MealImageJobSeed,
} from './meal-image';

export type { EnqueueMealImageJobsResult } from './meal-image';

interface BuildDishImagePayloadParams {
  previousDishes?: MealImageDish[] | null;
  nextDishes?: MealImageDish[] | null;
  dishName?: string | null;
  triggerSource: string;
  imageUrlOverride?: string | null;
  imageModel?: string | null;
  existingCover?: string | null;
  fallbackMealImageUrl?: string | null;
}

interface DishImagePayload {
  dishes: MealImageDish[];
  jobs: MealImageJobSeed[];
  mealCoverImageUrl: string | null;
}

function cloneDishes(dishes: MealImageDish[] | null | undefined): MealImageDish[] {
  if (!Array.isArray(dishes)) return [];
  return dishes.map((dish) => ({ ...dish }));
}

function ensureNextDishes(params: BuildDishImagePayloadParams): MealImageDish[] {
  const available = params.nextDishes ? cloneDishes(params.nextDishes) : [];
  if (available.length > 0) {
    if (params.dishName && typeof available[0] === 'object') {
      available[0] = { ...available[0], name: params.dishName };
    }
    return available;
  }

  const fromPrevious = cloneDishes(params.previousDishes);
  if (fromPrevious.length > 0) {
    if (params.dishName && typeof fromPrevious[0] === 'object') {
      fromPrevious[0] = { ...fromPrevious[0], name: params.dishName };
    }
    return fromPrevious;
  }

  const placeholder: MealImageDish = {
    name: params.dishName ?? '料理',
    role: 'main',
  };
  return [placeholder];
}

export async function buildDishImagePayload(
  params: BuildDishImagePayloadParams,
): Promise<DishImagePayload> {
  const nextDishes = ensureNextDishes(params);
  const { dishes, jobs, mealCoverImageUrl } = await reconcileDishImages({
    previousDishes: params.previousDishes,
    nextDishes,
    triggerSource: params.triggerSource,
    model: params.imageModel ?? DEFAULT_MEAL_IMAGE_MODEL,
    fallbackMealImageUrl: params.existingCover ?? params.fallbackMealImageUrl,
  });

  if (params.imageUrlOverride) {
    if (dishes.length === 1) {
      dishes[0] = {
        ...dishes[0],
        image_url: params.imageUrlOverride,
        image_source: 'manual_override',
        image_status: 'ready',
        image_generated_at: new Date().toISOString(),
        image_error: null,
      };
      return {
        dishes,
        jobs: [],
        mealCoverImageUrl: params.imageUrlOverride,
      };
    }

    return {
      dishes,
      jobs,
      mealCoverImageUrl: params.imageUrlOverride,
    };
  }

  return {
    dishes,
    jobs,
    mealCoverImageUrl: mealCoverImageUrl ?? params.existingCover ?? null,
  };
}

interface EnqueueJobsParams {
  /**
   * service role のクライアント (getAiQueueWriter())。meal_image_jobs は利用者 (authenticated) から書けない (#1465)。
   * 利用者のセッションのクライアントを渡すと、書き込みが権限で拒まれる
   */
  supabase: SupabaseClient;
  plannedMealId: string;
  userId: string;
  triggerSource: string;
  jobSeeds: MealImageJobSeed[];
  requestId?: string | null;
  /**
   * この操作で数えた料理画像の回数 (consumeAiUsage(userId, 'meal_image_auto') の結果。#1149)。
   * 1 行も積めなかったとき (積む行がすべて重複・書き込みの失敗) は、これを数え戻す (#1487)。
   * 数えていない (同意が無く処理する側が止める・判定に失敗した) ときは null / 省略 (戻すものが無い)
   */
  usage?: AiUsageResult | null;
}

/** ログの名前 (ロガーは使うときに作る。import のときに作ると、ロガーを差し替えるテストの初期化の順に依存する) */
const ENQUEUE_LOG_NAME = 'lib/meal-image-jobs';

/**
 * 料理画像のジョブを積む (service role)。行ごとに insert し、積めた・重複・失敗を数えて返す。例外は投げない。
 *
 * 1 回の upsert (onConflict: 'idempotency_key', ignoreDuplicates) にしない理由 (#1487):
 * 冪等キーの一意な索引は部分索引 (WHERE status IN ('pending','processing')) なので、PostgREST の on_conflict が作る
 * ON CONFLICT (idempotency_key) は索引を推論できず、42P10 で必ず失敗する (行が 1 つも積まれない)。
 * 部分索引のままにするのは、失敗・取り消し・完了したジョブと同じ料理を、あとで積み直せるようにするため。
 * そのため行ごとに insert し、一意制約の違反 (23505) は「同じ料理のジョブが待ち・処理中」として重複に数える。
 * 積み方は Edge Function の supabase/functions/_shared/meal-image-jobs.ts と共通 (supabase/functions/_shared/meal-image.ts。#1505)。
 *
 * 書き込みに失敗した料理は、保存済みの献立の上で 'failed' + 'enqueue_failed' にする (#1505。'pending' のまま「生成中」に残さない)。
 * 重複 (同じ料理のジョブが待ち・処理中) の料理は 'pending' のまま (そのジョブが画像を作る)。
 *
 * 1 行も積めなかったときは、params.usage (この操作で数えた料理画像の 1 回) を数え戻す
 * (AI へは何も送らないので。上限の数え戻しの決まりは src/lib/plan/entitlements.ts の【数え戻し】)。
 */
export async function enqueueMealImageJobs(params: EnqueueJobsParams): Promise<EnqueueMealImageJobsResult> {
  if (!params.jobSeeds.length) {
    await refundUnusedMealImageUsage(params);
    return { inserted: 0, duplicates: 0, failed: 0 };
  }

  const records = await buildMealImageJobRecords({
    plannedMealId: params.plannedMealId,
    userId: params.userId,
    seeds: params.jobSeeds,
    triggerSource: params.triggerSource,
    requestId: params.requestId ?? null,
  });
  const outcomes = await insertMealImageJobRecords(records, (record) =>
    params.supabase.from('meal_image_jobs').insert(record),
  );

  const logger = createLogger(ENQUEUE_LOG_NAME);
  const failures: Array<{ dishIndex: number; subjectHash: string }> = [];
  for (const outcome of outcomes) {
    if (outcome.kind !== 'failed') continue;
    failures.push({ dishIndex: outcome.dishIndex, subjectHash: outcome.subjectHash });
    logger.warn('Failed to enqueue meal image job', {
      userId: params.userId,
      plannedMealId: params.plannedMealId,
      dishIndex: outcome.dishIndex,
      ...(outcome.code ? { code: outcome.code } : {}),
      error: outcome.message,
    });
  }

  if (failures.length > 0) {
    const marked = await markEnqueueFailedDishesInMeal({
      failures,
      loadMeal: () => params.supabase.from('planned_meals').select('dishes').eq('id', params.plannedMealId).maybeSingle(),
      saveDishes: (dishes) =>
        params.supabase
          .from('planned_meals')
          .update({ dishes, updated_at: new Date().toISOString() })
          .eq('id', params.plannedMealId),
    });
    if (marked.status === 'error') {
      logger.warn('Failed to mark dishes whose meal image jobs were not enqueued', {
        userId: params.userId,
        plannedMealId: params.plannedMealId,
        error: marked.message,
      });
    }
  }

  const result = summarizeMealImageJobOutcomes(outcomes);
  if (result.inserted === 0) await refundUnusedMealImageUsage(params);
  return result;
}

/** 1 行も積まなかったとき、この操作で数えた料理画像の 1 回を戻す (数えていなければ何もしない。#1487) */
async function refundUnusedMealImageUsage(params: EnqueueJobsParams): Promise<void> {
  if (params.usage?.allowed) await refundAiUsage(params.userId, 'meal_image_auto', params.usage);
}

/**
 * 献立の待ち・処理中の画像のジョブを取り消す。
 * supabase は service role のクライアント (getAiQueueWriter())。meal_image_jobs は利用者 (authenticated) から書けない (#1465)。
 * RLS が効かないので、userId (認証済みの本人) の行に絞る
 */
export async function cancelPendingMealImageJobs(params: {
  supabase: SupabaseClient;
  userId: string;
  plannedMealId: string;
  reason?: string;
}) {
  await params.supabase
    .from('meal_image_jobs')
    .update({
      status: 'cancelled',
      last_error: params.reason ?? 'Cancelled for photo overwrite',
      lease_token: null,
      leased_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq('planned_meal_id', params.plannedMealId)
    .eq('user_id', params.userId)
    .in('status', ['pending', 'processing']);
}

export async function triggerMealImageJobProcessing(params: {
  plannedMealId?: string;
  limit?: number;
}) {
  // 接続情報は env-required の getter で取り出す (#1434。空白だけの値も欠けているとみなす)。
  // 鍵は SERVICE_ROLE_JWT (古い別名) を先に読む。欠けている変数名は getter がサーバーのログに残す
  let supabaseUrl: string;
  let serviceRoleKey: string;
  try {
    supabaseUrl = getSupabaseUrl();
    serviceRoleKey = getEdgeFunctionServiceRoleKey();
  } catch (error) {
    if (!isMissingEnvError(error)) throw error;
    console.warn('Skipping meal image worker trigger: missing Supabase env');
    return;
  }

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/process-meal-image-jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
      body: JSON.stringify({
        plannedMealId: params.plannedMealId ?? null,
        limit: params.limit ?? null,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.warn('Meal image worker trigger failed:', response.status, errorText);
    }
  } catch (error) {
    console.warn('Meal image worker trigger errored:', error);
  }
}
