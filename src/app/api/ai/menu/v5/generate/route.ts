import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { getSeasonalIngredientsForRange } from '@/lib/seasonal-ingredients';
import { getEventsForRange } from '@/lib/seasonal-events';
import type {
  TargetSlot,
  ExistingMenuContext,
  FridgeItemContext,
  MenuGenerationConstraints,
  SeasonalContext,
  MealType,
} from '@/types/domain';
import { fromTargetSlots } from '@/lib/converter';
import { resolveExistingTargetSlots } from '@/lib/v4-target-slots';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { recordAiUsage } from '@/lib/plan/entitlements';
import { addDaysToDate, todayLocal } from '@/lib/date-utils';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { internalError } from '@/lib/api/errors';

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

    if (!date || typeof date !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
      return { valid: false, slots: [], error: `targetSlots[${i}].date must be YYYY-MM-DD format` };
    }

    if (!mealType || typeof mealType !== 'string' || !VALID_MEAL_TYPES.includes(mealType as MealType)) {
      return { valid: false, slots: [], error: `targetSlots[${i}].mealType must be one of: ${VALID_MEAL_TYPES.join(', ')}` };
    }

    if (plannedMealId !== undefined && plannedMealId !== null) {
      if (typeof plannedMealId !== 'string' || !/^[0-9a-f-]{36}$/i.test(plannedMealId)) {
        return { valid: false, slots: [], error: `targetSlots[${i}].plannedMealId must be a valid UUID` };
      }
    }

    const key = (typeof plannedMealId === 'string' ? plannedMealId : null) || `${date}:${mealType}`;
    if (seenKeys.has(key)) {
      return { valid: false, slots: [], error: `Duplicate slot at ${date}/${mealType}` };
    }
    seenKeys.add(key);

    validated.push({ date, mealType: mealType as MealType, plannedMealId: typeof plannedMealId === 'string' ? plannedMealId : undefined });
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

// 暦日 (YYYY-MM-DD) を days 日ずらす (#1433。v4 のルートと同じ関数にそろえる)
function addDays(dateStr: string, days: number): string {
  return addDaysToDate(dateStr, days);
}

export const maxDuration = 30;

