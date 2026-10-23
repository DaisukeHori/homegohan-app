import { createClient } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { callGenerateMenuV4WithRetry, markWeeklyMenuRequestFailed } from '@/lib/generate-menu-v4-retry';
import { callGenerateMenuV5WithRetry } from '@/lib/generate-menu-v5-retry';
import { getSupabaseServiceConfig } from '@/lib/env-required';
import { internalError } from '@/lib/api/errors';
import { createLogger } from '@/lib/db-logger';
import type { Tables } from '@homegohan/shared';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiDailyLimitResponse, consumeAiUsage, refundAiUsage } from '@/lib/plan/entitlements';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { AI_MENU_MEAL_ID_INVALID_MESSAGE, AI_MENU_MEAL_NOT_FOUND_MESSAGE, AI_MENU_MEAL_REGENERATION_STARTED_MESSAGE } from '@/lib/ai/ai-api-messages';

// Vercel Proプランでは最大300秒まで延長可能
export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();

  try {
    const { mealId, preferences, note } = await request.json();

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

    // 2. mealIdが必須 + UUID形式チェック
    if (!mealId || typeof mealId !== 'string' || !UUID_RE.test(mealId)) {
      return NextResponse.json({ error: AI_MENU_MEAL_ID_INVALID_MESSAGE }, { status: 400 });
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
      return NextResponse.json({ error: AI_MENU_MEAL_NOT_FOUND_MESSAGE }, { status: 404 });
    }

    const dayDate = day.day_date;
    const mealType = plannedMeal.meal_type;

    console.log(`📝 Regenerating meal: ${mealId}`);

    // #1149 AI の利用回数の上限の判定と記録 (#1177)。AI へ送る直前 (入力の検証・同意などの判定のあと) に、操作 1 回につき 1 回数える。
    // 上限に達していれば数えずに 429 AI_DAILY_LIMIT (判定に失敗したときは止めない)
    const aiUsage = await consumeAiUsage(user.id, 'menu_generation');
    if (!aiUsage.allowed) return aiDailyLimitResponse(aiUsage);

    // 3. リクエストをDBに保存（ステータス追跡用）
    // is_generating フラグは使用しない（ポーリングで状態を監視）
    const { data: requestData, error: insertError } = await queueDb
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
      // 生成を始める前に止まった (AI へは何も送っていない) ので、数えた 1 回を戻す (#1149)
      await refundAiUsage(user.id, 'menu_generation', aiUsage);
      return internalError('POST /api/ai/menu/meal/regenerate', insertError, { userId: user.id });
    }

    // 4. target_slotsを生成（再生成用: plannedMealId付き）
    const targetSlots = [{ date: dayDate, mealType, plannedMealId: mealId }];

    // target_slotsをリクエストに保存
    // #1148: エンジンの切り替えは feature_flags (運営画面で切り替える) を見る
    const useV5Wrapped = await isFeatureEnabled('menu_generation_v5_wrapped', user.id);
    const engine = useV5Wrapped ? 'v5' : 'v4';

    await queueDb
      .from('weekly_menu_requests')
      .update({
        target_slots: targetSlots,
        mode: engine,
        current_step: 1,
      })
      .eq('id', requestData.id)
      .eq('user_id', user.id);

    // 5. Edge Function generate-menu-v4 を非同期で呼び出し
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
          supabase: queueDb,
          requestId: requestData.id,
          errorMessage: result.errorMessage,
        });
      }
    });

    waitUntil(edgeFunctionPromise);

    return NextResponse.json({ 
      success: true,
      message: AI_MENU_MEAL_REGENERATION_STARTED_MESSAGE,
      status: 'processing',
      requestId: requestData.id,
      regeneratingMealId: mealId,
    });

  } catch (error: unknown) {
    // 500 の本文は汎用メッセージだけ。元のエラー (必須の環境変数が欠けていたときはその変数名も) は構造化ログに残す (#1172 / #1182)
    return internalError('POST /api/ai/menu/meal/regenerate', error);
  }
}
