export type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "midnight_snack";

export type TargetSlot = {
  date: string; // YYYY-MM-DD
  mealType: MealType;
  plannedMealId?: string;
};

export type SaveMealOutcome = "inserted" | "updated" | "skipped_existing";

export type SaveMealResult = {
  outcome: SaveMealOutcome;
  plannedMealId?: string | null;
  reason?: string;
  qualityIssues?: PostNutritionIssue[];
};

export type PostNutritionIssueCode =
  | "breakfast_calorie_low"
  | "breakfast_calorie_high"
  | "lunch_calorie_low"
  | "lunch_calorie_high"
  | "dinner_calorie_low"
  | "dinner_calorie_high"
  | "meal_sodium_high";

export type PostNutritionIssue = {
  key: string;
  code: PostNutritionIssueCode;
  issue: string;
  suggestion: string;
};

const POST_NUTRITION_MEAL_LIMITS: Partial<Record<MealType, { minCalories?: number; maxCalories?: number; maxSodiumG?: number }>> = {
  breakfast: { minCalories: 250, maxCalories: 700, maxSodiumG: 4.5 },
  lunch: { minCalories: 400, maxCalories: 950, maxSodiumG: 6.0 },
  dinner: { minCalories: 400, maxCalories: 950, maxSodiumG: 6.0 },
};

export function derivePostNutritionIssues(params: {
  date: string;
  mealType: MealType;
  caloriesKcal?: number | null;
  sodiumG?: number | null;
}): PostNutritionIssue[] {
  const { date, mealType } = params;
  const key = getSlotKey(date, mealType);
  const limits = POST_NUTRITION_MEAL_LIMITS[mealType];
  if (!limits) return [];

  const calories = Number(params.caloriesKcal);
  const sodium = Number(params.sodiumG);
  const issues: PostNutritionIssue[] = [];

  if (Number.isFinite(calories) && limits.minCalories != null && calories < limits.minCalories) {
    issues.push({
      key,
      code: `${mealType}_calorie_low` as PostNutritionIssueCode,
      issue: `${mealType === "breakfast" ? "朝食" : mealType === "lunch" ? "昼食" : "夕食"}の総カロリーが低すぎます（${Math.round(calories)}kcal）。`,
      suggestion: mealType === "breakfast"
        ? "主食を 1 つ、主たんぱくを 1 つ、補助 1 品を揃え、250kcal を下回らない構成にしてください。"
        : "主食か主菜のボリュームを少し上げ、400kcal を下回らない構成にしてください。",
    });
  }

  if (Number.isFinite(calories) && limits.maxCalories != null && calories > limits.maxCalories) {
    issues.push({
      key,
      code: `${mealType}_calorie_high` as PostNutritionIssueCode,
      issue: `${mealType === "breakfast" ? "朝食" : mealType === "lunch" ? "昼食" : "夕食"}の総カロリーが高すぎます（${Math.round(calories)}kcal）。`,
      suggestion: mealType === "breakfast"
        ? "朝食は 700kcal 以下に収め、重い主食や副菜を 1 品減らしてください。"
        : "主食の重複や品数過多を避け、950kcal を超えない構成にしてください。",
    });
  }

  if (Number.isFinite(sodium) && limits.maxSodiumG != null && sodium > limits.maxSodiumG) {
    issues.push({
      key,
      code: "meal_sodium_high",
      issue: `${mealType === "breakfast" ? "朝食" : mealType === "lunch" ? "昼食" : "夕食"}の塩分が高すぎます（${Math.round(sodium * 10) / 10}g）。`,
      suggestion: "味噌・照り焼き・煮付け・ポン酢など濃い味を 1 つ減らし、汁物か副菜を薄味へ置き換えてください。",
    });
  }

  return issues;
}

export const MEAL_TYPE_ORDER: Record<MealType, number> = {
  breakfast: 10,
  lunch: 20,
  dinner: 30,
  snack: 40,
  midnight_snack: 50,
};

export const DEFAULT_STEP1_DAY_BATCH = 6;
export const DEFAULT_STEP2_FIXES_PER_RUN = 3;
export const DEFAULT_STEP2_FIXES_PER_WEEK = 6;
export const DEFAULT_STEP2_MAX_FIXES_CAP = 12;
export const DEFAULT_STEP3_SLOT_BATCH = 15;

// Ultimate Mode (Steps 4-6)
export const DEFAULT_STEP4_DAY_BATCH = 5;       // 5日/実行（フィードバック分析）
export const DEFAULT_STEP5_DAY_BATCH = 3;       // 3日/実行（再生成）
export const DEFAULT_STEP6_SLOT_BATCH = 15;     // Step 3と同じ

export type SaveIssue = {
  key: string;
  error: string;
};

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
 * 例: 31日 -> ceil(31/7)=5週 -> 5*6=30件 -> cap=12で上限12件
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

export function summarizeSaveResults(params: {
  totalSlots: number;
  savedCount: number;
  skipped: SaveIssue[];
  errors: SaveIssue[];
  successMessage: string;
  successSuffix?: string;
}): {
  status: "completed" | "failed";
  message: string;
  errorMessage: string | null;
} {
  const totalSlots = Math.max(0, Math.trunc(params.totalSlots ?? 0));
  const savedCount = Math.max(0, Math.trunc(params.savedCount ?? 0));
  const skippedCount = params.skipped.length;
  const errorCount = params.errors.length;
  const skippedOnly = savedCount === 0 && skippedCount > 0 && errorCount === 0;

  const status = errorCount > 0
    ? (savedCount > 0 ? "completed" : "failed")
    : skippedOnly
      ? "failed"
      : "completed";

  const message = skippedOnly
    ? `保存されませんでした（既存${skippedCount}件を保護）`
    : skippedCount > 0 || errorCount > 0
      ? `保存完了（成功${savedCount}/${totalSlots}、スキップ${skippedCount}、エラー${errorCount}）`
      : `${params.successMessage}${params.successSuffix ?? ""}`;

  const issues = [...params.skipped, ...params.errors]
    .slice(0, 20)
    .map((issue) => `${issue.key}: ${issue.error}`);

  const errorMessage = issues.length > 0
    ? issues.join("; ")
    : skippedOnly
      ? "対象スロットは既存献立を保護したため保存されませんでした。"
      : null;

  return {
    status,
    message,
    errorMessage,
  };
}
