import { createClient } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSeasonalIngredientsForRange } from '@/lib/seasonal-ingredients';
import { getEventsForRange } from '@/lib/seasonal-events';
import { callGenerateMenuV4WithRetry, markWeeklyMenuRequestFailed } from '@/lib/generate-menu-v4-retry';
import { callGenerateMenuV5WithRetry } from '@/lib/generate-menu-v5-retry';
import { getSupabaseServiceConfig } from '@/lib/env-required';
import { internalError } from '@/lib/api/errors';
import type {
  TargetSlot,
  ExistingMenuContext,
  FridgeItemContext,
  MenuGenerationConstraints,
  SeasonalContext,
  MealType
} from '@/types/domain';
import type { Tables } from '@homegohan/shared';
import { fromTargetSlots } from '@/lib/converter';
import { resolveExistingTargetSlots } from '@/lib/v4-target-slots';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { recordAiUsage } from '@/lib/plan/entitlements';
import { addDaysToDate, todayLocal } from '@/lib/date-utils';
import { requireAiConsent } from '@/lib/ai/consent-guard';

// Vercel Proプランでは最大300秒まで延長可能
export const maxDuration = 300;

// ===== Validation Helpers =====

const VALID_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'];

function validateTargetSlots(slots: unknown): { valid: boolean; slots: TargetSlot[]; error?: string } {
  if (!Array.isArray(slots) || slots.length === 0) {
    return { valid: false, slots: [], error: 'targetSlots must be a non-empty array' };
  }
  
  if (slots.length > 93) {
    return { valid: false, slots: [], error: 'targetSlots exceeds maximum of 93 (31 days × 3 meals)' };
  }
  
  const validated: TargetSlot[] = [];
  const seenKeys = new Set<string>();
  
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    
    if (!slot || typeof slot !== 'object') {
      return { valid: false, slots: [], error: `targetSlots[${i}] is not an object` };
    }
    
    const slotObj = slot as Record<string, unknown>;
    const date = slotObj['date'];
    const mealType = slotObj['mealType'];
    const plannedMealId = slotObj['plannedMealId'];

    // date validation
    if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { valid: false, slots: [], error: `targetSlots[${i}].date must be YYYY-MM-DD format` };
    }

    // mealType validation
    if (!mealType || typeof mealType !== 'string' || !VALID_MEAL_TYPES.includes(mealType as MealType)) {
      return { valid: false, slots: [], error: `targetSlots[${i}].mealType must be one of: ${VALID_MEAL_TYPES.join(', ')}` };
    }

    // plannedMealId validation (optional, but if present must be valid UUID)
    if (plannedMealId !== undefined && plannedMealId !== null) {
      if (typeof plannedMealId !== 'string' || !/^[0-9a-f-]{36}$/i.test(plannedMealId)) {
        return { valid: false, slots: [], error: `targetSlots[${i}].plannedMealId must be a valid UUID` };
      }
    }

    // Check for duplicates (date+mealType must be unique, unless plannedMealId differs)
    const key = (typeof plannedMealId === 'string' ? plannedMealId : null) || `${date}:${mealType}`;
    if (seenKeys.has(key)) {
      return { valid: false, slots: [], error: `Duplicate slot at ${date}/${mealType}` };
    }
    seenKeys.add(key);
    
    validated.push({
      date,
      mealType: mealType as MealType,
      plannedMealId: typeof plannedMealId === 'string' ? plannedMealId : undefined,
    });
  }
  
  return { valid: true, slots: validated };
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function toOptionalInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

// ===== Main API Handler =====

