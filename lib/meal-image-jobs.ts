import type { SupabaseClient } from '@supabase/supabase-js';
import { getEdgeFunctionServiceRoleKey, getSupabaseUrl, isMissingEnvError } from '@/lib/env-required';
import { refundAiUsage, type AiUsageResult } from '@/lib/plan/entitlements';
import { createLogger } from '@/lib/db-logger';
import {
  DEFAULT_MEAL_IMAGE_MODEL,
  buildDishImagePrompt,
  buildDishImageSubjectHash,
  buildMealImageIdempotencyKey,
  deriveMealCoverImage,
  reconcileDishImages,
  type MealImageDish,
  type MealImageJobSeed,
  type ReconcileDishImagesResult,
} from './meal-image';

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

/** enqueueMealImageJobs の結果 (#1487)。行ごとに数える */
export interface EnqueueMealImageJobsResult {
  /** 新しく積めた行 */
  inserted: number;
  /** 同じ料理の待ち・処理中のジョブがすでにあって積まなかった行 (冪等キーの重複) */
  duplicates: number;
  /** 書き込みに失敗した行 (権限・接続など) */
  failed: number;
}

/**
 * 一意制約の違反 (PostgreSQL の SQLSTATE)。meal_image_jobs の冪等キーの一意な索引
 * (meal_image_jobs_idempotency_pending_idx) は、待ち・処理中 (status が pending / processing) の行だけが対象の部分索引
 */
const UNIQUE_VIOLATION_CODE = '23505';

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
 *
 * 1 行も積めなかったときは、params.usage (この操作で数えた料理画像の 1 回) を数え戻す
 * (AI へは何も送らないので。上限の数え戻しの決まりは src/lib/plan/entitlements.ts の【数え戻し】)。
 */
export async function enqueueMealImageJobs(params: EnqueueJobsParams): Promise<EnqueueMealImageJobsResult> {
  const result: EnqueueMealImageJobsResult = { inserted: 0, duplicates: 0, failed: 0 };
  if (!params.jobSeeds.length) {
    await refundUnusedMealImageUsage(params);
    return result;
  }

  const records = await Promise.all(
    params.jobSeeds.map(async (seed): Promise<Record<string, unknown>> => ({
      planned_meal_id: params.plannedMealId,
      user_id: params.userId,
      dish_index: seed.dishIndex,
      job_kind: 'dish',
      subject_hash: seed.subjectHash,
      idempotency_key: await buildMealImageIdempotencyKey({
        plannedMealId: params.plannedMealId,
        dishIndex: seed.dishIndex,
        subjectHash: seed.subjectHash,
      }),
      prompt: seed.prompt,
      model: seed.model,
      reference_image_urls: seed.referenceImageUrls,
      trigger_source: params.triggerSource,
      request_id: params.requestId ?? null,
      status: 'pending',
    })),
  );

  const logger = createLogger(ENQUEUE_LOG_NAME);
  const outcomes = await Promise.all(
    records.map(async (record) => {
      try {
        const { error } = await params.supabase.from('meal_image_jobs').insert(record);
        if (!error) return 'inserted' as const;
        if (error.code === UNIQUE_VIOLATION_CODE) return 'duplicate' as const;
        logger.warn('Failed to enqueue meal image job', {
          userId: params.userId,
          plannedMealId: params.plannedMealId,
          dishIndex: record.dish_index,
          code: error.code,
          error: error.message,
        });
        return 'failed' as const;
      } catch (error) {
        logger.warn('Failed to enqueue meal image job', {
          userId: params.userId,
          plannedMealId: params.plannedMealId,
          dishIndex: record.dish_index,
          error: error instanceof Error ? error.message : String(error),
        });
        return 'failed' as const;
      }
    }),
  );
  for (const outcome of outcomes) {
    if (outcome === 'inserted') result.inserted += 1;
    else if (outcome === 'duplicate') result.duplicates += 1;
    else result.failed += 1;
  }

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
