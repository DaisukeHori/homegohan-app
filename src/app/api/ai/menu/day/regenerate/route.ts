import { createClient } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { callGenerateMenuV4WithRetry, markWeeklyMenuRequestFailed } from '@/lib/generate-menu-v4-retry';
import { callGenerateMenuV5WithRetry } from '@/lib/generate-menu-v5-retry';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { getSupabaseServiceConfig } from '@/lib/env-required';
import { internalError } from '@/lib/api/errors';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiDailyLimitResponse, consumeAiUsage, refundAiUsage } from '@/lib/plan/entitlements';
import { requireAiConsent } from '@/lib/ai/consent-guard';

// Vercel Proプランでは最大300秒まで延長可能
export const maxDuration = 300;

export async function POST(request: Request) {
  const supabase = await createClient();

  try {
    const { dailyMealId, dayDate, preferences, includeCompleted } = await request.json();

    if (!dailyMealId && !dayDate) {
      return NextResponse.json({ error: 'Either dailyMealId or dayDate is required' }, { status: 400 });
    }

    // 1. ユーザー認証
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 外国の AI 事業者への提供の同意が無ければ、AI へ送らずに止める (T15 / #1154。403 AI_CONSENT_REQUIRED)
    const aiConsentDenied = await requireAiConsent(supabase, user.id);
    if (aiConsentDenied) return aiConsentDenied;

    const rateLimitResult = await checkRateLimit(user.id, 'generation');
    if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

    // 必須の環境変数は、認証とレート制限のあと・DB に書き込む前に確かめる。欠けていれば MissingEnvError で汎用の 500 にする (変数名はサーバーのログと構造化ログにだけ残す)。
    // (未ログインの呼び出しに、設定の不足を教えない。書き込んだあとで気づくと、Edge Function を呼べないまま、
    //  リクエストの行を作って失敗として記録するだけの無駄な動きになる) (#1182)
    const { url: supabaseUrl, serviceRoleKey: supabaseServiceKey } = getSupabaseServiceConfig();
    // AI のキュー (weekly_menu_requests) は利用者 (authenticated) から書けない (#1465)。本人の確認・同意のあとで、service role で書く
    const queueDb = getAiQueueWriter();

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
      .select('id, meal_type, is_completed')
      .eq('daily_meal_id', targetDayId);

    if (mealsError) {
      return NextResponse.json({ error: mealsError.message }, { status: 500 });
    }

    // 4. target_slotsを生成（その日の全食事）
    // #1042: 完食済み(is_completed)の食事は、明示的な includeCompleted:true 指定が
    // ない限り生成対象から除外する。摂取実績・ストリークを遡って壊さないため。
    const allowCompletedOverwrite = includeCompleted === true;
    const mealTypes = ['breakfast', 'lunch', 'dinner'];
    const targetSlots = mealTypes
      .map(mealType => ({
        mealType,
        existingMeal: (meals || []).find(m => m.meal_type === mealType),
      }))
      .filter(({ existingMeal }) => allowCompletedOverwrite || !existingMeal?.is_completed)
      .map(({ mealType, existingMeal }) => ({
        date: dailyMeal.day_date,
        mealType,
        plannedMealId: existingMeal?.id || undefined,
      }));

    if (targetSlots.length === 0) {
      return NextResponse.json({
        success: true,
        status: 'skipped',
        message: '完食済みのため再生成対象がありません',
        mealsCount: 0,
      });
    }

    // 5. リクエストを作成
    // #1148: エンジンの切り替えは feature_flags (運営画面で切り替える) を見る
    const useV5 = await isFeatureEnabled('menu_generation_v5_wrapped', user.id);
    const engine = useV5 ? 'v5' : 'v4';

    // #1149 AI の利用回数の上限の判定と記録 (#1177)。AI へ送る直前 (入力の検証・同意などの判定のあと) に、操作 1 回につき 1 回数える。
    // 上限に達していれば数えずに 429 AI_DAILY_LIMIT (判定に失敗したときは止めない)
    const aiUsage = await consumeAiUsage(user.id, 'menu_generation');
    if (!aiUsage.allowed) return aiDailyLimitResponse(aiUsage);

    const { data: requestData, error: insertError } = await queueDb
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: dailyMeal.day_date,
        target_date: dailyMeal.day_date,
        mode: engine,
        status: 'processing',
        target_slots: targetSlots,
        constraints: preferences || {},
        current_step: 1,
      })
      .select('id')
      .single();

    if (insertError || !requestData) {
      console.error('Failed to create request:', insertError);
      // 生成を始める前に止まった (AI へは何も送っていない) ので、数えた 1 回を戻す (#1149)
      await refundAiUsage(user.id, 'menu_generation', aiUsage);
      return NextResponse.json({ error: 'Failed to create request' }, { status: 500 });
    }

    // 6. Edge Functionを呼び出し（V5/V4をfeature flagで切り替え）
    const generator = useV5 ? callGenerateMenuV5WithRetry : callGenerateMenuV4WithRetry;
    const edgeFunctionPromise = generator({
      supabaseUrl,
      serviceRoleKey: supabaseServiceKey,
      payload: {
        userId: user.id,
        requestId: requestData.id,
        targetSlots,
        constraints: preferences || {},
      },
      ...(useV5 ? { extraHeaders: { apikey: supabaseServiceKey } } : {}),
    }).then(async (result) => {
      if (!result.ok) {
        console.error('❌ Edge Function error:', result.errorMessage);
        await markWeeklyMenuRequestFailed({
          supabase: queueDb,
          requestId: requestData.id,
          errorMessage: result.errorMessage,
        });
      }
    });

    waitUntil(edgeFunctionPromise);

    return NextResponse.json({
      success: true,
      message: 'Day regeneration started in background',
      status: 'processing',
      requestId: requestData.id,
      mealsCount: targetSlots.length
    });

  } catch (error: unknown) {
    // 500 の本文は汎用メッセージだけ。元のエラー (必須の環境変数が欠けていたときはその変数名も) は構造化ログに残す (#1172 / #1182)
    return internalError('POST /api/ai/menu/day/regenerate', error);
  }
}
