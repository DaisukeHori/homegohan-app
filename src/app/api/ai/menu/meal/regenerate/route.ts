import { createClient } from '@/lib/supabase/server';
import { loadFeatureFlags } from '@/lib/menu-generation-feature-flags';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { callGenerateMenuV4WithRetry, markWeeklyMenuRequestFailed } from '@/lib/generate-menu-v4-retry';
import { callGenerateMenuV5WithRetry } from '@/lib/generate-menu-v5-retry';
import { createLogger } from '@/lib/db-logger';
import type { Tables } from '@homegohan/shared';

// Vercel Proプランでは最大300秒まで延長可能
export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const supabase = await createClient();

  try {
    const { mealId, preferences, note } = await request.json();

    // 1. ユーザー認証
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. mealIdが必須 + UUID形式チェック
    if (!mealId || typeof mealId !== 'string' || !UUID_RE.test(mealId)) {
      return NextResponse.json({ error: 'mealId must be a valid UUID' }, { status: 400 });
    }

    // 2.5 所有権検証（IDOR対策）: 自分が所有する planned_meal かどうかを確認し、
    // meal_type / dayDate はクライアント入力ではなく DB から取得した値を正とする
    const { data: plannedMeal, error: plannedMealError } = await supabase
      .from('planned_meals')
      .select('id, meal_type, user_daily_meals!inner(day_date, user_id)')
      .eq('id', mealId)
      .eq('user_daily_meals.user_id', user.id)
      .maybeSingle();

    if (plannedMealError) {
      createLogger('api/ai/menu/meal/regenerate').withUser(user.id).error(
        'planned_meal の所有権確認に失敗しました',
        plannedMealError,
        { mealId },
      );
      return NextResponse.json({ error: '献立の取得に失敗しました' }, { status: 500 });
    }

    const day = (plannedMeal?.user_daily_meals as unknown as Pick<Tables<'user_daily_meals'>, 'day_date'> | null) ?? null;
    if (!plannedMeal || !day?.day_date || !plannedMeal.meal_type) {
      return NextResponse.json({ error: 'Meal not found' }, { status: 404 });
    }

    const dayDate = day.day_date;
    const mealType = plannedMeal.meal_type;

    console.log(`📝 Regenerating meal: ${mealId}`);

    // 3. リクエストをDBに保存（ステータス追跡用）
    // is_generating フラグは使用しない（ポーリングで状態を監視）
    const { data: requestData, error: insertError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: dayDate,
        target_date: dayDate,
        target_meal_type: mealType,
        target_meal_id: mealId,
        mode: 'regenerate',
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

    // 4. target_slotsを生成（再生成用: plannedMealId付き）
    const targetSlots = [{ date: dayDate, mealType, plannedMealId: mealId }];

    // target_slotsをリクエストに保存
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
      message: 'Meal regeneration started in background',
      status: 'processing',
      requestId: requestData.id,
      regeneratingMealId: mealId,
    });

  } catch (error: any) {
    console.error("Meal Regeneration Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
