import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();

  try {
    const { mealPlanDayId, dayDate, preferences } = await request.json();

    if (!mealPlanDayId && !dayDate) {
      return NextResponse.json({ error: 'Either mealPlanDayId or dayDate is required' }, { status: 400 });
    }

    // 1. ユーザー認証
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. meal_plan_day_idを取得
    let targetDayId = mealPlanDayId;
    
    if (!targetDayId && dayDate) {
      // dayDateからmeal_plan_day_idを取得
      const { data: dayData, error: dayError } = await supabase
        .from('meal_plan_days')
        .select(`
          id,
          meal_plans!inner(user_id)
        `)
        .eq('day_date', dayDate)
        .eq('meal_plans.user_id', user.id)
        .single();

      if (dayError || !dayData) {
        return NextResponse.json({ error: 'Day not found' }, { status: 404 });
      }
      targetDayId = dayData.id;
    }

    // 3. その日の全てのplanned_mealsを取得
    const { data: meals, error: mealsError } = await supabase
      .from('planned_meals')
      .select(`
        id,
        meal_type,
        meal_plan_days!inner(
          day_date,
          meal_plans!inner(user_id)
        )
      `)
      .eq('meal_plan_day_id', targetDayId)
      .eq('meal_plan_days.meal_plans.user_id', user.id);

    if (mealsError) {
      return NextResponse.json({ error: mealsError.message }, { status: 500 });
    }

    // NOTE:
    // - Edge Function名の `*-v2` は「献立生成ロジックの世代（dataset駆動）」を表します。
    // - `/functions/v1/...` の "v1" は Supabase側のHTTPパスのバージョンで、ロジックのv1/v2とは別です。
    //
    // 4. 各食事を個別に再生成
    const regenerationPromises = (meals || []).map(async (meal) => {
      const { error: invokeError } = await supabase.functions.invoke('regenerate-meal-direct-v2', {
        body: {
          mealId: meal.id,
          dayDate: (meal.meal_plan_days as any)?.day_date,
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
