import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import {
  buildCatalogSelectionUpdate,
  clearCatalogSelectionMetadata,
} from '../../../../../lib/catalog-products';
import type { MealImageJobSeed } from '../../../../../lib/meal-image';
import {
  buildDishImagePayload,
  cancelPendingMealImageJobs,
  enqueueMealImageJobs,
  triggerMealImageJobProcessing,
} from '../../../../../lib/meal-image-jobs';
import { checkRateLimit } from '@/lib/rate-limit';
import { createLogger } from '@/lib/db-logger';

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const json = await request.json();
    const {
      isCompleted,
      dishName,
      mode,
      dishes,
      isSimple,
      caloriesKcal,
      description,
      imageUrl,
      catalogProductId,
      sourceType,
    } = json;

    const { data: existingMeal, error: existingMealError } = await supabase
      .from('planned_meals')
      .select(`
        id,
        mode,
        catalog_product_id,
        source_type,
        generation_metadata,
        dishes,
        image_url,
        user_daily_meals!inner(user_id)
      `)
      .eq('id', params.id)
      .eq('user_daily_meals.user_id', user.id)
      .single();

    if (existingMealError || !existingMeal) {
      return NextResponse.json({ error: 'Not found or unauthorized' }, { status: 404 });
    }

    const updateData: Record<string, any> = {};
    
    if (isCompleted !== undefined) {
      updateData.is_completed = isCompleted;
      updateData.completed_at = isCompleted ? new Date().toISOString() : null;
    }
    if (dishName !== undefined) updateData.dish_name = dishName;
    if (mode !== undefined) updateData.mode = mode;
    if (dishes !== undefined) updateData.dishes = dishes;
    if (isSimple !== undefined) updateData.is_simple = isSimple;
    if (caloriesKcal !== undefined) updateData.calories_kcal = caloriesKcal;
    if (description !== undefined) updateData.description = description;
    const manualImageUrl = typeof imageUrl === 'string' ? imageUrl : undefined;

    if (catalogProductId) {
      const { fields } = await buildCatalogSelectionUpdate({
        supabase,
        catalogProductId,
        existingMetadata: existingMeal.generation_metadata,
        mode: mode ?? existingMeal.mode ?? 'buy',
        imageUrl: imageUrl ?? undefined,
        description: description ?? undefined,
        selectedFrom: 'manual_search',
      });
      Object.assign(updateData, fields);
    } else {
      const manualContentChanged =
        dishName !== undefined ||
        dishes !== undefined ||
        isSimple !== undefined ||
        caloriesKcal !== undefined ||
        description !== undefined ||
        imageUrl !== undefined;

      if ((catalogProductId === null || manualContentChanged) && existingMeal.catalog_product_id) {
        updateData.catalog_product_id = null;
        updateData.source_type = sourceType ?? 'manual';
        updateData.generation_metadata = clearCatalogSelectionMetadata(
          existingMeal.generation_metadata,
          catalogProductId === null ? 'catalog_selection_removed' : 'manual_override',
        );
      } else if (sourceType !== undefined) {
        updateData.source_type = sourceType;
      }
    }

    const imageModel = process.env.GEMINI_IMAGE_MODEL ?? undefined;
    const triggerSource = `nextjs:meal-plans/meals/${params.id}:PATCH`;
    const requestId = request.headers.get('x-request-id') ?? null;
    const hasImageManagedDishes =
      (Array.isArray(existingMeal.dishes) && existingMeal.dishes.length > 0) ||
      (Array.isArray(dishes) && dishes.length > 0);
    let jobs: MealImageJobSeed[] = [];

    if (hasImageManagedDishes) {
      const { dishes: reconciledDishes, jobs: nextJobs, mealCoverImageUrl } = await buildDishImagePayload({
        previousDishes: existingMeal.dishes ?? null,
        nextDishes: dishes ?? undefined,
        dishName: updateData.dish_name ?? undefined,
        triggerSource,
        imageUrlOverride: manualImageUrl,
        imageModel,
        existingCover: existingMeal.image_url ?? null,
        fallbackMealImageUrl: existingMeal.image_url ?? null,
      });
      updateData.dishes = reconciledDishes;
      updateData.image_url = mealCoverImageUrl;
      jobs = nextJobs;
    } else if (imageUrl !== undefined) {
      updateData.image_url = imageUrl;
    }

    const { data, error } = await supabase
      .from('planned_meals')
      .update(updateData)
      .eq('id', existingMeal.id)
      .select()
      .single();

    if (error) throw error;

    let imageGenerationThrottled = false;
    if (jobs.length > 0) {
      // #1022 画像副作用（enqueue + trigger）は献立更新の成否から独立させる（詳細は meals/route.ts 参照）
      let imageAllowed = false;
      try {
        const rl = await checkRateLimit(user.id, 'image');
        imageAllowed = rl.success;
      } catch (rlError) {
        createLogger('api/meal-plans/meals/[id]').warn('Image rate-limit check failed; skipping image generation', {
          userId: user.id,
          plannedMealId: data.id,
          error: rlError instanceof Error ? rlError.message : String(rlError),
        });
        imageAllowed = false;
      }

      if (imageAllowed) {
        await enqueueMealImageJobs({
          supabase,
          plannedMealId: data.id,
          userId: user.id,
          triggerSource,
          jobSeeds: jobs,
          requestId,
        });
        await triggerMealImageJobProcessing({ plannedMealId: data.id, limit: jobs.length });
      } else {
        imageGenerationThrottled = true;
        console.warn('[meal-plans/meals/[id]] Image generation skipped due to rate limit', {
          userId: user.id,
          plannedMealId: data.id,
        });
      }
    }

    return NextResponse.json({
      success: true,
      meal: data,
      // #1022 (Suggestion): 画像生成がスロットルされた場合のみ additive にフラグを付与する
      ...(imageGenerationThrottled ? { imageGenerationThrottled: true } : {}),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await cancelPendingMealImageJobs({
      supabase,
      plannedMealId: params.id,
      reason: 'meal deleted',
    });

    const { error } = await supabase
      .from('planned_meals')
      .delete()
      .eq('id', params.id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
