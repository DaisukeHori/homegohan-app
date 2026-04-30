import { createClient } from '@/lib/supabase/server';
import { loadFeatureFlags } from '@/lib/menu-generation-feature-flags';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { callGenerateMenuV4WithRetry, markWeeklyMenuRequestFailed } from '@/lib/generate-menu-v4-retry';
import { callGenerateMenuV5WithRetry } from '@/lib/generate-menu-v5-retry';
import { resolveExistingTargetSlots } from '@/lib/v4-target-slots';

// Vercel Proプランでは最大300秒まで延長可能
export const maxDuration = 300;

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

    const targetSlots = await resolveExistingTargetSlots({
      supabase,
      userId: user.id,
      targetSlots: [{ date: dayDate, mealType }],
    });

    if (targetSlots[0]?.plannedMealId) {
      return NextResponse.json(
        { error: 'Meal already exists for this slot. Use regenerate instead.' },
        { status: 409 },
      );
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

    // 4. target_slotsを保存（1スロット）
    const featureFlags = await loadFeatureFlags(supabase);
    const useV5Wrapped = Boolean(featureFlags.menu_generation_v5_wrapped);
    const engine = useV5Wrapped ? 'v5' : 'v4';

    await supabase
      .from('weekly_menu_requests')
      .update({
        target_slots: targetSlots,
        mode: engine,
        current_step: 1,
      })
      .eq('id', requestData.id);

    // 5. Edge Function generate-menu-v4 を非同期で呼び出し
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const generator = useV5Wrapped ? callGenerateMenuV5WithRetry : callGenerateMenuV4WithRetry;
    const targetLabel = useV5Wrapped ? 'generate-menu-v5' : 'generate-menu-v4';

    console.log(`🚀 Calling Edge Function ${targetLabel}...`);

    const edgeFunctionPromise = generator({
      supabaseUrl,
      serviceRoleKey: supabaseServiceKey,
      extraHeaders: {
        apikey: supabaseServiceKey,
      },
      payload: {
        userId: user.id,
        requestId: requestData.id,
        targetSlots,
        note: note || '',
        constraints: preferences || {},
      },
    }).then(async (result) => {
      if (!result.ok) {
        console.error('❌ Edge Function error:', result.errorMessage);
        await markWeeklyMenuRequestFailed({
          supabase,
          requestId: requestData.id,
          errorMessage: result.errorMessage,
        });
      }
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
