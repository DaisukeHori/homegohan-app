import { createClient } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { callGenerateMenuV4WithRetry, markWeeklyMenuRequestFailed } from '@/lib/generate-menu-v4-retry';
import { callGenerateMenuV5WithRetry } from '@/lib/generate-menu-v5-retry';
import { getSupabaseServiceConfig } from '@/lib/env-required';
import { internalError } from '@/lib/api/errors';
import { resolveExistingTargetSlots } from '@/lib/v4-target-slots';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { recordAiUsage } from '@/lib/plan/entitlements';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { CALENDAR_DATE_REQUIREMENT, isCalendarDate } from '@/lib/date-utils';

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

    // dayDate は YYYY-MM-DD の実在する日付 (isCalendarDate の範囲 0101-01-02〜9998-12-30 の中) だけを受け付ける (#1433)。DB の date 型は 2026/10/10 なども日付として読むが、
    // そのまま target_slots に入ると、献立生成 (Edge Function) が日付を前後にずらすところで RangeError になる
    if (!isCalendarDate(dayDate)) {
      return NextResponse.json({ error: `dayDate must be ${CALENDAR_DATE_REQUIREMENT}` }, { status: 400 });
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

    // #1177 AI 利用回数の記録。AI へ送る直前 (入力の検証・同意などの判定のあと) に、操作 1 回につき 1 回記録する
    // (記録に失敗しても止めない)
    await recordAiUsage(user.id, 'menu_generation');

    // 3. リクエストをDBに保存（ステータス追跡用）
    const { data: requestData, error: insertError } = await queueDb
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
      message: 'Meal generation started in background',
      status: 'processing',
      requestId: requestData.id,
    });

  } catch (error: unknown) {
    // 500 の本文は汎用メッセージだけ。元のエラー (必須の環境変数が欠けていたときはその変数名も) は構造化ログに残す (#1172 / #1182)
    return internalError('POST /api/ai/menu/meal/generate', error);
  }
}
