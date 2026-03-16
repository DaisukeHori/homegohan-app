import type { MealType } from "../_shared/meal-generator.ts";

type ExistingMenuLike = {
  date: string;
  mealType: MealType;
  dishName: string;
};

type TargetSlotLike = {
  date: string;
  mealType: MealType;
  plannedMealId?: string;
};

function getSlotKey(date: string, mealType: MealType): string {
  return `${date}:${mealType}`;
}

export function selectRecentMenusForVariety(params: {
  targetDate: string;
  existingMenus: ExistingMenuLike[];
  targetSlots?: TargetSlotLike[];
}): ExistingMenuLike[] {
  const excludedKeys = new Set(
    (params.targetSlots ?? [])
      .filter((slot) => Boolean(slot?.plannedMealId))
      .map((slot) => getSlotKey(slot.date, slot.mealType)),
  );

  return params.existingMenus.filter((menu) => {
    const dayDiff = Math.abs(
      (new Date(params.targetDate).getTime() - new Date(menu.date).getTime()) / (1000 * 60 * 60 * 24),
    );
    if (dayDiff > 7) return false;
    return !excludedKeys.has(getSlotKey(menu.date, menu.mealType));
  });
}
