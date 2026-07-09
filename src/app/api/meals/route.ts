import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { buildCatalogSelectionUpdate } from '../../../lib/catalog-products';
import {
  buildDishImagePayload,
  enqueueMealImageJobs,
  triggerMealImageJobProcessing,
} from '../../../lib/meal-image-jobs';
import { checkRateLimit } from '@/lib/rate-limit';
import { createLogger } from '@/lib/db-logger';

/**
 * 食事一覧取得（日付ベースモデル: user_daily_meals → planned_meals）
 * 今日の献立または指定日の献立を取得
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  
  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date');

    // 日付が指定されていない場合は今日
    const targetDate = date || new Date().toISOString().split('T')[0];

    // user_daily_mealsとplanned_mealsをJOINして取得
    const { data: dailyMeal, error: dayError } = await supabase
      .from('user_daily_meals')
      .select(`
        id,
        day_date,
        theme,
        nutritional_focus,
        is_cheat_day,
        planned_meals(*)
      `)
      .eq('day_date', targetDate)
      .eq('user_id', user.id)
      .maybeSingle();

    if (dayError) {
      return NextResponse.json({ error: dayError.message }, { status: 500 });
    }

    if (!dailyMeal) {
      return NextResponse.json({ meals: [] });
    }

    // display_orderでソート
    const meals = (dailyMeal.planned_meals || []).sort(
      (a: any, b: any) => (a.display_order ?? 0) - (b.display_order ?? 0)
    );

    return NextResponse.json({ meals });

  } catch (error: any) {
    console.error('Error fetching meals:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * 新しい食事を追加（日付ベースモデル: user_daily_meals upsert → planned_meals insert）
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  
  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { 
      date, 
      mealType, 
      dishName, 
      mode = 'cook',
      description,
      imageUrl,
      caloriesKcal,
      ingredients,
      dishes,
      catalogProductId,
      sourceType,
    } = body;

    if (!date || !mealType || !dishName) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const manualImageUrl = typeof imageUrl === 'string' ? imageUrl : undefined;
    const imageModel = process.env.GEMINI_IMAGE_MODEL ?? undefined;
    const triggerSource = 'nextjs:meals:POST';
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
          dishes: dishes ?? null,
          jobs: [],
          mealCoverImageUrl: imageUrl ?? null,
        };

    // 1. user_daily_mealsをupsert
    const { data: dailyMeal, error: dailyMealError } = await supabase
      .from('user_daily_meals')
      .upsert(
        { 
          user_id: user.id, 
          day_date: date,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'user_id,day_date' }
      )
      .select('id')
      .single();

    if (dailyMealError || !dailyMeal) {
      throw dailyMealError || new Error('Failed to create daily meal');
    }

    // 2. planned_mealを追加
    const insertData: Record<string, any> = {
      daily_meal_id: dailyMeal.id,
      meal_type: mealType,
      dish_name: dishName,
      mode: mode,
      description: description,
      calories_kcal: caloriesKcal,
      ingredients: ingredients,
      image_url: dishImagePayload.mealCoverImageUrl,
      dishes: dishImagePayload.dishes,
      is_completed: false,
      source_type: sourceType || 'manual',
    };

    if (catalogProductId) {
      const { fields } = await buildCatalogSelectionUpdate({
        supabase,
        catalogProductId,
        mode: mode || 'buy',
        imageUrl: imageUrl ?? undefined,
        description: description ?? undefined,
        selectedFrom: 'manual_search',
      });
      Object.assign(insertData, fields);
    }

    const { data: meal, error: mealError } = await supabase
      .from('planned_meals')
      .insert(insertData)
      .select()
      .single();

    if (mealError) throw mealError;

    let imageGenerationThrottled = false;
    if (dishImagePayload.jobs.length > 0) {
      // #1022 画像副作用（enqueue + trigger）は meal 本体の成否から独立させる。
      // - rate 超過時は enqueue 自体もスキップし、孤児 pending ジョブ（掃かれず永久欠落する行）を作らない。
      // - checkRateLimit が例外（Upstash 到達不能等）を投げても、ここではローカルで握りつぶし
      //   画像生成をスキップするだけに留める。meal 作成自体の成否（200）には波及させない。
      //   ※ この緩和は画像副作用サイト限定。主目的が AI 呼び出しの route は fail-close を維持する。
      let imageAllowed = false;
      try {
        const rl = await checkRateLimit(user.id, 'image');
        imageAllowed = rl.success;
      } catch (rlError) {
        createLogger('api/meals').warn('Image rate-limit check failed; skipping image generation', {
          userId: user.id,
          plannedMealId: meal.id,
          error: rlError instanceof Error ? rlError.message : String(rlError),
        });
        imageAllowed = false;
      }

      if (imageAllowed) {
        await enqueueMealImageJobs({
          supabase,
          plannedMealId: meal.id,
          userId: user.id,
          triggerSource,
          jobSeeds: dishImagePayload.jobs,
          requestId,
        });
        await triggerMealImageJobProcessing({
          plannedMealId: meal.id,
          limit: dishImagePayload.jobs.length,
        });
      } else {
        imageGenerationThrottled = true;
        console.warn('[meals] Image generation skipped due to rate limit', {
          userId: user.id,
          plannedMealId: meal.id,
        });
      }
    }

    return NextResponse.json({
      meal,
      // #1022 (Suggestion): 画像生成がスロットルされた場合のみ additive にフラグを付与する
      ...(imageGenerationThrottled ? { imageGenerationThrottled: true } : {}),
    });

  } catch (error: any) {
    console.error('Error creating meal:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
