import { createClient } from '@/lib/supabase/server';
import { loadFeatureFlags } from '@/lib/menu-generation-feature-flags';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSeasonalIngredientsForRange } from '@/lib/seasonal-ingredients';
import { getEventsForRange } from '@/lib/seasonal-events';
import { callGenerateMenuV4WithRetry, markWeeklyMenuRequestFailed } from '@/lib/generate-menu-v4-retry';
import { callGenerateMenuV5WithRetry } from '@/lib/generate-menu-v5-retry';
import type { 
  TargetSlot, 
  ExistingMenuContext, 
  FridgeItemContext,
  MenuGenerationConstraints,
  SeasonalContext,
  MealType
} from '@/types/domain';
import { fromTargetSlots } from '@/lib/converter';
import { resolveExistingTargetSlots } from '@/lib/v4-target-slots';

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
    
    const { date, mealType, plannedMealId } = slot as any;
    
    // date validation
    if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { valid: false, slots: [], error: `targetSlots[${i}].date must be YYYY-MM-DD format` };
    }
    
    // mealType validation
    if (!mealType || !VALID_MEAL_TYPES.includes(mealType)) {
      return { valid: false, slots: [], error: `targetSlots[${i}].mealType must be one of: ${VALID_MEAL_TYPES.join(', ')}` };
    }
    
    // plannedMealId validation (optional, but if present must be valid UUID)
    if (plannedMealId !== undefined && plannedMealId !== null) {
      if (typeof plannedMealId !== 'string' || !/^[0-9a-f-]{36}$/i.test(plannedMealId)) {
        return { valid: false, slots: [], error: `targetSlots[${i}].plannedMealId must be a valid UUID` };
      }
    }
    
    // Check for duplicates (date+mealType must be unique, unless plannedMealId differs)
    const key = plannedMealId || `${date}:${mealType}`;
    if (seenKeys.has(key)) {
      return { valid: false, slots: [], error: `Duplicate slot at ${date}/${mealType}` };
    }
    seenKeys.add(key);
    
    validated.push({
      date,
      mealType: mealType as MealType,
      plannedMealId: plannedMealId || undefined,
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
        const day = (pm.user_daily_meals as any) || {};
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
    const todayStr = getTodayStr();

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
        const meals = (day.planned_meals as any[]) || [];
        
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
    const month = new Date(startDate).getMonth() + 1;
    
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

    const featureFlags = await loadFeatureFlags(supabase);
    const useV5Direct = Boolean(featureFlags.menu_generation_v5_direct);
    const engine = useV5Direct ? 'v5' : 'v4';

    // 10. Create request record
    const { data: requestData, error: insertError } = await supabase
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
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceKey = process.env.SERVICE_ROLE_JWT || process.env.SUPABASE_SERVICE_ROLE_KEY!;
    
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
          supabase,
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

  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// ===== Helper Functions =====

function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}

function getTodayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
