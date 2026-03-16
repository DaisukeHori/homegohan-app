import { SupabaseClient } from "@supabase/supabase-js";

import { searchSimilarRecipes, type ReferenceRecipe } from "./evidence-verifier.ts";
import { matchIngredients, type IngredientMatchResult } from "./ingredient-matcher.ts";
import { calculateDishNutrition } from "./nutrition-calculator-v2.ts";
import type { NutritionTotals } from "./nutrition-calculator.ts";
import { emptyNutrition } from "./nutrition-calculator.ts";

interface EstimatedIngredient {
  name: string;
  amount_g: number;
}

export type V4IngredientMatchDebug = {
  input_name: string;
  amount_g: number;
  match_method: IngredientMatchResult["matchMethod"];
  confidence: IngredientMatchResult["confidence"];
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

export type V4NutritionAnalysis = {
  normalizedIngredients: EstimatedIngredient[];
  ingredientMatches: V4IngredientMatchDebug[];
  calculatedNutrition: NutritionTotals;
  timingMs: {
    normalize_ingredients_ms: number;
    match_ingredients_ms: number;
    calculate_dish_nutrition_ms: number;
    total_ms: number;
  };
};

export function normalizeV4IngredientsForDish(
  dishName: string,
  dishRole: string | undefined,
  ingredients: EstimatedIngredient[],
): EstimatedIngredient[] {
  const normalizedDishName = String(dishName ?? "").trim();
  const isRiceDish =
    dishRole === "rice" ||
    /^(ご飯|ライス|白ご飯|白米|麦ご飯|麦飯|玄米ご飯|発芽玄米ご飯)$/.test(normalizedDishName);
  if (!isRiceDish) return ingredients;

  return ingredients.map((ingredient) => {
    const normalizedName = String(ingredient.name ?? "").trim();
    if (normalizedName !== "米") return ingredient;

    return {
      ...ingredient,
      // 「米 150g」のような曖昧入力は乾燥穀粒やそば米へ誤爆しやすい。
      // role=rice の皿では炊飯後の「ご飯」と解釈する。
      name: "ご飯",
    };
  });
}

type NutritionValidationResult = {
  isValid: boolean;
  calculatedCalories: number;
  referenceCalories: number;
  deviationPercent: number;
  adjustedNutrition: NutritionTotals | null;
  referenceSource: "dataset_recipes" | "dataset_menu_sets" | "none";
  message: string;
  appliedAdjustment: boolean;
  referenceRecipe: ReferenceRecipe | null;
  referenceCandidates: ReferenceRecipe[];
  timingMs: {
    reference_search_ms: number;
    adjustment_ms: number;
    total_ms: number;
  };
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

export async function analyzeNutritionFromIngredientsV4(
  supabase: SupabaseClient,
  dishName: string,
  dishRole: string | undefined,
  ingredients: EstimatedIngredient[],
): Promise<V4NutritionAnalysis> {
  const startedAt = Date.now();

  const normalizeStartedAt = Date.now();
  const normalizedIngredients = normalizeV4IngredientsForDish(dishName, dishRole, ingredients);
  const normalizeIngredientsMs = Date.now() - normalizeStartedAt;
  const effectiveIngredients = normalizedIngredients.filter((ingredient) => ingredient.amount_g > 0);
  if (effectiveIngredients.length === 0) {
    return {
      normalizedIngredients,
      ingredientMatches: [],
      calculatedNutrition: emptyNutrition(),
      timingMs: {
        normalize_ingredients_ms: normalizeIngredientsMs,
        match_ingredients_ms: 0,
        calculate_dish_nutrition_ms: 0,
        total_ms: Date.now() - startedAt,
      },
    };
  }

  const matchStartedAt = Date.now();
  const matchResults = await matchIngredients(supabase, effectiveIngredients);
  const matchIngredientsMs = Date.now() - matchStartedAt;

  const calculateDishNutritionStartedAt = Date.now();
  const dishNutrition = calculateDishNutrition(dishName, "other", matchResults);
  const calculateDishNutritionMs = Date.now() - calculateDishNutritionStartedAt;
  const calculatedNutrition = toLegacyNutritionTotals(dishNutrition.totals);
  const ingredientMatches = matchResults.map((matchResult, index) => {
    const ingredientNutrition = dishNutrition.ingredients[index];

    return {
      input_name: matchResult.input.name,
      amount_g: matchResult.input.amount_g,
      match_method: matchResult.matchMethod,
      confidence: matchResult.confidence,
      matched_name: matchResult.matched?.name ?? null,
      matched_id: matchResult.matched?.id ?? null,
      similarity: matchResult.matched?.similarity ?? 0,
      calories_kcal_per_100g: matchResult.matched?.calories_kcal ?? null,
      protein_g_per_100g: matchResult.matched?.protein_g ?? null,
      fat_g_per_100g: matchResult.matched?.fat_g ?? null,
      carbs_g_per_100g: matchResult.matched?.carbs_g ?? null,
      calculated_calories_kcal: ingredientNutrition?.nutrition.calories_kcal ?? 0,
      calculated_protein_g: ingredientNutrition?.nutrition.protein_g ?? 0,
      calculated_fat_g: ingredientNutrition?.nutrition.fat_g ?? 0,
      calculated_carbs_g: ingredientNutrition?.nutrition.carbs_g ?? 0,
      calculated_fiber_g: ingredientNutrition?.nutrition.fiber_g ?? 0,
    };
  });

  return {
    normalizedIngredients,
    ingredientMatches,
    calculatedNutrition,
    timingMs: {
      normalize_ingredients_ms: normalizeIngredientsMs,
      match_ingredients_ms: matchIngredientsMs,
      calculate_dish_nutrition_ms: calculateDishNutritionMs,
      total_ms: Date.now() - startedAt,
    },
  };
}

export async function calculateNutritionFromIngredientsV4(
  supabase: SupabaseClient,
  dishName: string,
  dishRole: string | undefined,
  ingredients: EstimatedIngredient[],
): Promise<NutritionTotals> {
  const result = await analyzeNutritionFromIngredientsV4(supabase, dishName, dishRole, ingredients);
  return result.calculatedNutrition;
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
  const startedAt = Date.now();
  const maxDeviation = options?.maxDeviationPercent ?? 50;
  const useReference = options?.useReferenceIfInvalid ?? true;
  const referenceSearchStartedAt = Date.now();
  const referenceCandidates = await searchSimilarRecipes(supabase, dishName, 0.3, 5);
  const referenceSearchMs = Date.now() - referenceSearchStartedAt;
  const reference = referenceCandidates[0] ?? null;

  if (!reference || !reference.calories_kcal) {
    return {
      isValid: true,
      calculatedCalories: calculatedNutrition.calories_kcal,
      referenceCalories: 0,
      deviationPercent: 0,
      adjustedNutrition: null,
      referenceSource: "none",
      message: `参照レシピなし（計算値 ${Math.round(calculatedNutrition.calories_kcal)}kcal を使用）`,
      appliedAdjustment: false,
      referenceRecipe: null,
      referenceCandidates,
      timingMs: {
        reference_search_ms: referenceSearchMs,
        adjustment_ms: 0,
        total_ms: Date.now() - startedAt,
      },
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
      appliedAdjustment: false,
      referenceRecipe: reference,
      referenceCandidates,
      timingMs: {
        reference_search_ms: referenceSearchMs,
        adjustment_ms: 0,
        total_ms: Date.now() - startedAt,
      },
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
      appliedAdjustment: false,
      referenceRecipe: reference,
      referenceCandidates,
      timingMs: {
        reference_search_ms: referenceSearchMs,
        adjustment_ms: 0,
        total_ms: Date.now() - startedAt,
      },
    };
  }

  const adjustmentStartedAt = Date.now();
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
  const adjustmentMs = Date.now() - adjustmentStartedAt;

  return {
    isValid: false,
    calculatedCalories: calcCal,
    referenceCalories: refCal,
    deviationPercent,
    adjustedNutrition,
    referenceSource: "dataset_recipes",
    message: `調整済み（計算=${Math.round(calcCal)}kcal → 参照=${refCal}kcal に修正）`,
    appliedAdjustment: true,
    referenceRecipe: reference,
    referenceCandidates,
    timingMs: {
      reference_search_ms: referenceSearchMs,
      adjustment_ms: adjustmentMs,
      total_ms: Date.now() - startedAt,
    },
  };
}
