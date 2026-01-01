import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// Vercel Proプランでは最大300秒まで延長可能
export const maxDuration = 300;

// 週の開始日（月曜日）を取得
function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

// 週の終了日を取得
function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}

const DISPLAY_ORDER_MAP: Record<string, number> = {
  breakfast: 10,
  lunch: 20,
  dinner: 30,
  snack: 40,
  midnight_snack: 50,
};

// 1食分だけをAIで生成するAPI（新規追加用）
export async function POST(request: Request) {
  const supabase = await createClient();

  try {
    const { dayDate, mealType, preferences, note } = await request.json();

    if (!dayDate || !mealType) {
      return NextResponse.json({ error: 'dayDate and mealType are required' }, { status: 400 });
    }

    // 1. ユーザー認証
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. meal_planを取得または作成
    const weekStart = getWeekStart(dayDate);
    const weekEnd = addDays(weekStart, 6);

    let { data: mealPlan, error: planError } = await supabase
      .from('meal_plans')
      .select('id')
      .eq('user_id', user.id)
      .eq('start_date', weekStart)
      .maybeSingle();

    if (planError) throw new Error(`Failed to fetch meal_plan: ${planError.message}`);

    if (!mealPlan) {
      const ws = new Date(weekStart);
      const title = `${ws.getMonth() + 1}月${ws.getDate()}日〜の献立`;
      const { data: newPlan, error: createError } = await supabase
        .from('meal_plans')
        .insert({
          user_id: user.id,
          title,
          start_date: weekStart,
          end_date: weekEnd,
          status: 'active',
          is_active: true,
        })
        .select('id')
        .single();

      if (createError) throw new Error(`Failed to create meal_plan: ${createError.message}`);
      mealPlan = newPlan;
    }

    // 3. meal_plan_dayを取得または作成
    let { data: mealPlanDay, error: dayError } = await supabase
      .from('meal_plan_days')
      .select('id')
      .eq('meal_plan_id', mealPlan.id)
      .eq('day_date', dayDate)
      .maybeSingle();

    if (dayError) throw new Error(`Failed to fetch meal_plan_day: ${dayError.message}`);

    if (!mealPlanDay) {
      const { data: newDay, error: createDayError } = await supabase
        .from('meal_plan_days')
        .insert({
          meal_plan_id: mealPlan.id,
          day_date: dayDate,
        })
        .select('id')
        .single();

      if (createDayError) throw new Error(`Failed to create meal_plan_day: ${createDayError.message}`);
      mealPlanDay = newDay;
    }

    // 4. プレースホルダーレコードを作成（is_generating=true）
    const { data: newMeal, error: mealError } = await supabase
      .from('planned_meals')
      .insert({
        meal_plan_day_id: mealPlanDay.id,
        meal_type: mealType,
        dish_name: '生成中...',
        is_generating: true,
        mode: 'cook',
        display_order: DISPLAY_ORDER_MAP[mealType] ?? 0,
      })
      .select('id')
      .single();

    if (mealError) {
      console.error(`Failed to create placeholder for ${dayDate} ${mealType}:`, mealError);
      throw new Error(`Failed to create placeholder: ${mealError.message}`);
    }

    console.log(`📝 Created placeholder meal: ${newMeal.id} for ${dayDate} ${mealType}`);

    // 5. リクエストをDBに保存（ステータス追跡用）
    const { data: requestData, error: insertError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: dayDate,
        target_date: dayDate,
        target_meal_type: mealType,
        target_meal_id: newMeal.id,
        mode: 'single',
        status: 'processing',
        prompt: note || '',
        constraints: preferences || {},
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('Failed to create request record:', insertError);
    }

    // NOTE:
    // - Edge Function名の `*-v2` は「献立生成ロジックの世代（dataset駆動）」を表します。
    // - `/functions/v1/...` の "v1" は Supabase側のHTTPパスのバージョンで、ロジックのv1/v2とは別です。
    //
    // 6. Edge Function を非同期で呼び出し（完了を待たない）
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    console.log('🚀 Calling Edge Function generate-single-meal-v2...');

    fetch(`${supabaseUrl}/functions/v1/generate-single-meal-v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        dayDate,
        mealType,
        mealTypes: [mealType],
        userId: user.id,
        preferences: preferences || {},
        note: note || '',
        requestId: requestData?.id,
        targetMealId: newMeal.id, // プレースホルダーのIDを渡す
      }),
    }).catch(err => {
      console.error('❌ Edge Function call error:', err.message);
    });

    return NextResponse.json({ 
      success: true,
      message: 'Meal generation started in background',
      status: 'processing',
      requestId: requestData?.id,
      generatingMealId: newMeal.id, // 生成中のmeal IDを返す
    });

  } catch (error: any) {
    console.error("Single Meal Generation Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
