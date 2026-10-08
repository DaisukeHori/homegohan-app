import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  analyzeNutritionFromIngredientsV4,
  normalizeV4IngredientsForDish,
  validateAndAdjustNutritionV4,
} from "../supabase/functions/_shared/v4-nutrition-adapter.ts";
import { EXACT_NAME_NORM_MAP, emptyNutrition } from "../supabase/functions/_shared/nutrition-calculator.ts";
import type { IngredientMatchResult, MatchedIngredientData } from "../supabase/functions/_shared/ingredient-matcher.ts";
import type { ReferenceRecipe } from "../supabase/functions/_shared/evidence-verifier.ts";

// 材料マッチング (DB・埋め込み・LLM) と参照レシピ検索 (DB) だけを差し替える。
// 栄養の積算 (nutrition-calculator-v2) と v4 アダプタ本体は本物を使う。
const { matchIngredientsMock, searchSimilarRecipesMock } = vi.hoisted(() => ({
  matchIngredientsMock: vi.fn(),
  searchSimilarRecipesMock: vi.fn(),
}));

vi.mock("../supabase/functions/_shared/ingredient-matcher.ts", () => ({
  matchIngredients: matchIngredientsMock,
}));

vi.mock("../supabase/functions/_shared/evidence-verifier.ts", () => ({
  searchSimilarRecipes: searchSimilarRecipesMock,
}));

describe("v4 nutrition adapter normalization", () => {
  it("treats standalone 米 in rice dishes as cooked ご飯", () => {
    const normalized = normalizeV4IngredientsForDish("ご飯", "rice", [
      { name: "米", amount_g: 150 },
    ]);

    expect(normalized).toEqual([
      { name: "ご飯", amount_g: 150 },
    ]);
  });

  it("keeps 米 untouched outside rice dishes", () => {
    const normalized = normalizeV4IngredientsForDish("炊き込みご飯の具", "main", [
      { name: "米", amount_g: 70 },
    ]);

    expect(normalized).toEqual([
      { name: "米", amount_g: 70 },
    ]);
  });

  it("converts dry rice with cooking water to cooked rice weight", () => {
    const normalized = normalizeV4IngredientsForDish("ご飯", "rice", [
      { name: "米", amount_g: 60 },
      { name: "水", amount_g: 140 },
    ]);

    expect(normalized).toEqual([
      { name: "ご飯", amount_g: 150 },
      { name: "水", amount_g: 140 },
    ]);
  });

  it("drops large stock liquids from nutrition calculation inputs", () => {
    const normalized = normalizeV4IngredientsForDish("野菜と豆腐の中華風スープ", "soup", [
      { name: "鶏ガラだし", amount_g: 180 },
      { name: "絹ごし豆腐", amount_g: 80 },
    ]);

    expect(normalized).toEqual([
      { name: "鶏ガラだし", amount_g: 0 },
      { name: "絹ごし豆腐", amount_g: 80 },
    ]);
  });
});

describe("ingredient exact maps", () => {
  it("pins菜の花 to the correct nabana dataset entry", () => {
    expect(EXACT_NAME_NORM_MAP["菜の花"]).toBe("なばな類和種なばな花らい茎生");
  });

  it("pins鶏ガラだし to the liquid stock dataset entry", () => {
    expect(EXACT_NAME_NORM_MAP["鶏ガラだし"]).toBe("＜調味料類＞だし類鶏がらだし");
  });
});

// #1146: 糖質 (sugar_g) = 炭水化物 − 食物繊維。AI が作った献立の糖質が常に 0g になっていた問題。
function makeMatchedData(overrides: Partial<MatchedIngredientData>): MatchedIngredientData {
  return {
    id: "ingredient-1",
    name: "テスト食材",
    name_norm: "テスト食材",
    calories_kcal: null,
    protein_g: null,
    fat_g: null,
    carbs_g: null,
    fiber_g: null,
    sodium_mg: null,
    potassium_mg: null,
    calcium_mg: null,
    magnesium_mg: null,
    phosphorus_mg: null,
    iron_mg: null,
    zinc_mg: null,
    iodine_ug: null,
    cholesterol_mg: null,
    vitamin_a_ug: null,
    vitamin_d_ug: null,
    vitamin_e_alpha_mg: null,
    vitamin_k_ug: null,
    vitamin_b1_mg: null,
    vitamin_b2_mg: null,
    niacin_mg: null,
    vitamin_b6_mg: null,
    vitamin_b12_ug: null,
    folic_acid_ug: null,
    pantothenic_acid_mg: null,
    biotin_ug: null,
    vitamin_c_mg: null,
    salt_eq_g: null,
    discard_rate_percent: null,
    similarity: 1,
    ...overrides,
  };
}

function matchResult(
  name: string,
  amount_g: number,
  matched: MatchedIngredientData | null,
): IngredientMatchResult {
  return {
    input: { name, amount_g },
    matched,
    confidence: matched ? "high" : "none",
    matchMethod: matched ? "exact_map" : "none",
  };
}

