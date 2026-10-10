import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import {
  buildCatalogSelectionUpdate,
  clearCatalogSelectionMetadata,
} from '../../../../lib/catalog-products';
import type { MealImageJobSeed } from '../../../../lib/meal-image';
import {
  buildDishImagePayload,
  cancelPendingMealImageJobs,
  enqueueMealImageJobs,
  triggerMealImageJobProcessing,
} from '../../../../lib/meal-image-jobs';
import { checkRateLimit } from '@/lib/rate-limit';
import { createLogger } from '@/lib/db-logger';
import { plannedMealValidationErrorBody, validatePlannedMealInput } from '@/lib/planned-meal-validation';
import { internalError } from '@/lib/api/errors';

/**
 * 特定の食事を取得（planned_mealsベース）
 */
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // planned_mealsとuser_daily_mealsをJOINして取得
    const { data, error } = await supabase
      .from('planned_meals')
      .select(`
        *,
        user_daily_meals!inner(
          day_date,
          user_id
        )
      `)
      .eq('id', params.id)
      .eq('user_daily_meals.user_id', user.id)
      .single();

    if (error) {
      return internalError('GET /api/meals/[id]', error, { userId: user.id });
    }

    if (!data) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json(data);
  } catch (error: any) {
    return internalError('GET /api/meals/[id]', error);
  }
}

/**
 * 食事を更新（planned_mealsベース）
 */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();

    // #1205: 栄養素の型・範囲を、DB に触れる前に確認する（不正なら 400）。
    // 下の allowlist はキー名を絞るだけで値は見ないため、ここで値を確認する。
    const validation = validatePlannedMealInput({
      nutrients: {
        calories_kcal: body.calories_kcal,
        protein_g: body.protein_g,
        fat_g: body.fat_g,
        carbs_g: body.carbs_g,
      },
    });
    if (!validation.ok) {
      return NextResponse.json(plannedMealValidationErrorBody(validation), { status: 400 });
    }
    
    // 許可されたフィールドのみ更新
    const allowedFields = [
      'dish_name', 'mode', 'description', 'image_url', 'ingredients',
      'calories_kcal', 'protein_g', 'fat_g', 'carbs_g',
      'is_completed', 'completed_at', 'dishes', 'is_simple', 'cooking_time_minutes', 'source_type'
    ];
    
    const updateData: Record<string, any> = {};
    for (const key of allowedFields) {
      if (body[key] !== undefined) {
        updateData[key] = body[key];
      }
    }
    // 栄養素は検証済みの値で上書きする（calories_kcal は整数に丸め済み。null は値なし）
    Object.assign(updateData, validation.nutrients);
    updateData.updated_at = new Date().toISOString();
    const manualImageUrl = typeof body.image_url === 'string' ? body.image_url : undefined;

    // まずユーザーの所有確認
    const { data: existing } = await supabase
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

    if (!existing) {
      return NextResponse.json({ error: 'Not found or unauthorized' }, { status: 404 });
    }

    if (body.catalogProductId) {
      const { fields } = await buildCatalogSelectionUpdate({
        supabase,
        catalogProductId: body.catalogProductId,
        existingMetadata: existing.generation_metadata,
        mode: body.mode ?? existing.mode ?? 'buy',
        imageUrl: body.image_url ?? undefined,
        description: body.description ?? undefined,
        selectedFrom: 'manual_search',
      });
      Object.assign(updateData, fields);
    } else {
      const manualContentChanged =
        body.dish_name !== undefined ||
        body.dishes !== undefined ||
        body.calories_kcal !== undefined ||
        body.description !== undefined ||
        body.image_url !== undefined;

      if ((body.catalogProductId === null || manualContentChanged) && existing.catalog_product_id) {
        updateData.catalog_product_id = null;
        updateData.source_type = body.source_type ?? 'manual';
        updateData.generation_metadata = clearCatalogSelectionMetadata(
          existing.generation_metadata,
          body.catalogProductId === null ? 'catalog_selection_removed' : 'manual_override',
        );
      }
    }

    const imageModel = process.env.GEMINI_IMAGE_MODEL ?? undefined;
    const triggerSource = `nextjs:meals/${params.id}:PATCH`;
    const requestId = request.headers.get('x-request-id') ?? null;
    const hasImageManagedDishes =
      (Array.isArray(existing.dishes) && existing.dishes.length > 0) ||
      (Array.isArray(body.dishes) && body.dishes.length > 0);
    let jobs: MealImageJobSeed[] = [];

    if (hasImageManagedDishes) {
      const { dishes: reconciledDishes, jobs: nextJobs, mealCoverImageUrl } = await buildDishImagePayload({
        previousDishes: existing.dishes ?? null,
        nextDishes: body.dishes ?? undefined,
        dishName: updateData.dish_name ?? undefined,
        triggerSource,
        imageUrlOverride: manualImageUrl,
        imageModel,
        existingCover: existing.image_url ?? null,
        fallbackMealImageUrl: existing.image_url ?? null,
      });
      updateData.dishes = reconciledDishes;
      updateData.image_url = mealCoverImageUrl;
      jobs = nextJobs;
    } else if (body.image_url !== undefined) {
      updateData.image_url = body.image_url;
    }

    const { data, error } = await supabase
      .from('planned_meals')
      .update(updateData)
      .eq('id', params.id)
      .select()
      .single();

    if (error) {
      return internalError('PATCH /api/meals/[id]', error, { userId: user.id, requestId: requestId ?? undefined });
    }

    let imageGenerationThrottled = false;
    if (jobs.length > 0) {
      // #1022 画像副作用（enqueue + trigger）は献立更新の成否から独立させる（詳細は meals/route.ts 参照）
      let imageAllowed = false;
      try {
        const rl = await checkRateLimit(user.id, 'image');
        imageAllowed = rl.success;
      } catch (rlError) {
        createLogger('api/meals/[id]').warn('Image rate-limit check failed; skipping image generation', {
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
        console.warn('[meals/[id]] Image generation skipped due to rate limit', {
          userId: user.id,
          plannedMealId: data.id,
        });
      }
    }

    // #1022 (Suggestion): 画像生成がスロットルされた場合のみ additive にフラグを付与する
    return NextResponse.json(
      imageGenerationThrottled ? { ...data, imageGenerationThrottled: true } : data,
    );
  } catch (error: any) {
    return internalError('PATCH /api/meals/[id]', error);
  }
}

/**
 * 食事を削除（planned_mealsベース）
 */
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // まずユーザーの所有確認
    const { data: existing } = await supabase
      .from('planned_meals')
      .select(`
        id,
        user_daily_meals!inner(user_id)
      `)
      .eq('id', params.id)
      .eq('user_daily_meals.user_id', user.id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Not found or unauthorized' }, { status: 404 });
    }

    await cancelPendingMealImageJobs({
      supabase,
      plannedMealId: params.id,
      reason: 'meal deleted',
    });

    const { error } = await supabase
      .from('planned_meals')
      .delete()
      .eq('id', params.id);

    if (error) {
      return internalError('DELETE /api/meals/[id]', error, { userId: user.id });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return internalError('DELETE /api/meals/[id]', error);
  }
}
