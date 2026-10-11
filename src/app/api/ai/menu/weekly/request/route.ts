import { createClient } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { callGenerateMenuV4WithRetry, markWeeklyMenuRequestFailed } from '@/lib/generate-menu-v4-retry';
import { callGenerateMenuV5WithRetry } from '@/lib/generate-menu-v5-retry';
import { getSupabaseServiceConfig } from '@/lib/env-required';
import { internalError } from '@/lib/api/errors';
import { cancelPendingMealImageJobs } from '../../../../../../lib/meal-image-jobs';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiDailyLimitResponse, consumeAiUsage, refundAiUsage } from '@/lib/plan/entitlements';
import { restorePlannedMealsSnapshot, type PlannedMealSnapshotRow } from '@/lib/planned-meals-snapshot';
import { addDaysToDate, todayLocal } from '@/lib/date-utils';
import { isCalendarDate } from '@/lib/jst-day-ranges';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { aiConsentReasonOfStoredError } from '@/lib/ai/consent-config';

// Vercel Proプランでは最大300秒まで延長可能
export const maxDuration = 300;

// 暦日 (YYYY-MM-DD) を days 日ずらす。暦の計算だけで行い、実行環境のタイムゾーンに左右されない (#1433。
// 以前の new Date(dateStr) + setDate (ローカル時刻) + toISOString (UTC) は、実行環境のタイムゾーンで結果が変わった)
function addDays(dateStr: string, days: number): string {
  return addDaysToDate(dateStr, days);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function toStringArray(value: unknown, opts: { max?: number } = {}): string[] {
  const max = opts.max ?? 40;
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .slice(0, max);
}

function toOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toOptionalInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function buildNoteForAi(input: {
  note: unknown;
  constraints: Record<string, any>;
  familySize: number | null;
  cheatDay: string | null;
  detectedIngredients: string[];
}): string | null {
  const base = toOptionalString(input.note) ?? '';

  const constraintLines: string[] = [];

  const themes = toStringArray(input.constraints?.themes);
  if (themes.length) constraintLines.push(`テーマ: ${themes.join('、')}`);

  const ingredients = toStringArray(input.constraints?.ingredients);
  const detected = input.detectedIngredients ?? [];
  const mergedIngredients = Array.from(new Set([...ingredients, ...detected])).slice(0, 40);
  if (mergedIngredients.length) constraintLines.push(`使いたい食材: ${mergedIngredients.join('、')}`);

  const cookingTime = input.constraints?.cookingTime;
  const weekday = toOptionalInt(cookingTime?.weekday);
  const weekend = toOptionalInt(cookingTime?.weekend);
  if (weekday != null || weekend != null) {
    constraintLines.push(`調理時間: 平日${weekday ?? '-'}分 / 休日${weekend ?? '-'}分`);
  }

  if (input.familySize != null) constraintLines.push(`家族人数: ${input.familySize}人分`);
  if (input.cheatDay) constraintLines.push(`チートデイ: ${input.cheatDay}`);

  // 既存UI（menus/weekly）互換: boolean系の希望条件も文に落とす
  const flags: string[] = [];
  if (input.constraints?.useFridgeFirst) flags.push('冷蔵庫の食材を優先');
  if (input.constraints?.quickMeals) flags.push('時短メニュー中心');
  if (input.constraints?.japaneseStyle) flags.push('和食多め');
  if (input.constraints?.healthy) flags.push('ヘルシーに');
  if (flags.length) constraintLines.push(`希望: ${flags.join('、')}`);

  const parts: string[] = [];
  if (base) parts.push(base);
  if (constraintLines.length) parts.push(`【条件】\n- ${constraintLines.join('\n- ')}`);

  const final = parts.join('\n').trim();
  return final ? final : null;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  let _userId: string | undefined;
  let _startDate: string | undefined;

  try {
    const body = await request.json().catch(() => ({}));
    const startDate = body?.startDate;
    _startDate = startDate;

    // preferences / constraints は呼び出し元によって名称が揺れるため両対応
    const rawConstraints = (body?.preferences ?? body?.constraints) as unknown;
    const constraints = isPlainObject(rawConstraints) ? rawConstraints : {};

    const familySize = toOptionalInt(body?.familySize ?? constraints?.familySize);
    const cheatDay = toOptionalString(body?.cheatDay ?? constraints?.cheatDay);
    const detectedIngredients = toStringArray(body?.detectedIngredients, { max: 40 });

    const noteForAi = buildNoteForAi({
      note: body?.note,
      constraints,
      familySize,
      cheatDay,
      detectedIngredients,
    });

    if (!startDate) {
      return NextResponse.json({ error: 'startDate is required' }, { status: 400 });
    }
    // 日付は暦の計算 (addDaysToDate) でずらすので、YYYY-MM-DD の実在する日付 (isCalendarDate の範囲 0101-01-02〜9998-12-30 の中) だけを受け付ける (#1433)
    if (typeof startDate !== 'string' || !isCalendarDate(startDate)) {
      return NextResponse.json({ error: 'startDate must be YYYY-MM-DD' }, { status: 400 });
    }

    // 1. ユーザー確認
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    _userId = user.id;

    // 外国の AI 事業者への提供の同意が無ければ、AI へ送らずに止める (T15 / #1154。403 AI_CONSENT_REQUIRED)
    const aiConsentDenied = await requireAiConsent(supabase, user.id);
    if (aiConsentDenied) return aiConsentDenied;

    const rateLimitResult = await checkRateLimit(user.id, 'generation');
    if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

    // 必須の環境変数は、認証とレート制限のあと・既存の献立を消す前に確かめる。欠けていれば MissingEnvError で汎用の 500 にする (変数名はサーバーのログと構造化ログにだけ残す)。
    // (未ログインの呼び出しに、設定の不足を教えない。消したあとで気づくと、Edge Function を呼べず、
    //  献立を消して戻すだけの無駄な動きになる) (#1182)
    const { url: supabaseUrl, serviceRoleKey: supabaseServiceKey } = getSupabaseServiceConfig();
    // AI のキュー (weekly_menu_requests / meal_image_jobs) は利用者 (authenticated) から書けない (#1465)。本人の確認・同意のあとで、service role で書く
    const queueDb = getAiQueueWriter();

    // #1149 AI の利用回数の上限の判定と記録 (#1177)。AI へ送る処理の始まり (入力の検証・同意などの判定のあと、既存の献立を消して
    // 生成を始める前) に、操作 1 回につき 1 回数える。究極モードも 1 回。上限に達していれば、献立を消さずに 429 AI_DAILY_LIMIT
    // (消したあとで止めると献立が消えたままになるため、消す前に判定する。判定に失敗したときは止めない)
    const aiUsage = await consumeAiUsage(user.id, 'menu_generation');
    if (!aiUsage.allowed) return aiDailyLimitResponse(aiUsage);

    // 2. 今日以降の日付の既存食事を削除（Edge Functionが新規INSERTするため）
    const todayStr = todayLocal();
    // #1042: 削除前に旧値をスナップショットしておく（生成失敗時のロールバック用）。
    // 「先に削除→後で書き込み」を維持しつつ、失敗時に元の献立を復元できるようにする。
    const deletedMealsSnapshot: PlannedMealSnapshotRow[] = [];

    for (let i = 0; i < 7; i++) {
      const dateStr = addDays(startDate, i);
      // 今日以降の日付のみ対象
      if (dateStr >= todayStr) {
        const { data: existingDay } = await supabase
          .from('user_daily_meals')
          .select('id')
          .eq('user_id', user.id)
          .eq('day_date', dateStr)
          .maybeSingle();

        if (existingDay) {
          const { data: existingMeals } = await supabase
            .from('planned_meals')
            .select('*')
            .eq('daily_meal_id', existingDay.id);

          if (Array.isArray(existingMeals) && existingMeals.length > 0) {
            deletedMealsSnapshot.push(...(existingMeals as PlannedMealSnapshotRow[]));

            await Promise.all(
              existingMeals.map((meal) =>
                cancelPendingMealImageJobs({
                  supabase: queueDb,
                  userId: user.id,
                  plannedMealId: meal.id,
                  reason: 'weekly regeneration overwrite',
                }).catch((error) => {
                  console.warn('Failed to cancel meal image jobs before weekly reset:', error);
                }),
              ),
            );
          }

          // 既存の食事を削除
          await supabase
            .from('planned_meals')
            .delete()
            .eq('daily_meal_id', existingDay.id);
        }
      }
    }

    console.log(
      `📝 Cleared existing meals for week starting ${startDate}` +
        (deletedMealsSnapshot.length > 0 ? ` (snapshot: ${deletedMealsSnapshot.length} meals)` : ''),
    );

    // 3. リクエストをDBに保存（ステータス追跡用）
    const { data: requestData, error: insertError } = await queueDb
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: startDate,
        mode: 'weekly',
        status: 'processing',
        prompt: noteForAi || '',
        constraints,
        // #1042: 生成失敗時に削除済み献立を復元するためのスナップショット（監査用途も兼ねる）
        generated_data: deletedMealsSnapshot.length > 0 ? { snapshot: deletedMealsSnapshot } : null,
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('Failed to create request record:', insertError);
      // 生成を始める前に止まった (AI へは何も送っていない) ので、数えた 1 回を戻す (#1149)
      await refundAiUsage(user.id, 'menu_generation', aiUsage);
      throw new Error(`Failed to create request: ${insertError.message}`);
    }

    // 4. target_slotsを生成（7日間 × 3食 = 21スロット）
    const targetSlots: Array<{ date: string; mealType: string }> = [];
    const mealTypes = ['breakfast', 'lunch', 'dinner'];
    for (let i = 0; i < 7; i++) {
      const dateStr = addDays(startDate, i);
      for (const mealType of mealTypes) {
        targetSlots.push({ date: dateStr, mealType });
      }
    }

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

    // 5. Edge Function generate-menu-v4 をバックグラウンドで呼び出し
    const generator = useV5Wrapped ? callGenerateMenuV5WithRetry : callGenerateMenuV4WithRetry;
    const targetLabel = useV5Wrapped ? 'generate-menu-v5' : 'generate-menu-v4';
    console.log(`🚀 Calling Edge Function ${targetLabel}...`);

    // Edge Functionをバックグラウンドで呼び出し（waitUntilで接続を維持）
    const edgeFunctionPromise = generator({
      supabaseUrl,
      serviceRoleKey: supabaseServiceKey,
      payload: {
        userId: user.id,
        requestId: requestData.id,
        targetSlots,
        note: noteForAi,
        familySize,
        constraints,
      },
      extraHeaders: useV5Wrapped ? { apikey: supabaseServiceKey } : undefined,
    }).then(async (result) => {
      if (!result.ok) {
        console.error('❌ Edge Function error:', result.errorMessage);
        let errorMessage = result.errorMessage;

        // #1042: 生成失敗時、削除済みの旧献立をスナップショットから復元する。
        // 部分的に新しい献立が既に書き込まれているスロットは上書きしない（skip）。
        if (deletedMealsSnapshot.length > 0) {
          const restoreResult = await restorePlannedMealsSnapshot(supabase, deletedMealsSnapshot);
          console.log(
            `🔁 Restored meals after generation failure: restored=${restoreResult.restored} skipped=${restoreResult.skipped} failed=${restoreResult.failed}`,
          );
          // Edge Function が同意の判定で止めたときの文 (T15 / #1154) は、画面がこの文を見分けて同意画面へ案内するので、
          // 復元の件数を足さずにそのまま残す (件数はこのログに残っている)
          if (aiConsentReasonOfStoredError(result.errorMessage) === null) {
            errorMessage = `${result.errorMessage} (rollback: restored=${restoreResult.restored}, skipped=${restoreResult.skipped}, failed=${restoreResult.failed})`;
          }
        }

        await markWeeklyMenuRequestFailed({
          supabase: queueDb,
          requestId: requestData.id,
          errorMessage,
        });
        return;
      }
      console.log('✅ Edge Function completed successfully');
    });
    
    // waitUntilでバックグラウンド処理を維持（Vercel Functionsの終了後も実行を継続）
    waitUntil(edgeFunctionPromise);

    // 生成開始を即座に返す（プレースホルダーは作成しない、ポーリングで状態を監視）
    return NextResponse.json({ 
      status: 'processing',
      message: 'Generation started',
      requestId: requestData.id,
    });

  } catch (error: unknown) {
    // 500 の本文は汎用メッセージだけ。元のエラー (必須の環境変数が欠けていたときはその変数名も) は構造化ログに残す (#1172 / #1182)
    return internalError('POST /api/ai/menu/weekly/request', error, { userId: _userId, startDate: _startDate });
  }
}
