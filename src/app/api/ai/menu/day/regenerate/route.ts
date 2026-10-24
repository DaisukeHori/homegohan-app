import { createClient } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { callGenerateMenuV4WithRetry, markWeeklyMenuRequestFailed } from '@/lib/generate-menu-v4-retry';
import { callGenerateMenuV5WithRetry } from '@/lib/generate-menu-v5-retry';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { getSupabaseServiceConfig } from '@/lib/env-required';
import { internalError } from '@/lib/api/errors';
import { isUuid } from '@/lib/http-params';
import { isCalendarDate } from '@/lib/date-utils';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiDailyLimitResponse, consumeAiUsage, refundAiUsage } from '@/lib/plan/entitlements';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { aiRequiredFieldMessage, AI_MENU_DAY_NOT_FOUND_MESSAGE, AI_MENU_REQUEST_CREATE_FAILED_MESSAGE, AI_MENU_DAY_REGENERATION_STARTED_MESSAGE } from '@/lib/ai/ai-api-messages';

// Vercel Proプランでは最大300秒まで延長可能
export const maxDuration = 300;

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();

  try {
    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const requestBody = await request.json().catch(() => null);
    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    const { dailyMealId, dayDate, preferences, includeCompleted } = requestBody;

    if (!dailyMealId && !dayDate) {
      return NextResponse.json({ error: aiRequiredFieldMessage('日付') }, { status: 400 });
    }

    // 1. ユーザー認証
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
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

    // 形の違う ID (UUID でない)・日付 (実在しない日付) は DB に渡さず 404 (uuid / date 型の列に渡すと型の変換で失敗し、
    // 下の「DB の失敗は 500」に入る。以前は DB の失敗も「その日が無い」と同じ 404 にしていた。#1917)
    if (dailyMealId ? !isUuid(dailyMealId) : !isCalendarDate(dayDate)) {
      return NextResponse.json({ error: AI_MENU_DAY_NOT_FOUND_MESSAGE }, { status: 404 });
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
        .maybeSingle();

      // 読めなかったときは 404 にしない (行が無いときだけ 404。#1917)
      if (dayError) {
        return internalError('POST /api/ai/menu/day/regenerate', dayError, { userId: user.id, table: 'user_daily_meals' });
      }
      if (!dayData) {
        return NextResponse.json({ error: AI_MENU_DAY_NOT_FOUND_MESSAGE }, { status: 404 });
      }
      targetDayId = dayData.id;
    }

    // 3. その日の全てのplanned_mealsを取得
    const { data: dailyMeal, error: dailyMealError } = await supabase
      .from('user_daily_meals')
      .select('id, day_date')
      .eq('id', targetDayId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (dailyMealError) {
      return internalError('POST /api/ai/menu/day/regenerate', dailyMealError, { userId: user.id, table: 'user_daily_meals' });
    }
    if (!dailyMeal) {
      return NextResponse.json({ error: AI_MENU_DAY_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    const { data: meals, error: mealsError } = await supabase
      .from('planned_meals')
      .select('id, meal_type, is_completed')
      .eq('daily_meal_id', targetDayId);

    if (mealsError) {
      return internalError('POST /api/ai/menu/day/regenerate', mealsError, { userId: user.id });
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
      return NextResponse.json({ error: AI_MENU_REQUEST_CREATE_FAILED_MESSAGE }, { status: 500 });
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
      message: AI_MENU_DAY_REGENERATION_STARTED_MESSAGE,
      status: 'processing',
      requestId: requestData.id,
      mealsCount: targetSlots.length
    });

  } catch (error: unknown) {
    // 500 の本文は汎用メッセージだけ。元のエラー (必須の環境変数が欠けていたときはその変数名も) は構造化ログに残す (#1172 / #1182)
    return internalError('POST /api/ai/menu/day/regenerate', error);
  }
}
