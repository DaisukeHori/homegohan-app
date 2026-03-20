/**
 * Shared save-meal module
 *
 * saveMealToDb and helpers extracted from generate-menu-v4/index.ts
 * so both V4 and V5 can import directly without HTTP round-trips.
 */

import {
  emptyNutrition,
  type NutritionTotals,
} from "./nutrition-calculator.ts";
import {
  analyzeNutritionFromIngredientsV4,
  validateAndAdjustNutritionV4,
} from "./v4-nutrition-adapter.ts";
import type { IngredientMatchMemo } from "./ingredient-matcher.ts";
import { insertMealNutritionDebugLog, type MealNutritionDebugLogInput } from "./meal-nutrition-debug.ts";
import type { GeneratedMeal, MealType } from "./meal-generator.ts";
import {
  derivePostNutritionIssues,
  type SaveMealResult,
  type PostNutritionIssue,
} from "../generate-menu-v4/step-utils.ts";
import {
  reconcileDishImages,
  DEFAULT_MEAL_IMAGE_MODEL,
} from "./meal-image.ts";
import {
  enqueueMealImageJobs,
  triggerMealImageJobProcessing,
} from "./meal-image-jobs.ts";
import {
  isRetryableError,
  withRetry,
  withTimeout,
} from "./network-retry.ts";

// =========================================================
// Constants
// =========================================================

export const DISPLAY_ORDER_MAP: Record<string, number> = {
  breakfast: 10,
  lunch: 20,
  dinner: 30,
  snack: 40,
  midnight_snack: 50,
};

// =========================================================
// Types
// =========================================================

export type PersistedIngredientMatchCache = Record<string, IngredientMatchMemo>;

export interface TargetSlot {
  date: string;
  mealType: MealType;
  plannedMealId?: string;
}

// =========================================================
// Helpers
// =========================================================

function createSupabaseQueryError(label: string, error: any): Error & { status?: number } {
  const err = new Error(`${label}: ${error?.message ?? "unknown error"}`) as Error & { status?: number };
  err.status =
    isRetryableError(error) || /timeout|temporar|unavailable|connection|fetch failed/i.test(String(error?.message ?? ""))
      ? 503
      : 400;
  return err;
}

export async function runSupabaseQuery<T>(
  queryFactory: () => Promise<{ data: T | null; error: any }>,
  label: string,
  defaultValue: T,
  timeoutMs = 15000,
  retries = 2,
): Promise<T> {
  return await withRetry(async () => {
    const result = await withTimeout(queryFactory(), { label, timeoutMs });
    if (result.error) {
      throw createSupabaseQueryError(label, result.error);
    }
    return (result.data ?? defaultValue) as T;
  }, { label, retries });
}

export function scheduleBackgroundTask(label: string, task: () => Promise<void>): void {
  const promise = Promise.resolve()
    .then(task)
    .catch((error) => {
      console.error(`[background] ${label} failed:`, error);
    });

  // @ts-ignore EdgeRuntime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore EdgeRuntime
    EdgeRuntime.waitUntil(promise);
    return;
  }

  void promise;
}

export function getMinExpectedCaloriesForRole(role: string | undefined): number {
  switch (role) {
    case "main":
    case "rice":
      return 100;
    case "side":
      return 30;
    case "soup":
      return 20;
    default:
      return 20;
  }
}

export function deserializeIngredientMatchCache(
  cache: PersistedIngredientMatchCache | undefined,
): Map<string, IngredientMatchMemo> {
  return new Map(Object.entries(cache ?? {}));
}

export function serializeIngredientMatchCache(
  cache: Map<string, IngredientMatchMemo>,
): PersistedIngredientMatchCache {
  return Object.fromEntries(cache.entries());
}

// =========================================================
// ensureDailyMealIdsForDates
// =========================================================

