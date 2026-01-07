import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();

  try {
    const { dailyMealId, dayDate, preferences } = await request.json();

    if (!dailyMealId && !dayDate) {
      return NextResponse.json({ error: 'Either dailyMealId or dayDate is required' }, { status: 400 });
    }

    // 1. ユーザー認証
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. daily_meal_idを取得
    let targetDayId = dailyMealId;
    
    if (!targetDayId && dayDate) {
      // dayDateからuser_daily_mealsのidを取得
      const { data: dayData, error: dayError } = await supabase
        .from('user_daily_meals')
        .select('id')
        .eq('day_date', dayDate)
        .eq('user_id', user.id)
        .single();

      if (dayError || !dayData) {
        return NextResponse.json({ error: 'Day not found' }, { status: 404 });
      }
      targetDayId = dayData.id;
    }

    // 3. その日の全てのplanned_mealsを取得
    const { data: dailyMeal, error: dailyMealError } = await supabase
      .from('user_daily_meals')
      .select('id, day_date')
      .eq('id', targetDayId)
      .eq('user_id', user.id)
      .single();

    if (dailyMealError || !dailyMeal) {
      return NextResponse.json({ error: 'Daily meal not found' }, { status: 404 });
    }

    const { data: meals, error: mealsError } = await supabase
      .from('planned_meals')
      .select('id, meal_type')
      .eq('daily_meal_id', targetDayId);

    if (mealsError) {
      return NextResponse.json({ error: mealsError.message }, { status: 500 });
    }

    // NOTE:
    // - Edge Function名の `*-v2` は「献立生成ロジックの世代（dataset駆動）」を表します。
    // - `/functions/v1/...` の "v1" は Supabase側のHTTPパスのバージョンで、ロジックのv1/v2とは別です。
    //
    // 4. 各食事を個別に再生成
    const regenerationPromises = (meals || []).map(async (meal) => {
      const { error: invokeError } = await supabase.functions.invoke('regenerate-meal-direct-v3', {
        body: {
          mealId: meal.id,
          dayDate: dailyMeal.day_date,
          mealType: meal.meal_type,
          userId: user.id,
          preferences: preferences || {},
          note: '',
        },
      });

      if (invokeError) {
        console.error(`Failed to regenerate meal ${meal.id}:`, invokeError);
      }
    });

    // 全ての再生成を開始（非同期で実行されるため、すぐに返す）
    Promise.all(regenerationPromises).catch(console.error);

    return NextResponse.json({ 
      success: true,
      message: 'Day regeneration started in background',
      status: 'processing',
      mealsCount: meals?.length || 0
    });

  } catch (error: any) {
    console.error("Day Regeneration Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
