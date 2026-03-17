import type { SupabaseClient } from '@supabase/supabase-js';

import type { MealType, TargetSlot } from '@/types/domain';

type ExistingMealSlot = {
  date: string;
  mealType: MealType;
  plannedMealId: string;
};

function getSlotKey(date: string, mealType: MealType): string {
  return `${date}:${mealType}`;
}

export function mergeTargetSlotsWithExistingMeals(
  targetSlots: TargetSlot[],
  existingMeals: ExistingMealSlot[],
): TargetSlot[] {
  const existingMealIds = new Map(
    existingMeals.map((meal) => [getSlotKey(meal.date, meal.mealType), meal.plannedMealId]),
  );

  return targetSlots.map((slot) => {
    if (slot.plannedMealId) return slot;

    const plannedMealId = existingMealIds.get(getSlotKey(slot.date, slot.mealType));
    return plannedMealId ? { ...slot, plannedMealId } : slot;
  });
}

export async function resolveExistingTargetSlots(params: {
  supabase: SupabaseClient;
  userId: string;
  targetSlots: TargetSlot[];
}): Promise<TargetSlot[]> {
  const { supabase, userId, targetSlots } = params;

  const unresolvedSlots = targetSlots.filter((slot) => !slot.plannedMealId);
  if (unresolvedSlots.length === 0) {
    return targetSlots;
  }

  const dates = Array.from(new Set(unresolvedSlots.map((slot) => slot.date))).sort();
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  const { data, error } = await supabase
    .from('user_daily_meals')
    .select(`
      day_date,
      planned_meals (
        id,
        meal_type
      )
    `)
    .eq('user_id', userId)
    .gte('day_date', startDate)
    .lte('day_date', endDate);

  if (error) {
    throw new Error(`Failed to resolve existing target slots: ${error.message}`);
  }

  const existingMeals: ExistingMealSlot[] = (data ?? []).flatMap((day: any) => {
    const dayDate = String(day?.day_date ?? '').slice(0, 10);
    const meals = Array.isArray(day?.planned_meals) ? day.planned_meals : [];
    return meals
      .filter((meal: any) => typeof meal?.id === 'string' && typeof meal?.meal_type === 'string')
      .map((meal: any) => ({
        date: dayDate,
        mealType: meal.meal_type as MealType,
        plannedMealId: meal.id as string,
      }));
  });

  return mergeTargetSlotsWithExistingMeals(targetSlots, existingMeals);
}