export async function ensureDailyMealIdsForDates(
  supabase: any,
  userId: string,
  dates: string[],
): Promise<Map<string, string>> {
  const uniqueDates = [...new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))];
  const map = new Map<string, string>();

  if (uniqueDates.length === 0) return map;

  const upsertRows = uniqueDates.map((date) => ({
    user_id: userId,
    day_date: date,
    updated_at: new Date().toISOString(),
  }));

  const rows = await runSupabaseQuery<Array<{ id: string; day_date: string }> | null>(
    () => supabase
      .from("user_daily_meals")
      .upsert(upsertRows, { onConflict: "user_id,day_date" })
      .select("id, day_date"),
    `user_daily_meals.bulk_upsert:${userId}:${uniqueDates[0]}:${uniqueDates[uniqueDates.length - 1]}`,
    null,
    20000,
  );

  for (const row of rows ?? []) {
    if (row?.id && row?.day_date) {
      map.set(String(row.day_date).slice(0, 10), row.id);
    }
  }

  if (map.size === uniqueDates.length) return map;

  const fallbackRows = await runSupabaseQuery<Array<{ id: string; day_date: string }>>(
    () => supabase
      .from("user_daily_meals")
      .select("id, day_date")
      .eq("user_id", userId)
      .in("day_date", uniqueDates),
    `user_daily_meals.bulk_select:${userId}:${uniqueDates[0]}:${uniqueDates[uniqueDates.length - 1]}`,
    [],
    20000,
  );

  for (const row of fallbackRows ?? []) {
    if (row?.id && row?.day_date) {
      map.set(String(row.day_date).slice(0, 10), row.id);
    }
  }

  return map;
}

// =========================================================
// saveMealToDb
// =========================================================

