import { SupabaseClient } from "@supabase/supabase-js";

import { searchSimilarRecipes } from "./evidence-verifier.ts";
import { matchIngredients } from "./ingredient-matcher.ts";
import { calculateDishNutrition } from "./nutrition-calculator-v2.ts";
import type { NutritionTotals } from "./nutrition-calculator.ts";
import { emptyNutrition } from "./nutrition-calculator.ts";

interface EstimatedIngredient {
  name: string;
  amount_g: number;
}

type NutritionValidationResult = {
  isValid: boolean;
  calculatedCalories: number;
  referenceCalories: number;
  deviationPercent: number;
  adjustedNutrition: NutritionTotals | null;
  referenceSource: "dataset_recipes" | "dataset_menu_sets" | "none";
  message: string;
};

function toLegacyNutritionTotals(input: ReturnType<typeof calculateDishNutrition>["totals"]): NutritionTotals {
  return {
    ...emptyNutrition(),
    calories_kcal: input.calories_kcal,
    protein_g: input.protein_g,
    fat_g: input.fat_g,
    carbs_g: input.carbs_g,
    fiber_g: input.fiber_g,
    sodium_g: input.salt_eq_g,
    potassium_mg: input.potassium_mg,
    calcium_mg: input.calcium_mg,
    phosphorus_mg: input.phosphorus_mg,
    magnesium_mg: input.magnesium_mg,
    iron_mg: input.iron_mg,
    zinc_mg: input.zinc_mg,
    iodine_ug: input.iodine_ug,
    cholesterol_mg: input.cholesterol_mg,
    vitamin_a_ug: input.vitamin_a_ug,
    vitamin_b1_mg: input.vitamin_b1_mg,
    vitamin_b2_mg: input.vitamin_b2_mg,
    vitamin_b6_mg: input.vitamin_b6_mg,
    vitamin_b12_ug: input.vitamin_b12_ug,
    vitamin_c_mg: input.vitamin_c_mg,
    vitamin_d_ug: input.vitamin_d_ug,
    vitamin_e_mg: input.vitamin_e_mg,
    vitamin_k_ug: input.vitamin_k_ug,
    folic_acid_ug: input.folic_acid_ug,
  };
}

export async function calculateNutritionFromIngredientsV4(
  supabase: SupabaseClient,
  dishName: string,
  ingredients: EstimatedIngredient[],
): Promise<NutritionTotals> {
  const effectiveIngredients = ingredients.filter((ingredient) => ingredient.amount_g > 0);
  if (effectiveIngredients.length === 0) {
    return emptyNutrition();
  }

  const matchResults = await matchIngredients(supabase, effectiveIngredients);
  const dishNutrition = calculateDishNutrition(dishName, "other", matchResults);
  return toLegacyNutritionTotals(dishNutrition.totals);
}

export async function validateAndAdjustNutritionV4(
  supabase: SupabaseClient,
  dishName: string,
  calculatedNutrition: NutritionTotals,
  options?: {
    maxDeviationPercent?: number;
    useReferenceIfInvalid?: boolean;
  },
): Promise<NutritionValidationResult> {
  const maxDeviation = options?.maxDeviationPercent ?? 50;
  const useReference = options?.useReferenceIfInvalid ?? true;
  const reference = (await searchSimilarRecipes(supabase, dishName, 0.3, 5))[0] ?? null;

  if (!reference || !reference.calories_kcal) {
    return {
      isValid: true,
      calculatedCalories: calculatedNutrition.calories_kcal,
      referenceCalories: 0,
      deviationPercent: 0,
      adjustedNutrition: null,
      referenceSource: "none",
      message: `参照レシピなし（計算値 ${Math.round(calculatedNutrition.calories_kcal)}kcal を使用）`,
    };
  }

  const refCal = reference.calories_kcal;
  const calcCal = calculatedNutrition.calories_kcal;
  const deviationPercent =
    refCal > 0
      ? Math.abs((calcCal - refCal) / refCal) * 100
      : calcCal > 0
        ? 100
        : 0;

  if (deviationPercent <= maxDeviation) {
    return {
      isValid: true,
      calculatedCalories: calcCal,
      referenceCalories: refCal,
      deviationPercent,
      adjustedNutrition: null,
      referenceSource: "dataset_recipes",
      message: `妥当（計算=${Math.round(calcCal)}kcal, 参照=${refCal}kcal, 乖離${deviationPercent.toFixed(0)}%）`,
    };
  }

  if (!useReference) {
    return {
      isValid: false,
      calculatedCalories: calcCal,
      referenceCalories: refCal,
      deviationPercent,
      adjustedNutrition: null,
      referenceSource: "dataset_recipes",
      message: `要確認（計算=${Math.round(calcCal)}kcal, 参照=${refCal}kcal, 乖離${deviationPercent.toFixed(0)}%）`,
    };
  }

  const adjustedNutrition = { ...calculatedNutrition };
  const scaleFactor = calcCal > 0 ? refCal / calcCal : 1;

  adjustedNutrition.calories_kcal = refCal;
  adjustedNutrition.protein_g = reference.protein_g ?? adjustedNutrition.protein_g * scaleFactor;
  adjustedNutrition.fat_g = reference.fat_g ?? adjustedNutrition.fat_g * scaleFactor;
  adjustedNutrition.carbs_g = reference.carbs_g ?? adjustedNutrition.carbs_g * scaleFactor;
  adjustedNutrition.sodium_g = reference.sodium_g ?? adjustedNutrition.sodium_g * scaleFactor;

  adjustedNutrition.fiber_g *= scaleFactor;
  adjustedNutrition.sugar_g *= scaleFactor;
  adjustedNutrition.potassium_mg *= scaleFactor;
  adjustedNutrition.calcium_mg *= scaleFactor;
  adjustedNutrition.phosphorus_mg *= scaleFactor;
  adjustedNutrition.magnesium_mg *= scaleFactor;
  adjustedNutrition.iron_mg *= scaleFactor;
  adjustedNutrition.zinc_mg *= scaleFactor;
  adjustedNutrition.iodine_ug *= scaleFactor;
  adjustedNutrition.cholesterol_mg *= scaleFactor;
  adjustedNutrition.saturated_fat_g *= scaleFactor;
  adjustedNutrition.monounsaturated_fat_g *= scaleFactor;
  adjustedNutrition.polyunsaturated_fat_g *= scaleFactor;
  adjustedNutrition.vitamin_a_ug *= scaleFactor;
  adjustedNutrition.vitamin_b1_mg *= scaleFactor;
  adjustedNutrition.vitamin_b2_mg *= scaleFactor;
  adjustedNutrition.vitamin_b6_mg *= scaleFactor;
  adjustedNutrition.vitamin_b12_ug *= scaleFactor;
  adjustedNutrition.vitamin_c_mg *= scaleFactor;
  adjustedNutrition.vitamin_d_ug *= scaleFactor;
  adjustedNutrition.vitamin_e_mg *= scaleFactor;
  adjustedNutrition.vitamin_k_ug *= scaleFactor;
  adjustedNutrition.folic_acid_ug *= scaleFactor;

  return {
    isValid: false,
    calculatedCalories: calcCal,
    referenceCalories: refCal,
    deviationPercent,
    adjustedNutrition,
    referenceSource: "dataset_recipes",
    message: `調整済み（計算=${Math.round(calcCal)}kcal → 参照=${refCal}kcal に修正）`,
  };
}