export async function POST(request: Request) {
  const supabase = await createClient();

  try {
    const body = await request.json().catch(() => ({}));
    
    // 1. Validate targetSlots (required)
    const { valid, slots: validatedTargetSlots, error: slotsError } = validateTargetSlots(body?.targetSlots);
    if (!valid) {
      return NextResponse.json({ error: slotsError }, { status: 400 });
    }
    
    // 2. ユーザー確認
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

    const targetSlots = body?.resolveExistingMeals
      ? await resolveExistingTargetSlots({
          supabase,
          userId: user.id,
          targetSlots: validatedTargetSlots,
        })
      : validatedTargetSlots;

    // 3. Calculate date range from targetSlots
    const dates = targetSlots.map(s => s.date).sort();
    const startDate = dates[0];
    const endDate = dates[dates.length - 1];
    
    // 4. plannedMealIdの所有権・整合性チェック
    const slotsWithPlannedId = targetSlots.filter(s => !!s.plannedMealId);
    if (slotsWithPlannedId.length > 0) {
      const plannedMealIds = Array.from(new Set(slotsWithPlannedId.map(s => s.plannedMealId!).filter(Boolean)));

      const { data: plannedMeals, error: plannedMealsError } = await supabase
        .from('planned_meals')
        .select(`
          id,
          meal_type,
          daily_meal_id,
          user_daily_meals!inner(
            day_date,
            user_id
          )
        `)
        .in('id', plannedMealIds)
        .eq('user_daily_meals.user_id', user.id);

      if (plannedMealsError) {
        return NextResponse.json({ error: plannedMealsError.message }, { status: 500 });
      }

      const foundIds = new Set((plannedMeals || []).map((m: any) => m.id));
      const missingIds = plannedMealIds.filter(id => !foundIds.has(id));
      if (missingIds.length > 0) {
        console.warn(`[v4/generate] ${missingIds.length} plannedMealId(s) not found, clearing: ${missingIds.join(', ')}`);
        for (const slot of slotsWithPlannedId) {
          if (slot.plannedMealId && missingIds.includes(slot.plannedMealId)) {
            slot.plannedMealId = undefined;
          }
        }
      }

      const byId = new Map<string, any>((plannedMeals || []).map((m: any) => [m.id, m]));
      for (const slot of slotsWithPlannedId) {
        if (!slot.plannedMealId) continue;
        const pm = byId.get(slot.plannedMealId);
        if (!pm) {
          slot.plannedMealId = undefined;
          continue;
        }
        const day = (pm.user_daily_meals as Pick<Tables<"user_daily_meals">, "day_date"> | null) ?? { day_date: '' };
        if (String(pm.meal_type) !== String(slot.mealType)) {
          return NextResponse.json({ error: 'plannedMealId mealType mismatch' }, { status: 400 });
        }
        if (String(day.day_date) !== String(slot.date)) {
          return NextResponse.json({ error: 'plannedMealId date mismatch' }, { status: 400 });
        }
      }
    }

    // 5-7. 並列でデータ取得（パフォーマンス最適化）
    const contextStartDate = addDays(startDate, -7); // 7 days before
    const contextEndDate = addDays(endDate, 7); // 7 days after
    const todayStr = todayLocal();

    // 並列実行: 既存メニュー、冷蔵庫、ユーザープロフィール
    const [existingMealsResult, pantryResult, profileResult] = await Promise.all([
      // 5. Collect existing menus (context for LLM)
      supabase
        .from('user_daily_meals')
        .select(`
          day_date,
          planned_meals (
            id,
            meal_type,
            dish_name,
            is_completed,
            mode
          )
        `)
        .eq('user_id', user.id)
        .gte('day_date', contextStartDate)
        .lte('day_date', contextEndDate),
      
      // 6. Collect fridge items
      supabase
        .from('pantry_items')
        .select('name, amount, expiration_date')
        .eq('user_id', user.id)
        .gte('expiration_date', todayStr)
        .order('expiration_date', { ascending: true }),
      
      // 7. Collect user profile
      supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single(),
    ]);

    // 既存メニューの処理
    const existingMealsData = existingMealsResult.data;
    const existingMenus: ExistingMenuContext[] = [];
    
    if (existingMealsData) {
      for (const day of existingMealsData) {
        const dayDate = day.day_date as string;
        const isPast = dayDate < todayStr;
        const meals = (day.planned_meals as Pick<Tables<"planned_meals">, "id" | "meal_type" | "dish_name" | "is_completed" | "mode">[]) || [];
        
        for (const meal of meals) {
          if (meal.dish_name) {
            const mode = String(meal.mode || '');
            existingMenus.push({
              date: dayDate,
              mealType: meal.meal_type as MealType,
              dishName: meal.dish_name,
              status: meal.is_completed ? 'completed' : 
                      mode === 'skip' ? 'skip' :
                      mode.startsWith('ai') ? 'ai' : 'manual',
              isPast,
            });
          }
        }
      }
    }

    // 冷蔵庫情報の処理
    const pantryData = pantryResult.data;
    const fridgeItems: FridgeItemContext[] = (pantryData || []).map(item => ({
      name: item.name,
      quantity: item.amount || undefined,
      expirationDate: item.expiration_date || undefined,
    }));

    // ユーザープロフィールの処理
    const profileData = profileResult.data;
    const userProfile = profileData || {};
    const familySize = toOptionalInt(body?.familySize) ?? userProfile.family_size ?? 1;

    // 8. Build seasonal context
    const seasonalIngredients = getSeasonalIngredientsForRange(startDate, endDate);
    const seasonalEvents = getEventsForRange(startDate, endDate);
    // startDate は YYYY-MM-DD の暦日。new Date(startDate) は UTC の 0 時なので、月も UTC で読む (#1433。getMonth はローカル時刻で、実行環境のタイムゾーンで変わる)
    const month = new Date(startDate).getUTCMonth() + 1;
    
    const seasonalContext: SeasonalContext = {
      month,
      seasonalIngredients,
      events: seasonalEvents,
    };

    // 9. Parse constraints
    const rawConstraints = body?.constraints as unknown;
    const constraints: MenuGenerationConstraints = isPlainObject(rawConstraints) 
      ? rawConstraints as MenuGenerationConstraints 
      : {};

    // #1148: エンジンの切り替えは feature_flags (運営画面で切り替える) を見る
    const useV5Direct = await isFeatureEnabled('menu_generation_v5_direct', user.id);
    const engine = useV5Direct ? 'v5' : 'v4';

    // #1177 AI 利用回数の記録。AI へ送る直前 (入力の検証・同意などの判定のあと) に、操作 1 回につき 1 回記録する
    // (記録に失敗しても止めない)
    await recordAiUsage(user.id, 'menu_generation');

    // 10. Create request record
    const { data: requestData, error: insertError } = await queueDb
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: startDate,
        mode: engine,
        status: 'processing',
        current_step: 1,
        prompt: body?.note || '',
        constraints: constraints,
        target_slots: fromTargetSlots(targetSlots),
        progress: {
          currentStep: 0,
          totalSteps: targetSlots.length,
          message: '献立生成を開始しています...',
        },
      })
      .select('id')
      .single();

    if (insertError) {
      console.error('Failed to create request record:', insertError);
      throw new Error(`Failed to create request: ${insertError.message}`);
    }

    // 11. Call Edge Function in background
    const generator = useV5Direct ? callGenerateMenuV5WithRetry : callGenerateMenuV4WithRetry;
    const targetLabel = useV5Direct ? 'generate-menu-v5' : 'generate-menu-v4';

    console.log(`🚀 Calling Edge Function ${targetLabel}...`);
    
    const edgeFunctionPromise = generator({
      supabaseUrl,
      serviceRoleKey: supabaseServiceKey,
      payload: {
        userId: user.id,
        requestId: requestData.id,
        targetSlots,
        existingMenus,
        fridgeItems,
        userProfile,
        seasonalContext,
        constraints,
        note: body?.note,
        familySize,
        ultimateMode: body?.ultimateMode ?? false,
      },
    }).then(async (result) => {
      if (!result.ok) {
        console.error('❌ Edge Function error:', result.errorMessage);
        await markWeeklyMenuRequestFailed({
          supabase: queueDb,
          requestId: requestData.id,
          errorMessage: result.errorMessage,
        });
        return;
      }
      console.log('✅ Edge Function completed successfully');
    });
    
    // Keep the background process alive
    waitUntil(edgeFunctionPromise);

    // 12. Return immediately
    return NextResponse.json({ 
      status: 'processing',
      message: `${engine.toUpperCase()} generation started`,
      requestId: requestData.id,
      totalSlots: targetSlots.length,
    });

  } catch (error: unknown) {
    // 500 の本文は汎用メッセージだけ。元のエラー (必須の環境変数が欠けていたときはその変数名も) は構造化ログに残す (#1172 / #1182)
    return internalError('POST /api/ai/menu/v4/generate', error);
  }
}

// ===== Helper Functions =====

// 暦日 (YYYY-MM-DD) を days 日ずらす。暦の計算だけで行い、実行環境のタイムゾーンに左右されない (#1433。
// 以前の new Date(dateStr) + setDate (ローカル時刻) + toISOString (UTC) は、実行環境のタイムゾーンで結果が変わった)
function addDays(dateStr: string, days: number): string {
  return addDaysToDate(dateStr, days);
}
