import type { SupabaseClient } from "@supabase/supabase-js";

import type { NutritionTotals } from "./nutrition-calculator.ts";

export type IngredientAmount = {
  name: string;
  amount_g: number;
};

export type IngredientMatchDebug = {
  input_name: string;
  amount_g: number;
  match_method: string;
  confidence: string;
  matched_name: string | null;
  matched_id: string | null;
  similarity: number;
  calories_kcal_per_100g: number | null;
  protein_g_per_100g: number | null;
  fat_g_per_100g: number | null;
  carbs_g_per_100g: number | null;
  calculated_calories_kcal: number;
  calculated_protein_g: number;
  calculated_fat_g: number;
  calculated_carbs_g: number;
  calculated_fiber_g: number;
};

export type ValidationDebug = {
  attempted: boolean;
  min_expected_calories: number;
  calculated_calories: number;
  reference_calories: number;
  deviation_percent: number;
  used_reference_adjustment: boolean;
  message: string;
  reference_source: string;
  reference_recipe?: Record<string, unknown> | null;
  reference_candidates?: Record<string, unknown>[];
};

export type MealNutritionDebugLogInput = {
  requestId?: string | null;
  userId: string;
  dailyMealId?: string | null;
  plannedMealId?: string | null;
  targetDate: string;
  mealType: string;
  dishName: string;
  dishRole?: string | null;
  sourceFunction: string;
  sourceKind: "ingredient_match" | "resolved_recipe_db";
  inputIngredients: IngredientAmount[];
  normalizedIngredients: IngredientAmount[];
  ingredientMatches: IngredientMatchDebug[];
  calculatedNutrition: NutritionTotals;
  finalNutrition: NutritionTotals;
  validation: ValidationDebug;
  dishTimingMs?: Record<string, unknown>;
  slotTimingMs?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

function hasNormalizationDiff(inputIngredients: IngredientAmount[], normalizedIngredients: IngredientAmount[]): boolean {
  if (inputIngredients.length !== normalizedIngredients.length) return true;

  return inputIngredients.some((ingredient, index) => {
    const normalized = normalizedIngredients[index];
    if (!normalized) return true;

    return ingredient.name !== normalized.name || ingredient.amount_g !== normalized.amount_g;
  });
}

export function collectMealNutritionIssueFlags(input: {
  sourceKind: MealNutritionDebugLogInput["sourceKind"];
  inputIngredients: IngredientAmount[];
  normalizedIngredients: IngredientAmount[];
  ingredientMatches: IngredientMatchDebug[];
  validation: ValidationDebug;
}): string[] {
  const flags = new Set<string>();

  if (input.sourceKind === "resolved_recipe_db") {
    flags.add("resolved_recipe_db");
  }

  if (hasNormalizationDiff(input.inputIngredients, input.normalizedIngredients)) {
    flags.add("ingredient_normalized");
  }

  const riceNormalized = input.inputIngredients.some((ingredient, index) => {
    const normalized = input.normalizedIngredients[index];
    return ingredient.name === "米" && normalized?.name === "ご飯";
  });
  if (riceNormalized) {
    flags.add("rice_amount_normalized");
  }

  if (input.ingredientMatches.some((match) => !match.matched_id)) {
    flags.add("unmatched_ingredient");
  }

  if (input.ingredientMatches.some((match) => match.confidence === "low" || match.confidence === "none")) {
    flags.add("low_confidence_match");
  }

  if (input.validation.attempted) {
    flags.add("reference_validation_checked");
  }

  if (input.validation.used_reference_adjustment) {
    flags.add("reference_adjusted");
  }

  if (input.validation.attempted && !input.validation.reference_recipe) {
    flags.add("reference_missing");
  }

  return Array.from(flags);
}

export async function insertMealNutritionDebugLog(
  supabase: SupabaseClient,
  input: MealNutritionDebugLogInput,
): Promise<string | null> {
  try {
    const issueFlags = collectMealNutritionIssueFlags({
      sourceKind: input.sourceKind,
      inputIngredients: input.inputIngredients,
      normalizedIngredients: input.normalizedIngredients,
      ingredientMatches: input.ingredientMatches,
      validation: input.validation,
    });

    const { data, error } = await supabase
      .from("meal_nutrition_debug_logs")
      .insert({
        request_id: input.requestId ?? null,
        user_id: input.userId,
        daily_meal_id: input.dailyMealId ?? null,
        planned_meal_id: input.plannedMealId ?? null,
        target_date: input.targetDate,
        meal_type: input.mealType,
        dish_name: input.dishName,
        dish_role: input.dishRole ?? null,
        source_function: input.sourceFunction,
        source_kind: input.sourceKind,
        input_ingredients: input.inputIngredients,
        normalized_ingredients: input.normalizedIngredients,
        ingredient_matches: input.ingredientMatches,
        calculated_nutrition: input.calculatedNutrition,
        validation_result: input.validation,
        final_nutrition: input.finalNutrition,
        dish_timing_ms: input.dishTimingMs ?? {},
        slot_timing_ms: input.slotTimingMs ?? {},
        issue_flags: issueFlags,
        metadata: input.metadata ?? {},
      })
      .select("id")
      .single();

    if (error) {
      console.error("[meal-nutrition-debug] Failed to insert log:", error);
      return null;
    }
    return typeof data?.id === "string" ? data.id : null;
  } catch (error) {
    console.error("[meal-nutrition-debug] Failed to insert log:", error);
    return null;
  }
}
