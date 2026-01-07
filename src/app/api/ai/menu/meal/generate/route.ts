import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';

// Vercel Proプランでは最大300秒まで延長可能
export const maxDuration = 300;

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

    // 2. user_daily_meals を取得または作成（日付ベースモデル）
    let { data: dailyMeal, error: dailyMealError } = await supabase
      .from('user_daily_meals')
      .select('id')
      .eq('user_id', user.id)
      .eq('day_date', dayDate)
      .maybeSingle();

    if (dailyMealError) throw new Error(`Failed to fetch user_daily_meals: ${dailyMealError.message}`);

    if (!dailyMeal) {
      const { data: newDailyMeal, error: createError } = await supabase
        .from('user_daily_meals')
        .insert({
          user_id: user.id,
          day_date: dayDate,
          is_cheat_day: false,
        })
        .select('id')
        .single();

      if (createError) throw new Error(`Failed to create user_daily_meals: ${createError.message}`);
      dailyMeal = newDailyMeal;
    }

    // 3. リクエストをDBに保存（ステータス追跡用）
    const { data: requestData, error: insertError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: dayDate,
        target_date: dayDate,
        target_meal_type: mealType,
        mode: 'single',
        status: 'processing',
        prompt: note || '',
        constraints: preferences || {},
      })
      .select('id')
      .single();

    if (insertError || !requestData?.id) {
      console.error('Failed to create request record:', insertError);
      return NextResponse.json({ error: insertError?.message || 'Failed to create request' }, { status: 500 });
    }

    console.log(`📝 Request created for ${dayDate} ${mealType}, requestId: ${requestData?.id}`);

    // 4. Edge Function を非同期で呼び出し（完了を待たない）
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceKey = process.env.SERVICE_ROLE_JWT || process.env.SUPABASE_SERVICE_ROLE_KEY!;

    console.log('🚀 Calling Edge Function generate-single-meal-v3...');

    const edgeFunctionPromise = fetch(`${supabaseUrl}/functions/v1/generate-single-meal-v3`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'apikey': supabaseServiceKey,
      },
      body: JSON.stringify({
        target_date: dayDate,
        date: dayDate,
        meal_type: mealType,
        mealType,
        mealTypes: [mealType],
        userId: user.id,
        preferences: preferences || {},
        note: note || '',
        request_id: requestData.id,
        requestId: requestData.id,
        dailyMealId: dailyMeal.id,
      }),
    }).then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error('❌ Edge Function error:', res.status, text);
        await supabase
          .from('weekly_menu_requests')
          .update({
            status: 'failed',
            error_message: `edge_function_error:${res.status}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', requestData.id);
      }
    }).catch(async (err) => {
      console.error('❌ Edge Function call error:', err.message);
      await supabase
        .from('weekly_menu_requests')
        .update({
          status: 'failed',
          error_message: err.message,
          updated_at: new Date().toISOString(),
        })
        .eq('id', requestData.id);
    });

    waitUntil(edgeFunctionPromise);

    return NextResponse.json({ 
      success: true,
      message: 'Meal generation started in background',
      status: 'processing',
      requestId: requestData.id,
    });

  } catch (error: any) {
    console.error("Single Meal Generation Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
