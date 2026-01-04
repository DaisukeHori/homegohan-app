import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSeasonalIngredientsForRange } from '@/lib/seasonal-ingredients';
import { getEventsForRange } from '@/lib/seasonal-events';
import type { 
  TargetSlot, 
  ExistingMenuContext, 
  FridgeItemContext,
  MenuGenerationConstraints,
  SeasonalContext,
  MealType
} from '@/types/domain';
import { fromTargetSlots } from '@/lib/converter';

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
    const { valid, slots: targetSlots, error: slotsError } = validateTargetSlots(body?.targetSlots);
    if (!valid) {
      return NextResponse.json({ error: slotsError }, { status: 400 });
    }
    
    // 2. ユーザー確認
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 3. Calculate date range from targetSlots
    const dates = targetSlots.map(s => s.date).sort();
    const startDate = dates[0];
    const endDate = dates[dates.length - 1];
    
    // 4. meal_planを取得または作成
    let { data: mealPlan, error: planError } = await supabase
      .from('meal_plans')
      .select('id')
      .eq('user_id', user.id)
      .lte('start_date', startDate)
      .gte('end_date', endDate)
      .eq('is_active', true)
      .maybeSingle();

    if (planError && planError.code !== 'PGRST116') {
      throw new Error(`Failed to fetch meal_plan: ${planError.message}`);
    }

    if (!mealPlan) {
      // Create new meal_plan covering the date range
      const ws = new Date(startDate);
      const title = `${ws.getMonth() + 1}月${ws.getDate()}日〜の献立`;
      const { data: newPlan, error: createError } = await supabase
        .from('meal_plans')
        .insert({
          user_id: user.id,
          title,
          start_date: startDate,
          end_date: endDate,
          status: 'active',
          is_active: true,
        })
        .select('id')
        .single();

      if (createError) throw new Error(`Failed to create meal_plan: ${createError.message}`);
      mealPlan = newPlan;
    }

    // 4.5 plannedMealId の所有権・整合性チェック（Edge Functionはサービスロールで更新するため必須）
    const slotsWithPlannedId = targetSlots.filter(s => !!s.plannedMealId);
    if (slotsWithPlannedId.length > 0) {
      const plannedMealIds = Array.from(new Set(slotsWithPlannedId.map(s => s.plannedMealId!).filter(Boolean)));

      const { data: plannedMeals, error: plannedMealsError } = await supabase
        .from('planned_meals')
        .select(`
          id,
          meal_type,
          meal_plan_day_id,
          meal_plan_days!inner(
            day_date,
            meal_plan_id,
            meal_plans!inner(user_id)
          )
        `)
        .in('id', plannedMealIds)
        .eq('meal_plan_days.meal_plans.user_id', user.id);

      if (plannedMealsError) {
        return NextResponse.json({ error: plannedMealsError.message }, { status: 500 });
      }

      const foundIds = new Set((plannedMeals || []).map((m: any) => m.id));
      const missingIds = plannedMealIds.filter(id => !foundIds.has(id));
      if (missingIds.length > 0) {
        return NextResponse.json({ error: 'Meal not found or unauthorized' }, { status: 404 });
      }

      const byId = new Map<string, any>((plannedMeals || []).map((m: any) => [m.id, m]));
      for (const slot of slotsWithPlannedId) {
        const pm = byId.get(slot.plannedMealId!);
        if (!pm) {
          return NextResponse.json({ error: 'Meal not found or unauthorized' }, { status: 404 });
        }
        const day = (pm.meal_plan_days as any) || {};
        if (day.meal_plan_id !== mealPlan.id) {
          return NextResponse.json({ error: 'plannedMealId does not belong to the current meal plan' }, { status: 400 });
        }
        if (String(pm.meal_type) !== String(slot.mealType)) {
          return NextResponse.json({ error: 'plannedMealId mealType mismatch' }, { status: 400 });
        }
        if (String(day.day_date) !== String(slot.date)) {
          return NextResponse.json({ error: 'plannedMealId date mismatch' }, { status: 400 });
        }
      }
    }

    // 5. Collect existing menus (context for LLM)
    const contextStartDate = addDays(startDate, -7); // 7 days before
    const contextEndDate = addDays(endDate, 7); // 7 days after
    
    const { data: existingMealsData } = await supabase
      .from('meal_plan_days')
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
      .eq('meal_plan_id', mealPlan.id)
      .gte('day_date', contextStartDate)
      .lte('day_date', contextEndDate);

    const todayStr = getTodayStr();
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

    // 6. Collect fridge items
    const { data: pantryData } = await supabase
      .from('pantry_items')
      .select('name, amount, expiration_date')
      .eq('user_id', user.id)
      .gte('expiration_date', todayStr)
      .order('expiration_date', { ascending: true });

    const fridgeItems: FridgeItemContext[] = (pantryData || []).map(item => ({
      name: item.name,
      quantity: item.amount || undefined,
      expirationDate: item.expiration_date || undefined,
    }));

    // 7. Collect user profile
    const { data: profileData } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single();

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

    // 10. Create request record
    const { data: requestData, error: insertError } = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: startDate,
        mode: 'v4',
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
    
    console.log('🚀 Calling Edge Function generate-menu-v4...');
    
    const edgeFunctionPromise = fetch(`${supabaseUrl}/functions/v1/generate-menu-v4`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        userId: user.id,
        mealPlanId: mealPlan.id,
        requestId: requestData.id,
        targetSlots,
        existingMenus,
        fridgeItems,
        userProfile,
        seasonalContext,
        constraints,
        note: body?.note,
        familySize,
      }),
    }).then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => 'Unknown error');
        console.error('❌ Edge Function error:', res.status, text);
        await supabase
          .from('weekly_menu_requests')
          .update({ 
            status: 'failed', 
            error_message: `Edge Function error: ${res.status}`,
            updated_at: new Date().toISOString() 
          })
          .eq('id', requestData.id);
      } else {
        console.log('✅ Edge Function completed successfully');
      }
    }).catch(async (err) => {
      console.error('❌ Edge Function call error:', err.message);
      await supabase
        .from('weekly_menu_requests')
        .update({ 
          status: 'failed', 
          error_message: err.message,
          updated_at: new Date().toISOString() 
        })
        .eq('id', requestData.id);
    });
    
    // Keep the background process alive
    waitUntil(edgeFunctionPromise);

    // 12. Return immediately
    return NextResponse.json({ 
      status: 'processing',
      message: 'V4 generation started',
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
