import { createClient } from '@/lib/supabase/server';
import { loadFeatureFlags } from '@/lib/menu-generation-feature-flags';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { callGenerateMenuV4WithRetry, markWeeklyMenuRequestFailed } from '@/lib/generate-menu-v4-retry';
import { callGenerateMenuV5WithRetry } from '@/lib/generate-menu-v5-retry';
import { cancelPendingMealImageJobs } from '../../../../../../lib/meal-image-jobs';

// Vercel Proプランでは最大300秒まで延長可能
export const maxDuration = 300;

// 日付を1日進める
function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}

// 今日の日付を取得（ローカルタイムゾーン）
function getTodayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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

  try {
    const body = await request.json().catch(() => ({}));
    const startDate = body?.startDate;

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

    // 1. ユーザー確認
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. 今日以降の日付の既存食事を削除（Edge Functionが新規INSERTするため）
    const todayStr = getTodayStr();

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
            .select('id')
            .eq('daily_meal_id', existingDay.id);

          if (Array.isArray(existingMeals) && existingMeals.length > 0) {
            await Promise.all(
              existingMeals.map((meal) =>
                cancelPendingMealImageJobs({
                  supabase,
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
    
    console.log(`📝 Cleared existing meals for week starting ${startDate}`);

    // 3. リクエストをDBに保存（ステータス追跡用）
    const { data: requestData, error: insertError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: startDate,
        mode: 'weekly',
        status: 'processing',
        prompt: noteForAi || '',
        constraints,
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('Failed to create request record:', insertError);
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

    // 5. Edge Function generate-menu-v4 をバックグラウンドで呼び出し
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceKey = process.env.SERVICE_ROLE_JWT || process.env.SUPABASE_SERVICE_ROLE_KEY!;
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
        await markWeeklyMenuRequestFailed({
          supabase,
          requestId: requestData.id,
          errorMessage: result.errorMessage,
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

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
