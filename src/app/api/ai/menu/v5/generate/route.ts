import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSeasonalIngredientsForRange } from '@/lib/seasonal-ingredients';
import { getEventsForRange } from '@/lib/seasonal-events';
import { callGenerateMenuV5WithRetry } from '@/lib/generate-menu-v5-retry';
import { markWeeklyMenuRequestFailed } from '@/lib/generate-menu-v4-retry';
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

    const { date, mealType, plannedMealId } = slot as any;
    if (!date || typeof date !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
      return { valid: false, slots: [], error: `targetSlots[${i}].date must be YYYY-MM-DD format` };
    }

    if (!mealType || !VALID_MEAL_TYPES.includes(mealType)) {
      return { valid: false, slots: [], error: `targetSlots[${i}].mealType must be one of: ${VALID_MEAL_TYPES.join(', ')}` };
    }

    if (plannedMealId !== undefined && plannedMealId !== null) {
      if (typeof plannedMealId !== 'string' || !/^[0-9a-f-]{36}$/i.test(plannedMealId)) {
        return { valid: false, slots: [], error: `targetSlots[${i}].plannedMealId must be a valid UUID` };
      }
    }

    const key = plannedMealId || `${date}:${mealType}`;
    if (seenKeys.has(key)) {
      return { valid: false, slots: [], error: `Duplicate slot at ${date}/${mealType}` };
    }
    seenKeys.add(key);

    validated.push({ date, mealType: mealType as MealType, plannedMealId: plannedMealId || undefined });
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

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getTodayStr(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

export const maxDuration = 300;

export async function POST(request: Request) {
  const supabase = await createClient();

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
        return NextResponse.json({ error: plannedMealsError.message }, { status: 500 });
      }

      const foundIds = new Set((plannedMeals || []).map((meal) => meal.id));
      const missing = plannedMealIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        // plannedMealId が見つからない場合はクリアして新規作成パスに進む
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
    const todayStr = getTodayStr();

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

    const { data: requestData, error: insertError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: startDate,
        mode: 'v5',
        status: 'processing',
        current_step: 1,
        prompt: body?.note || '',
        constraints,
        target_slots: fromTargetSlots(targetSlots),
        progress: {
          currentStep: 0,
          totalSteps: targetSlots.length,
          message: 'V5 generation started',
        },
      })
      .select('id')
      .single();

    if (insertError || !requestData?.id) {
      return NextResponse.json({ error: insertError?.message || 'Failed to create request' }, { status: 500 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceRoleKey = process.env.SERVICE_ROLE_JWT || process.env.SUPABASE_SERVICE_ROLE_KEY!;

    const invokeResult = await callGenerateMenuV5WithRetry({
      supabaseUrl,
      serviceRoleKey,
      payload: {
        userId: user.id,
        requestId: requestData.id,
        targetSlots,
        existingMenus,
        fridgeItems,
        userProfile,
        seasonalContext,
        constraints,
        note: body?.note || null,
        familySize: toOptionalInt(body?.familySize) ?? userProfile.family_size ?? 1,
        ultimateMode: Boolean(body?.ultimateMode),
      },
    });

    if (!invokeResult.ok) {
      await markWeeklyMenuRequestFailed({
        supabase,
        requestId: requestData.id,
        errorMessage: invokeResult.errorMessage,
      });
      return NextResponse.json({ error: invokeResult.errorMessage }, { status: 500 });
    }

    waitUntil(invokeResult.response.text().then(() => {}));

    return NextResponse.json({
      status: 'processing',
      message: 'V5 generation started',
      requestId: requestData.id,
      totalSlots: targetSlots.length,
      attempts: invokeResult.attempts,
    });
  } catch (error: any) {
    console.error('V5 API error', error);
    return NextResponse.json({ error: error.message || 'Unknown error' }, { status: 500 });
  }
}
