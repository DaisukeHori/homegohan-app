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

    // 4. target_slotsを生成（その日の全食事）
    const mealTypes = ['breakfast', 'lunch', 'dinner'];
    const targetSlots = mealTypes.map(mealType => {
      const existingMeal = (meals || []).find(m => m.meal_type === mealType);
      return {
        date: dailyMeal.day_date,
        mealType,
        plannedMealId: existingMeal?.id || undefined,
      };
    });

    // 5. リクエストを作成
    const { data: requestData, error: insertError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: dailyMeal.day_date,
        target_date: dailyMeal.day_date,
        mode: 'v4',
        status: 'processing',
        target_slots: targetSlots,
        constraints: preferences || {},
        current_step: 1,
      })
      .select('id')
      .single();

    if (insertError || !requestData) {
      console.error('Failed to create request:', insertError);
      return NextResponse.json({ error: 'Failed to create request' }, { status: 500 });
    }

    // 6. generate-menu-v4を呼び出し
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceKey = process.env.SERVICE_ROLE_JWT || process.env.SUPABASE_SERVICE_ROLE_KEY!;

    fetch(`${supabaseUrl}/functions/v1/generate-menu-v4`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        userId: user.id,
        requestId: requestData.id,
        targetSlots,
        constraints: preferences || {},
      }),
    }).catch(console.error);

    return NextResponse.json({
      success: true,
      message: 'Day regeneration started in background',
      status: 'processing',
      requestId: requestData.id,
      mealsCount: targetSlots.length
    });

  } catch (error: any) {
    console.error("Day Regeneration Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
