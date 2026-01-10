export type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "midnight_snack";

export type TargetSlot = {
  date: string; // YYYY-MM-DD
  mealType: MealType;
  plannedMealId?: string;
};

export const MEAL_TYPE_ORDER: Record<MealType, number> = {
  breakfast: 10,
  lunch: 20,
  dinner: 30,
  snack: 40,
  midnight_snack: 50,
};

export const DEFAULT_STEP1_DAY_BATCH = 6;
export const DEFAULT_STEP2_FIXES_PER_RUN = 3;
export const DEFAULT_STEP2_FIXES_PER_WEEK = 2;
export const DEFAULT_STEP2_MAX_FIXES_CAP = 12;
export const DEFAULT_STEP3_SLOT_BATCH = 15;

// Ultimate Mode (Steps 4-6)
export const DEFAULT_STEP4_DAY_BATCH = 5;       // 5日/実行（フィードバック分析）
export const DEFAULT_STEP5_DAY_BATCH = 3;       // 3日/実行（再生成）
export const DEFAULT_STEP6_SLOT_BATCH = 15;     // Step 3と同じ

export function getSlotKey(date: string, mealType: MealType): string {
  return `${date}:${mealType}`;
}

export function normalizeTargetSlots(dbSlots: any[]): TargetSlot[] {
  if (!Array.isArray(dbSlots)) return [];
  return dbSlots
    .map((s: any) => ({
      date: String(s?.date ?? "").slice(0, 10),
      mealType: String(s?.meal_type ?? s?.mealType ?? "") as MealType,
      plannedMealId: s?.planned_meal_id ?? s?.plannedMealId ?? undefined,
    }))
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && Boolean(s.mealType));
}

export function uniqDatesFromSlots(slots: TargetSlot[]): string[] {
  const set = new Set<string>();
  for (const s of slots) set.add(s.date);
  return Array.from(set).sort();
}

export function sortTargetSlots(slots: TargetSlot[]): TargetSlot[] {
  const order = (mt: MealType) => MEAL_TYPE_ORDER[mt] ?? 999;
  return [...slots].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return order(a.mealType) - order(b.mealType);
  });
}

export function countGeneratedTargetSlots(
  targetSlots: TargetSlot[],
  generatedMeals: Record<string, unknown>,
): number {
  let n = 0;
  for (const s of targetSlots) {
    const key = getSlotKey(s.date, s.mealType);
    if (generatedMeals[key]) n++;
  }
  return n;
}

export function computeWeeksFromDays(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return 1;
  return Math.max(1, Math.ceil(days / 7));
}

/**
 * V3の「最大2件修正（週7日）」をV4の任意期間にスケールさせる。
 * 例: 31日 -> ceil(31/7)=5週 -> 10件（cap=12）
 */
export function computeMaxFixesForRange(params: {
  days: number;
  issuesCount: number;
  fixesPerWeek?: number;
  cap?: number;
}): number {
  const weeks = computeWeeksFromDays(params.days);
  const fixesPerWeek = params.fixesPerWeek ?? DEFAULT_STEP2_FIXES_PER_WEEK;
  const cap = params.cap ?? DEFAULT_STEP2_MAX_FIXES_CAP;
  const budget = weeks * fixesPerWeek;
  const issuesCount = Math.max(0, Math.trunc(params.issuesCount ?? 0));
  return Math.min(issuesCount, budget, cap);
}

export function computeNextCursor(params: { cursor: number; batchSize: number; length: number }): number {
  const cursor = Math.max(0, Math.trunc(params.cursor ?? 0));
  const batchSize = Math.max(1, Math.trunc(params.batchSize ?? 1));
  const length = Math.max(0, Math.trunc(params.length ?? 0));
  return Math.min(cursor + batchSize, length);
}