export async function POST(request: Request) {
  const supabase = await createClient();
  let _userId: string | undefined;

  try {
    const body = await request.json().catch(() => ({}));
    const { valid, slots: validatedSlots, error: validationError } = validateTargetSlots(body?.targetSlots);
    if (!valid) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    _userId = user.id;

    // 外国の AI 事業者への提供の同意が無ければ、生成をキューに積まずに止める (T15 / #1154。403 AI_CONSENT_REQUIRED。cron の側でも止める)
    const aiConsentDenied = await requireAiConsent(supabase, user.id);
    if (aiConsentDenied) return aiConsentDenied;

    const rateLimitResult = await checkRateLimit(user.id, 'generation');
    if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

    const targetSlots = body?.resolveExistingMeals
      ? await resolveExistingTargetSlots({
          supabase,
          userId: user.id,
          targetSlots: validatedSlots,
        })
      : validatedSlots;

    const dates = targetSlots.map((slot) => slot.date).sort();
    const startDate = dates[0];
    const endDate = dates[dates.length - 1];

    const plannedSlots = targetSlots.filter((slot) => slot.plannedMealId);
    if (plannedSlots.length > 0) {
      const plannedMealIds = Array.from(new Set(plannedSlots.map((slot) => slot.plannedMealId!).filter(Boolean)));
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
        return internalError('POST /api/ai/menu/v5/generate', plannedMealsError, { userId: user.id });
      }

      const foundIds = new Set((plannedMeals || []).map((meal) => meal.id));
      const missing = plannedMealIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        console.warn(`[v5/generate] ${missing.length} plannedMealId(s) not found, clearing: ${missing.join(', ')}`);
        for (const slot of plannedSlots) {
          if (slot.plannedMealId && missing.includes(slot.plannedMealId)) {
            slot.plannedMealId = undefined;
          }
        }
      }

      const byId = new Map((plannedMeals || []).map((meal) => [meal.id, meal]));
      for (const slot of plannedSlots) {
        if (!slot.plannedMealId) continue;
        const stored = byId.get(slot.plannedMealId);
        if (!stored) {
          slot.plannedMealId = undefined;
          continue;
        }
        const day = Array.isArray(stored.user_daily_meals)
          ? stored.user_daily_meals[0] || {}
          : stored.user_daily_meals || {};
        if (String(stored.meal_type) !== slot.mealType) {
          return NextResponse.json({ error: 'plannedMealId mealType mismatch' }, { status: 400 });
        }
        if (String(day.day_date) !== slot.date) {
          return NextResponse.json({ error: 'plannedMealId date mismatch' }, { status: 400 });
        }
      }
    }

    const contextStartDate = addDays(startDate, -7);
    const contextEndDate = addDays(endDate, 7);
    const todayStr = todayLocal();

    const [existingMealsResult, pantryResult, profileResult] = await Promise.all([
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
      supabase
        .from('pantry_items')
        .select('name, amount, expiration_date')
        .eq('user_id', user.id)
        .gte('expiration_date', todayStr)
        .order('expiration_date', { ascending: true }),
      supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single(),
    ]);

    const existingMeals = existingMealsResult.data || [];
    const existingMenus: ExistingMenuContext[] = [];
    const fridgeItems: FridgeItemContext[] = (pantryResult.data || []).map((item) => ({
      name: item.name,
      quantity: item.amount || undefined,
      expirationDate: item.expiration_date || undefined,
    }));
    const userProfile = profileResult.data || {};

    for (const day of existingMeals) {
      const dayDate = day.day_date;
      const meals = day.planned_meals || [];
      for (const meal of meals) {
        if (!meal.dish_name) continue;
        const status = meal.is_completed ? 'completed' : meal.mode?.startsWith('ai') ? 'ai' : 'manual';
        existingMenus.push({
          date: dayDate,
          mealType: meal.meal_type,
          dishName: meal.dish_name,
          status,
          isPast: dayDate < todayStr,
        });
      }
    }

    const seasonalContext: SeasonalContext = {
      month: new Date(startDate).getUTCMonth() + 1,
      seasonalIngredients: getSeasonalIngredientsForRange(startDate, endDate),
      events: getEventsForRange(startDate, endDate),
    };

    const constraints: MenuGenerationConstraints = isPlainObject(body?.constraints)
      ? (body.constraints as MenuGenerationConstraints)
      : {};

    // #1177 AI 利用回数の記録。AI へ送る直前 (入力の検証・同意などの判定のあと) に、操作 1 回につき 1 回記録する
    // (記録に失敗しても止めない)。
    // ここでキューに積み、AI へ送るのは cron (process-menu-queue) なので、送る側では記録しない。
    // ただしキューの行 (weekly_menu_requests) は利用者が直接書けるので、この route を通らない行は記録されない
    // (既知の穴。閉じるには書き込みを service role だけにする。tests/ai-usage-contract.test.ts の USER_WRITABLE_AI_QUEUES)
    await recordAiUsage(user.id, 'menu_generation');

    // バックグラウンドジョブとしてキューに追加し、即座に requestId を返す
    const params = {
      userId: user.id,
      requestId: null as string | null, // INSERT 後に取得
      targetSlots,
      existingMenus,
      fridgeItems,
      userProfile,
      seasonalContext,
      constraints,
      note: body?.note || null,
      familySize: toOptionalInt(body?.familySize) ?? userProfile.family_size ?? 1,
      ultimateMode: Boolean(body?.ultimateMode),
    };

    const { data: requestData, error: insertError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: startDate,
        mode: 'v5',
        status: 'queued',
        current_step: 1,
        prompt: body?.note || '',
        constraints,
        target_slots: fromTargetSlots(targetSlots),
        progress: {
          currentStep: 0,
          totalSteps: targetSlots.length,
          message: '生成キューに追加しました',
        },
        generated_data: { ...params, requestId: undefined },
      })
      .select('id')
      .single();

    if (insertError || !requestData?.id) {
      return internalError('POST /api/ai/menu/v5/generate', insertError, { userId: user.id });
    }

    // generated_data に requestId を埋め込む
    await supabase
      .from('weekly_menu_requests')
      .update({ generated_data: { ...params, requestId: requestData.id } })
      .eq('id', requestData.id);

    return NextResponse.json(
      {
        status: 'queued',
        message: '献立生成をキューに追加しました',
        requestId: requestData.id,
        totalSlots: targetSlots.length,
      },
      { status: 202 },
    );
  } catch (error: any) {
    return internalError('POST /api/ai/menu/v5/generate', error, { userId: _userId });
  }
}
