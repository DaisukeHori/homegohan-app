import { describe, expect, it } from "vitest";

import { collectMealNutritionIssueFlags } from "../supabase/functions/_shared/meal-nutrition-debug.ts";

describe("meal nutrition debug flags", () => {
  it("marks normalization, unmatched, and adjustment flags", () => {
    const flags = collectMealNutritionIssueFlags({
      sourceKind: "ingredient_match",
      inputIngredients: [
        { name: "米", amount_g: 150 },
      ],
      normalizedIngredients: [
        { name: "ご飯", amount_g: 150 },
      ],
      ingredientMatches: [
        {
          input_name: "ご飯",
          amount_g: 150,
          match_method: "exact_map",
          confidence: "none",
          matched_name: null,
          matched_id: null,
          similarity: 0,
          calories_kcal_per_100g: null,
          protein_g_per_100g: null,
          fat_g_per_100g: null,
          carbs_g_per_100g: null,
          calculated_calories_kcal: 0,
          calculated_protein_g: 0,
          calculated_fat_g: 0,
          calculated_carbs_g: 0,
          calculated_fiber_g: 0,
        },
      ],
      validation: {
        attempted: true,
        min_expected_calories: 100,
        calculated_calories: 60,
        reference_calories: 234,
        deviation_percent: 74,
        used_reference_adjustment: true,
        message: "調整済み",
        reference_source: "dataset_recipes",
        reference_recipe: { id: "ref-1" },
        reference_candidates: [{ id: "ref-1" }],
      },
    });

    expect(flags).toContain("ingredient_normalized");
    expect(flags).toContain("rice_amount_normalized");
    expect(flags).toContain("unmatched_ingredient");
    expect(flags).toContain("low_confidence_match");
    expect(flags).toContain("reference_validation_checked");
    expect(flags).toContain("reference_adjusted");
  });

  it("marks resolved recipe rows without validation", () => {
    const flags = collectMealNutritionIssueFlags({
      sourceKind: "resolved_recipe_db",
      inputIngredients: [],
      normalizedIngredients: [],
      ingredientMatches: [],
      validation: {
        attempted: false,
        min_expected_calories: 20,
        calculated_calories: 227,
        reference_calories: 0,
        deviation_percent: 0,
        used_reference_adjustment: false,
        message: "閾値以上のため検証スキップ",
        reference_source: "none",
        reference_recipe: null,
        reference_candidates: [],
      },
    });

    expect(flags).toContain("resolved_recipe_db");
    expect(flags).not.toContain("reference_validation_checked");
  });
});
