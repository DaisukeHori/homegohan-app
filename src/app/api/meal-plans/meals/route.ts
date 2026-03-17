import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { buildCatalogSelectionUpdate } from '../../../../lib/catalog-products';
import {
  buildDishImagePayload,
  enqueueMealImageJobs,
  triggerMealImageJobProcessing,
} from '../../../../lib/meal-image-jobs';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const {
      dayDate,
      mealType,
      mode,
      dishName,
      isSimple,
      dishes,
      caloriesKcal,
      description,
      ingredients,
      catalogProductId,
      sourceType,
      imageUrl,
    } = await request.json();

    if (!dayDate || !mealType) {
      return NextResponse.json({ error: 'dayDate and mealType are required' }, { status: 400 });
    }

    const manualImageUrl = typeof imageUrl === 'string' ? imageUrl : undefined;
    const imageModel = process.env.GEMINI_IMAGE_MODEL ?? undefined;
    const triggerSource = 'nextjs:meal-plans/meals:POST';
    const requestId = request.headers.get('x-request-id') ?? null;
    const hasImageManagedDishes = Array.isArray(dishes) && dishes.length > 0;
    const dishImagePayload = hasImageManagedDishes
      ? await buildDishImagePayload({
          previousDishes: null,
          nextDishes: dishes ?? undefined,
          dishName: dishName ?? undefined,
          triggerSource,
          imageUrlOverride: manualImageUrl,
          imageModel,
          existingCover: null,
          fallbackMealImageUrl: imageUrl ?? null,
        })
      : {
          dishes: dishes || null,
          jobs: [],
          mealCoverImageUrl: imageUrl ?? null,
        };

    // Get or create user_daily_meals for the target date
    let { data: existingDay } = await supabase
      .from('user_daily_meals')
      .select('id')
      .eq('user_id', user.id)
      .eq('day_date', dayDate)
      .single();

    let dailyMealId: string;

    if (existingDay) {
      dailyMealId = existingDay.id;
    } else {
      const { data: newDay, error: dayError } = await supabase
        .from('user_daily_meals')
        .insert({
          user_id: user.id,
          day_date: dayDate,
          is_cheat_day: false
        })
        .select('id')
        .single();

      if (dayError) throw dayError;
      dailyMealId = newDay.id;
    }

    // 同じタイプの食事を複数追加可能にするため、削除はしない
    // Create new planned meal
    const insertData: Record<string, any> = {
      daily_meal_id: dailyMealId,
      meal_type: mealType,
      mode: mode || 'cook',
      dish_name: dishName || '未設定',
      is_simple: isSimple ?? true,
      dishes: dishImagePayload.dishes,
      calories_kcal: caloriesKcal || null,
      description: description || null,
      ingredients: ingredients || null,
      image_url: dishImagePayload.mealCoverImageUrl,
      is_completed: false,
      source_type: sourceType || 'manual',
    };

    if (catalogProductId) {
      const { fields } = await buildCatalogSelectionUpdate({
        supabase,
        catalogProductId,
        mode: mode || 'buy',
        description: description || null,
        selectedFrom: 'manual_search',
      });
      Object.assign(insertData, fields);
    }

    const { data: newMeal, error: mealError } = await supabase
      .from('planned_meals')
      .insert(insertData)
      .select()
      .single();

    if (mealError) throw mealError;

    await enqueueMealImageJobs({
      supabase,
      plannedMealId: newMeal.id,
      userId: user.id,
      triggerSource,
      jobSeeds: dishImagePayload.jobs as any,
      requestId,
    });
    if (dishImagePayload.jobs.length > 0) {
      await triggerMealImageJobProcessing({
        plannedMealId: newMeal.id,
        limit: dishImagePayload.jobs.length,
      });
    }

    return NextResponse.json({ 
      success: true,
      meal: {
        id: newMeal.id,
        dailyMealId: newMeal.daily_meal_id,
        mealType: newMeal.meal_type,
        mode: newMeal.mode,
        dishName: newMeal.dish_name,
        isSimple: newMeal.is_simple,
        dishes: newMeal.dishes,
        caloriesKcal: newMeal.calories_kcal,
        description: newMeal.description,
        ingredients: newMeal.ingredients,
        isCompleted: newMeal.is_completed,
        createdAt: newMeal.created_at,
        updatedAt: newMeal.updated_at
      }
    });
  } catch (error: any) {
    console.error('Add meal error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
