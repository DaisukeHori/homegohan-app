import type { SupabaseClient } from '@supabase/supabase-js';
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
  supabase: SupabaseClient;
  plannedMealId: string;
  userId: string;
  triggerSource: string;
  jobSeeds: MealImageJobSeed[];
  requestId?: string | null;
}

export async function enqueueMealImageJobs(params: EnqueueJobsParams) {
  if (!params.jobSeeds.length) return;

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

  await params.supabase
    .from('meal_image_jobs')
    .upsert(records, {
      onConflict: 'idempotency_key',
      ignoreDuplicates: true,
    });
}

export async function cancelPendingMealImageJobs(params: {
  supabase: SupabaseClient;
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
    .in('status', ['pending', 'processing']);
}

export async function triggerMealImageJobProcessing(params: {
  plannedMealId?: string;
  limit?: number;
}) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SERVICE_ROLE_JWT || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
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