export async function saveMealToDb(
  supabase: any,
  params: {
    userId: string;
    requestId?: string;
    targetSlot: TargetSlot;
    generatedMeal: GeneratedMeal;
    dailyMealIdByDate?: Map<string, string>;
    ingredientMatchMemo?: Map<string, IngredientMatchMemo>;
    sourceFunction?: string;
  }
): Promise<SaveMealResult> {
  const { userId, requestId, targetSlot, generatedMeal, dailyMealIdByDate, ingredientMatchMemo } = params;
  const sourceFunction = params.sourceFunction ?? "generate-menu-v4";
  const slotStartedAt = Date.now();
  let dishProcessingTotalMs = 0;
  let plannedMealLookupMs = 0;
  let plannedMealWriteMs = 0;

  // user_daily_meals: upsert（日付ベース）
  const dailyMealUpsertStartedAt = Date.now();
  let dailyMeal = dailyMealIdByDate?.get(targetSlot.date)
    ? { id: dailyMealIdByDate.get(targetSlot.date)! }
    : null;
  if (!dailyMeal?.id) {
    dailyMeal = await runSupabaseQuery<{ id: string } | null>(
      () => supabase
        .from("user_daily_meals")
        .upsert(
          {
            user_id: userId,
            day_date: targetSlot.date,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,day_date" },
        )
        .select("id")
        .single(),
      `user_daily_meals.upsert:${userId}:${targetSlot.date}`,
      null,
      20000,
    );
    if (dailyMeal?.id) {
      dailyMealIdByDate?.set(targetSlot.date, dailyMeal.id);
    }
  }

  if (!dailyMeal?.id) {
    throw new Error(`Failed to upsert user_daily_meals for ${userId}:${targetSlot.date}`);
  }
  const dailyMealUpsertMs = Date.now() - dailyMealUpsertStartedAt;
  const dayData = dailyMeal;

  if (!targetSlot.plannedMealId) {
    const plannedMealLookupStartedAt = Date.now();
    const occupiedMeal = await runSupabaseQuery<{ id: string } | null>(
      () => supabase
        .from("planned_meals")
        .select("id")
        .eq("daily_meal_id", dayData.id)
        .eq("meal_type", targetSlot.mealType)
        .maybeSingle(),
      `planned_meals.lookup:${dayData.id}:${targetSlot.mealType}`,
      null,
      15000,
    );
    plannedMealLookupMs = Date.now() - plannedMealLookupStartedAt;

    if (occupiedMeal?.id) {
      console.warn(`⚠️ Slot ${targetSlot.date}/${targetSlot.mealType} already exists, skipping to protect data`);
      return {
        outcome: "skipped_existing",
        plannedMealId: occupiedMeal.id,
        reason: `既存スロット ${targetSlot.date}/${targetSlot.mealType} を保護しました（plannedMealId 未指定）`,
      };
    }
  }

  const existingMeal = targetSlot.plannedMealId
    ? await runSupabaseQuery(
        () => supabase
          .from("planned_meals")
          .select("id, dishes, image_url")
          .eq("id", targetSlot.plannedMealId)
          .maybeSingle(),
        `planned_meals.lookup:${targetSlot.plannedMealId}`,
        null,
      )
    : null;

  if (targetSlot.plannedMealId && !existingMeal?.id) {
    console.warn(`planned_meal ${targetSlot.plannedMealId} not found (may have been cleared), will insert new`);
    targetSlot.plannedMealId = undefined as any;
  }

  // Calculate nutrition per dish + V3-like validation/adjustment for suspicious low-calorie dishes
  const totalNutrition = emptyNutrition();
  const dishDetails: any[] = [];
  const nutritionDebugEntries: MealNutritionDebugLogInput[] = [];
  const aggregatedIngredients: string[] = [];
  const allSteps: string[] = [];

  const round1 = (v: number | null | undefined) => (v != null ? Math.round(v * 10) / 10 : null);
  const round2 = (v: number | null | undefined) => (v != null ? Math.round(v * 100) / 100 : null);

  // レシピDBから解決された栄養データがある場合はそれを使用
  const resolvedNutrition = (generatedMeal as any)._resolvedNutrition as NutritionTotals | undefined;
  const recipeSource = (generatedMeal as any)._recipeSource as { type: string; id: string; externalId: string } | undefined;

  // --- dish 並列化: 各 dish を独立して処理し、結果を集約 ---
  const dishResults = await Promise.all(
    generatedMeal.dishes.map(async (dish: any, idx: number) => {
      const dishStartedAt = Date.now();

      const inputIngredients = (dish.ingredients ?? []).map((ingredient: any) => ({
        name: String(ingredient?.name ?? "").trim(),
        amount_g: Number(ingredient?.amount_g ?? 0),
      }));
      const dishTimingMs: Record<string, unknown> = {
        dish_index: idx,
        ingredient_count: inputIngredients.length,
        used_resolved_recipe_db: Boolean(resolvedNutrition && idx === 0),
        nutrition_analysis_ms: 0,
        normalize_ingredients_ms: 0,
        match_ingredients_ms: 0,
        calculate_dish_nutrition_ms: 0,
        validation_ms: 0,
        reference_search_ms: 0,
        reference_adjustment_ms: 0,
        build_dish_detail_ms: 0,
        total_ms: 0,
      };
      let normalizedIngredients = inputIngredients;
      let ingredientMatches: MealNutritionDebugLogInput["ingredientMatches"] = [];
      let calculatedNutrition: NutritionTotals = emptyNutrition();
      let nutrition: NutritionTotals = emptyNutrition();
      let sourceKind: MealNutritionDebugLogInput["sourceKind"] = "ingredient_match";
      const minExpectedCal = getMinExpectedCaloriesForRole(dish.role);
      let validationDebug: MealNutritionDebugLogInput["validation"] = {
        attempted: false,
        min_expected_calories: minExpectedCal,
        calculated_calories: 0,
        reference_calories: 0,
        deviation_percent: 0,
        used_reference_adjustment: false,
        message: "未検証",
        reference_source: "none",
        reference_recipe: null,
        reference_candidates: [],
      };

      // レシピDBからの事前計算済み栄養データがある場合はそれを使用
      if (resolvedNutrition && idx === 0) {
        sourceKind = "resolved_recipe_db";
        calculatedNutrition = resolvedNutrition;
        nutrition = resolvedNutrition;
        console.log(`📊 Using pre-calculated nutrition from recipe DB for ${dish.name}`);
      } else {
        try {
          const nutritionAnalysisStartedAt = Date.now();
          const analysis = await analyzeNutritionFromIngredientsV4(
            supabase,
            dish.name,
            dish.role,
            dish.ingredients,
            { matchMemo: ingredientMatchMemo },
          );
          dishTimingMs.nutrition_analysis_ms = Date.now() - nutritionAnalysisStartedAt;
          dishTimingMs.normalize_ingredients_ms = analysis.timingMs.normalize_ingredients_ms;
          dishTimingMs.match_ingredients_ms = analysis.timingMs.match_ingredients_ms;
          dishTimingMs.calculate_dish_nutrition_ms = analysis.timingMs.calculate_dish_nutrition_ms;
          normalizedIngredients = analysis.normalizedIngredients;
          ingredientMatches = analysis.ingredientMatches;
          calculatedNutrition = analysis.calculatedNutrition;
          nutrition = analysis.calculatedNutrition;
        } catch (e) {
          console.warn(`Nutrition calc failed for ${dish.name}:`, e);
          calculatedNutrition = emptyNutrition();
          nutrition = emptyNutrition();
        }
      }

      // V3同様: 低カロリーなど怪しい料理のみ参照レシピで検証・補正
      if ((nutrition.calories_kcal ?? 0) < minExpectedCal) {
        validationDebug = {
          attempted: true,
          min_expected_calories: minExpectedCal,
          calculated_calories: nutrition.calories_kcal ?? 0,
          reference_calories: 0,
          deviation_percent: 0,
          used_reference_adjustment: false,
          message: "検証開始",
          reference_source: "none",
          reference_recipe: null,
          reference_candidates: [],
        };
        try {
          const before = nutrition.calories_kcal ?? 0;
          const validationStartedAt = Date.now();
          const validation = await validateAndAdjustNutritionV4(
            supabase,
            dish.name,
            nutrition,
            { maxDeviationPercent: 70, useReferenceIfInvalid: true },
          );
          dishTimingMs.validation_ms = Date.now() - validationStartedAt;
          dishTimingMs.reference_search_ms = validation.timingMs.reference_search_ms;
          dishTimingMs.reference_adjustment_ms = validation.timingMs.adjustment_ms;
          validationDebug = {
            attempted: true,
            min_expected_calories: minExpectedCal,
            calculated_calories: validation.calculatedCalories,
            reference_calories: validation.referenceCalories,
            deviation_percent: validation.deviationPercent,
            used_reference_adjustment: Boolean(validation.appliedAdjustment),
            message: validation.message,
            reference_source: validation.referenceSource,
            reference_recipe: validation.referenceRecipe,
            reference_candidates: validation.referenceCandidates,
          };
          if (validation.adjustedNutrition) {
            nutrition = validation.adjustedNutrition;
            const after = nutrition.calories_kcal ?? 0;
            console.log(
              `📝 Adjusted "${dish.name}": ${Math.round(before)}kcal → ${Math.round(after)}kcal (${validation.message})`,
            );
          }
        } catch (e: any) {
          console.warn(`Validation failed for ${dish.name}:`, e?.message ?? e);
          validationDebug.message = `検証失敗: ${e?.message ?? String(e)}`;
        }
      } else {
        validationDebug = {
          attempted: false,
          min_expected_calories: minExpectedCal,
          calculated_calories: nutrition.calories_kcal ?? 0,
          reference_calories: 0,
          deviation_percent: 0,
          used_reference_adjustment: false,
          message: "閾値以上のため検証スキップ",
          reference_source: "none",
          reference_recipe: null,
          reference_candidates: [],
        };
      }

      const buildDishDetailStartedAt = Date.now();
      const debugEntry: MealNutritionDebugLogInput = {
        requestId: requestId ?? null,
        userId,
        dailyMealId: dayData.id,
        targetDate: targetSlot.date,
        mealType: targetSlot.mealType,
        dishName: dish.name,
        dishRole: dish.role ?? null,
        sourceFunction,
        sourceKind,
        inputIngredients,
        normalizedIngredients,
        ingredientMatches,
        calculatedNutrition,
        finalNutrition: nutrition,
        validation: validationDebug,
        dishTimingMs,
        metadata: {
          generated_meal_type: generatedMeal.mealType,
          recipe_source: idx === 0 && recipeSource ? recipeSource : null,
        },
      };

      // dishes(JSON) をV3寄せの形式で保存（買い物リスト・表示の精度向上）
      let ingredientsMd = "| 材料 | 分量 |\n|------|------|\n";
      const ingredientLines = dish.ingredients.map((i: any) => {
        const line = `${i.name} ${i.amount_g}g${i.note ? ` (${i.note})` : ""}`;
        ingredientsMd += `| ${i.name} | ${i.amount_g}g${i.note ? ` (${i.note})` : ""} |\n`;
        return line;
      });

      const recipeSteps = dish.instructions ?? [];
      const recipeStepsMd = recipeSteps.map((step: string, i: number) => `${i + 1}. ${step}`).join("\n\n");

      const dishDetail = {
        name: dish.name,
        role: dish.role,
        ingredient: dish.ingredients.slice(0, 3).map((i: any) => i.name).join("、"),
        ingredients: ingredientLines,
        recipeSteps,
        ingredientsMd,
        recipeStepsMd,
        displayOrder: idx,

        // 栄養素（単位付きの統一形式）
        calories_kcal: nutrition?.calories_kcal != null ? Math.round(nutrition.calories_kcal) : null,
        protein_g: round1(nutrition?.protein_g),
        fat_g: round1(nutrition?.fat_g),
        carbs_g: round1(nutrition?.carbs_g),
        fiber_g: round1(nutrition?.fiber_g),
        sugar_g: round1(nutrition?.sugar_g),
        sodium_g: round1(nutrition?.sodium_g),
        fiber_soluble_g: round1(nutrition?.fiber_soluble_g),
        fiber_insoluble_g: round1(nutrition?.fiber_insoluble_g),

        // ミネラル
        potassium_mg: round1(nutrition?.potassium_mg),
        calcium_mg: round1(nutrition?.calcium_mg),
        phosphorus_mg: round1(nutrition?.phosphorus_mg),
        magnesium_mg: round1(nutrition?.magnesium_mg),
        iron_mg: round1(nutrition?.iron_mg),
        zinc_mg: round1(nutrition?.zinc_mg),
        iodine_ug: round1(nutrition?.iodine_ug),
        cholesterol_mg: round1(nutrition?.cholesterol_mg),

        // ビタミン
        vitamin_a_ug: round1(nutrition?.vitamin_a_ug),
        vitamin_b1_mg: round2(nutrition?.vitamin_b1_mg),
        vitamin_b2_mg: round2(nutrition?.vitamin_b2_mg),
        vitamin_b6_mg: round2(nutrition?.vitamin_b6_mg),
        vitamin_b12_ug: round1(nutrition?.vitamin_b12_ug),
        vitamin_c_mg: round1(nutrition?.vitamin_c_mg),
        vitamin_d_ug: round1(nutrition?.vitamin_d_ug),
        vitamin_e_mg: round1(nutrition?.vitamin_e_mg),
        vitamin_k_ug: round1(nutrition?.vitamin_k_ug),
        folic_acid_ug: round1(nutrition?.folic_acid_ug),

        // 脂肪酸
        saturated_fat_g: round1(nutrition?.saturated_fat_g),
        monounsaturated_fat_g: round1(nutrition?.monounsaturated_fat_g),
        polyunsaturated_fat_g: round1(nutrition?.polyunsaturated_fat_g),

        // レシピDBソース（AIアドバイザーからの検索時）
        recipe_source: idx === 0 && recipeSource ? recipeSource : undefined,
      };
      dishTimingMs.build_dish_detail_ms = Date.now() - buildDishDetailStartedAt;
      dishTimingMs.total_ms = Date.now() - dishStartedAt;

      return {
        nutrition,
        dishDetail,
        debugEntry,
        ingredientLines,
        recipeSteps,
        processingMs: Number(dishTimingMs.total_ms ?? 0),
      };
    }),
  );

  // --- 結果を順序通りに集約（Promise.all は入力順を保証） ---
  for (const result of dishResults) {
    for (const key of Object.keys(totalNutrition) as (keyof NutritionTotals)[]) {
      totalNutrition[key] = (totalNutrition[key] || 0) + (result.nutrition[key] || 0);
    }
    dishDetails.push(result.dishDetail);
    nutritionDebugEntries.push(result.debugEntry);
    aggregatedIngredients.push(...result.ingredientLines);
    allSteps.push(...result.recipeSteps);
    dishProcessingTotalMs += result.processingMs;
  }

  const jobTriggerSource = requestId ? `${sourceFunction}:${requestId}` : sourceFunction;
  const reconcileResult = await reconcileDishImages({
    previousDishes: Array.isArray(existingMeal?.dishes) ? existingMeal?.dishes : null,
    nextDishes: generatedMeal.dishes.map((dish, idx) => ({
      name: dish.name,
      role: dish.role,
      ingredients: Array.isArray(dish.ingredients) ? dish.ingredients : [],
      displayOrder: idx,
    })),
    triggerSource: jobTriggerSource,
    fallbackMealImageUrl: existingMeal?.image_url ?? null,
    model: DEFAULT_MEAL_IMAGE_MODEL,
  });
  const mergedDishes = dishDetails.map((detail, idx) => ({
    ...detail,
    ...reconcileResult.dishes[idx],
  }));
  const mealCoverImageUrl = reconcileResult.mealCoverImageUrl ?? existingMeal?.image_url ?? null;

  const dishName = dishDetails.length === 1
    ? String(dishDetails[0]?.name ?? "献立")
    : (() => {
        const names = dishDetails
          .slice(0, 3)
          .map((d: any) => String(d?.name ?? "").trim())
          .filter(Boolean);
        const base = names.join("、") || "献立";
        return base + (dishDetails.length > 3 ? " など" : "");
      })();

  const plannedMealData = {
    daily_meal_id: dayData.id,
    meal_type: targetSlot.mealType,
    dish_name: dishName,
    ingredients: aggregatedIngredients,
    recipe_steps: allSteps,
    dishes: mergedDishes,
    mode: "ai_creative",
    is_simple: false,
    display_order: DISPLAY_ORDER_MAP[targetSlot.mealType] ?? 0,
    is_generating: false,
    is_completed: false,
    // Nutrition fields (丸めてDB保存 - 整数型や小数精度に合わせる)
    calories_kcal: Math.round(totalNutrition.calories_kcal ?? 0),
    protein_g: Math.round((totalNutrition.protein_g ?? 0) * 10) / 10,
    fat_g: Math.round((totalNutrition.fat_g ?? 0) * 10) / 10,
    carbs_g: Math.round((totalNutrition.carbs_g ?? 0) * 10) / 10,
    sodium_g: Math.round((totalNutrition.sodium_g ?? 0) * 10) / 10,
    sugar_g: Math.round((totalNutrition.sugar_g ?? 0) * 10) / 10,
    fiber_g: Math.round((totalNutrition.fiber_g ?? 0) * 10) / 10,
    fiber_soluble_g: Math.round((totalNutrition.fiber_soluble_g ?? 0) * 10) / 10,
    fiber_insoluble_g: Math.round((totalNutrition.fiber_insoluble_g ?? 0) * 10) / 10,
    potassium_mg: Math.round((totalNutrition.potassium_mg ?? 0) * 10) / 10,
    calcium_mg: Math.round((totalNutrition.calcium_mg ?? 0) * 10) / 10,
    magnesium_mg: Math.round((totalNutrition.magnesium_mg ?? 0) * 10) / 10,
    phosphorus_mg: Math.round((totalNutrition.phosphorus_mg ?? 0) * 10) / 10,
    iron_mg: Math.round((totalNutrition.iron_mg ?? 0) * 10) / 10,
    zinc_mg: Math.round((totalNutrition.zinc_mg ?? 0) * 10) / 10,
    iodine_ug: Math.round((totalNutrition.iodine_ug ?? 0) * 10) / 10,
    cholesterol_mg: Math.round((totalNutrition.cholesterol_mg ?? 0) * 10) / 10,
    vitamin_a_ug: Math.round((totalNutrition.vitamin_a_ug ?? 0) * 10) / 10,
    vitamin_b1_mg: Math.round((totalNutrition.vitamin_b1_mg ?? 0) * 10) / 10,
    vitamin_b2_mg: Math.round((totalNutrition.vitamin_b2_mg ?? 0) * 10) / 10,
    vitamin_b6_mg: Math.round((totalNutrition.vitamin_b6_mg ?? 0) * 10) / 10,
    vitamin_b12_ug: Math.round((totalNutrition.vitamin_b12_ug ?? 0) * 10) / 10,
    vitamin_c_mg: Math.round((totalNutrition.vitamin_c_mg ?? 0) * 10) / 10,
    vitamin_d_ug: Math.round((totalNutrition.vitamin_d_ug ?? 0) * 10) / 10,
    vitamin_e_mg: Math.round((totalNutrition.vitamin_e_mg ?? 0) * 10) / 10,
    vitamin_k_ug: Math.round((totalNutrition.vitamin_k_ug ?? 0) * 10) / 10,
    folic_acid_ug: Math.round((totalNutrition.folic_acid_ug ?? 0) * 10) / 10,
    saturated_fat_g: Math.round((totalNutrition.saturated_fat_g ?? 0) * 10) / 10,
    monounsaturated_fat_g: Math.round((totalNutrition.monounsaturated_fat_g ?? 0) * 10) / 10,
    polyunsaturated_fat_g: Math.round((totalNutrition.polyunsaturated_fat_g ?? 0) * 10) / 10,
    image_url: mealCoverImageUrl,
    updated_at: new Date().toISOString(),
  };

  let plannedMealId = targetSlot.plannedMealId ?? null;
  const writeOutcome: SaveMealResult["outcome"] = targetSlot.plannedMealId ? "updated" : "inserted";

  // If plannedMealId is specified, update existing record
  if (targetSlot.plannedMealId) {
    const plannedMealWriteStartedAt = Date.now();
    const updatedMeal = await runSupabaseQuery<{ id: string } | null>(
      () => supabase
        .from("planned_meals")
        .update(plannedMealData)
        .eq("id", targetSlot.plannedMealId)
        .select("id")
        .maybeSingle(),
      `planned_meals.update:${targetSlot.plannedMealId}`,
      null,
      20000,
    );
    plannedMealWriteMs = Date.now() - plannedMealWriteStartedAt;
    if (!updatedMeal?.id) {
      throw new Error(`Failed to update planned_meal ${targetSlot.plannedMealId}`);
    }
    plannedMealId = updatedMeal.id;
    console.log(`✅ Updated planned_meal ${targetSlot.plannedMealId}`);
  } else {
    const plannedMealWriteStartedAt = Date.now();
    const insertedMeal = await runSupabaseQuery<{ id: string } | null>(
      () => supabase
        .from("planned_meals")
        .insert(plannedMealData)
        .select("id")
        .single(),
      `planned_meals.insert:${dayData.id}:${targetSlot.mealType}`,
      null,
      20000,
    );
    plannedMealWriteMs = Date.now() - plannedMealWriteStartedAt;
    if (!insertedMeal?.id) {
      throw new Error(`Failed to insert planned_meal for ${dayData.id}:${targetSlot.mealType}`);
    }
    plannedMealId = insertedMeal?.id ?? null;
    console.log(`✅ Created new planned_meal for ${targetSlot.date}/${targetSlot.mealType}`);
  }

  if (!plannedMealId) {
    throw new Error(`plannedMealId missing after save for ${targetSlot.date}/${targetSlot.mealType}`);
  }

  const slotTimingMs = {
    daily_meal_upsert_ms: dailyMealUpsertMs,
    dish_processing_total_ms: dishProcessingTotalMs,
    planned_meal_lookup_ms: plannedMealLookupMs,
    planned_meal_write_ms: plannedMealWriteMs,
    nutrition_debug_insert_ms: 0,
    dish_count: generatedMeal.dishes.length,
    updated_existing_planned_meal: Boolean(targetSlot.plannedMealId),
    total_ms: Date.now() - slotStartedAt,
  };
  scheduleBackgroundTask(`meal-image-jobs:${plannedMealId}`, async () => {
    await enqueueMealImageJobs({
      supabase,
      plannedMealId,
      userId,
      jobs: reconcileResult.jobs,
      requestId: requestId ?? null,
    });
    if (reconcileResult.jobs.length > 0) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
      const serviceRoleKey = Deno.env.get("SERVICE_ROLE_JWT") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      await triggerMealImageJobProcessing({
        supabaseUrl,
        serviceRoleKey,
        plannedMealId,
        limit: reconcileResult.jobs.length,
      });
    }
  });

  scheduleBackgroundTask(`meal-nutrition-debug:${targetSlot.date}:${targetSlot.mealType}`, async () => {
    const nutritionDebugInsertStartedAt = Date.now();
    const debugLogIds = (
      await Promise.all(
        nutritionDebugEntries.map((entry) =>
          insertMealNutritionDebugLog(supabase, {
            ...entry,
            plannedMealId,
            slotTimingMs,
            metadata: {
              ...(entry.metadata ?? {}),
              planned_meal_id: plannedMealId,
              meal_title: dishName,
            },
          }),
        ),
      )
    ).filter((id): id is string => Boolean(id));
    const finalizedSlotTimingMs = {
      ...slotTimingMs,
      nutrition_debug_insert_ms: Date.now() - nutritionDebugInsertStartedAt,
    };

    if (debugLogIds.length === 0) return;

    await runSupabaseQuery(
      () => supabase
        .from("meal_nutrition_debug_logs")
        .update({ slot_timing_ms: finalizedSlotTimingMs })
        .in("id", debugLogIds),
      `meal_nutrition_debug_logs.updateSlotTiming:${targetSlot.date}:${targetSlot.mealType}`,
      null,
      10000,
      1,
    );
  });

  // Post-save nutrition quality check
  const qualityIssues = derivePostNutritionIssues({
    date: targetSlot.date,
    mealType: targetSlot.mealType,
    caloriesKcal: totalNutrition.calories_kcal,
    sodiumG: totalNutrition.sodium_g,
  });

  return {
    outcome: writeOutcome,
    plannedMealId,
    qualityIssues: qualityIssues.length > 0 ? qualityIssues : undefined,
  };
}