describe("v4 nutrition adapter: sugar_g (carbs - fiber)", () => {
  beforeEach(() => {
    matchIngredientsMock.mockReset();
    searchSimilarRecipesMock.mockReset();
  });

  it("carbs 50g / fiber 5g -> sugar 45g (and the legacy totals carry it)", async () => {
    matchIngredientsMock.mockResolvedValue([
      matchResult("パスタ", 100, makeMatchedData({ calories_kcal: 300, carbs_g: 50, fiber_g: 5 })),
    ]);

    const analysis = await analyzeNutritionFromIngredientsV4({} as never, "パスタ", "main", [
      { name: "パスタ", amount_g: 100 },
    ]);

    expect(analysis.calculatedNutrition.carbs_g).toBe(50);
    expect(analysis.calculatedNutrition.fiber_g).toBe(5);
    expect(analysis.calculatedNutrition.sugar_g).toBe(45);
    expect(analysis.ingredientMatches[0].calculated_sugar_g).toBeCloseTo(45, 5);
  });

  it("missing fiber -> sugar equals carbs (not 0)", async () => {
    matchIngredientsMock.mockResolvedValue([
      matchResult("白身魚のフライ", 100, makeMatchedData({ calories_kcal: 250, carbs_g: 50, fiber_g: null })),
    ]);

    const analysis = await analyzeNutritionFromIngredientsV4({} as never, "フライ", "main", [
      { name: "白身魚のフライ", amount_g: 100 },
    ]);

    expect(analysis.calculatedNutrition.fiber_g).toBe(0);
    expect(analysis.calculatedNutrition.sugar_g).toBe(50);
  });

  it("sums sugar per ingredient: a fiber-rich ingredient does not cancel the others", async () => {
    matchIngredientsMock.mockResolvedValue([
      matchResult("ご飯", 100, makeMatchedData({ id: "rice", calories_kcal: 150, carbs_g: 50, fiber_g: 5 })),
      matchResult("ひじき", 100, makeMatchedData({ id: "hijiki", calories_kcal: 20, carbs_g: 10, fiber_g: 30 })),
    ]);

    const analysis = await analyzeNutritionFromIngredientsV4({} as never, "ひじきご飯", "main", [
      { name: "ご飯", amount_g: 100 },
      { name: "ひじき", amount_g: 100 },
    ]);

    // 合計の 炭水化物 60 - 食物繊維 35 = 25 ではなく、材料ごとの 45 + 0
    expect(analysis.calculatedNutrition.sugar_g).toBe(45);
  });

  it("stays 0 when no ingredient matched (save-meal stores that as unknown, not 0g)", async () => {
    matchIngredientsMock.mockResolvedValue([matchResult("謎の食材", 100, null)]);

    const analysis = await analyzeNutritionFromIngredientsV4({} as never, "謎の料理", "main", [
      { name: "謎の食材", amount_g: 100 },
    ]);

    expect(analysis.calculatedNutrition.calories_kcal).toBe(0);
    expect(analysis.calculatedNutrition.carbs_g).toBe(0);
    expect(analysis.calculatedNutrition.sugar_g).toBe(0);
  });

  describe("validateAndAdjustNutritionV4 keeps sugar consistent with the adjusted carbs and fiber", () => {
    function reference(overrides: Partial<ReferenceRecipe>): ReferenceRecipe {
      return {
        id: "ref-1",
        name: "参照レシピ",
        name_norm: "参照レシピ",
        source_url: null,
        ingredients_text: null,
        calories_kcal: 400,
        protein_g: null,
        fat_g: null,
        carbs_g: null,
        sodium_g: null,
        similarity: 0.9,
        ...overrides,
      };
    }

    function lowCalorieNutrition() {
      return {
        ...emptyNutrition(),
        calories_kcal: 100,
        carbs_g: 20,
        fiber_g: 2,
        sugar_g: 18,
      };
    }

    it("recomputes sugar from the reference carbs when the reference replaces carbs", async () => {
      searchSimilarRecipesMock.mockResolvedValue([reference({ calories_kcal: 400, carbs_g: 60 })]);

      const result = await validateAndAdjustNutritionV4({} as never, "ご飯もの", lowCalorieNutrition());

      expect(result.appliedAdjustment).toBe(true);
      const adjusted = result.adjustedNutrition!;
      expect(adjusted.carbs_g).toBe(60); // 参照レシピの値に置き換わる
      expect(adjusted.fiber_g).toBe(8); // 2 * (400 / 100)
      expect(adjusted.sugar_g).toBe(52); // 60 - 8。単純にスケールした 18 * 4 = 72 (> 炭水化物) にはならない
      expect(adjusted.sugar_g).toBeLessThanOrEqual(adjusted.carbs_g);
    });

    it("scales sugar together with carbs and fiber when the reference has no carbs", async () => {
      searchSimilarRecipesMock.mockResolvedValue([reference({ calories_kcal: 400, carbs_g: null })]);

      const result = await validateAndAdjustNutritionV4({} as never, "ご飯もの", lowCalorieNutrition());

      const adjusted = result.adjustedNutrition!;
      expect(adjusted.carbs_g).toBe(80); // 20 * 4
      expect(adjusted.fiber_g).toBe(8); // 2 * 4
      expect(adjusted.sugar_g).toBe(72); // (20 - 2) * 4
    });

    it("never goes negative when the scaled fiber exceeds the reference carbs", async () => {
      searchSimilarRecipesMock.mockResolvedValue([reference({ calories_kcal: 400, carbs_g: 5 })]);

      const result = await validateAndAdjustNutritionV4({} as never, "ご飯もの", lowCalorieNutrition());

      expect(result.adjustedNutrition!.fiber_g).toBe(8);
      expect(result.adjustedNutrition!.sugar_g).toBe(0);
    });

    it("leaves the calculated sugar untouched when no adjustment is needed", async () => {
      searchSimilarRecipesMock.mockResolvedValue([reference({ calories_kcal: 120, carbs_g: 22 })]);

      const calculated = lowCalorieNutrition();
      const result = await validateAndAdjustNutritionV4({} as never, "ご飯もの", calculated);

      expect(result.appliedAdjustment).toBe(false);
      expect(result.adjustedNutrition).toBeNull();
      expect(calculated.sugar_g).toBe(18);
    });
  });
});
