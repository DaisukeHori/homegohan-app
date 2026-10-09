import { describe, expect, it } from "vitest";

import { addNutritionFromMatch, emptyNutrition } from "../supabase/functions/_shared/nutrition-calculator.ts";
import {
  calculateDishNutrition,
  calculateIngredientNutrition,
  calculateMealNutrition,
  initNutritionTotals,
  roundNutrition,
  sumNutrition,
  DishNutrition,
} from "../supabase/functions/_shared/nutrition-calculator-v2.ts";
import type { IngredientMatchResult, MatchedIngredientData } from "../supabase/functions/_shared/ingredient-matcher.ts";

function makeMatched(overrides: Partial<MatchedIngredientData>): MatchedIngredientData {
  return {
    id: "id-1",
    name: "test-ingredient",
    name_norm: "test-ingredient",
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

// #1046 F5-11: nutrition-calculator.ts(v1) が discard_rate_percent(廃棄率)を無視し、
// v2(discard_rate_percent 適用)と結果が食い違っていた問題の回帰テスト。
// 受入基準: 「廃棄率20%の食材でv1/v2が同一値」
describe("#1046 F5-11: discard rate parity between v1 and v2", () => {
  const matched = makeMatched({
    calories_kcal: 50,
    protein_g: 5,
    fat_g: 2,
    carbs_g: 10,
    fiber_g: 1,
    potassium_mg: 200,
    calcium_mg: 20,
    phosphorus_mg: 30,
    magnesium_mg: 10,
    iron_mg: 1,
    zinc_mg: 0.5,
    iodine_ug: 5,
    cholesterol_mg: 4,
    vitamin_a_ug: 100,
    vitamin_b1_mg: 0.1,
    vitamin_b2_mg: 0.2,
    vitamin_b6_mg: 0.3,
    vitamin_b12_ug: 0.4,
    vitamin_c_mg: 10,
    vitamin_d_ug: 0.6,
    vitamin_e_alpha_mg: 1,
    vitamin_k_ug: 5,
    folic_acid_ug: 20,
    discard_rate_percent: 20, // 廃棄率20%
  });
  const amount_g = 200;

  it("v1 addNutritionFromMatch applies the discard rate (effective amount = 160g, factor 1.6)", () => {
    const totals = emptyNutrition();
    addNutritionFromMatch(totals, matched, amount_g);

    // 200g * (1 - 20/100) = 160g -> factor = 1.6
    expect(totals.calories_kcal).toBeCloseTo(50 * 1.6, 5);
    expect(totals.protein_g).toBeCloseTo(5 * 1.6, 5);
    expect(totals.potassium_mg).toBeCloseTo(200 * 1.6, 5);
  });

  it("v1 and v2 produce identical values for the same 20%-discard ingredient", () => {
    const v1Totals = emptyNutrition();
    addNutritionFromMatch(v1Totals, matched, amount_g);

    const matchResult: IngredientMatchResult = {
      input: { name: "test-ingredient", amount_g },
      matched,
      confidence: "high",
      matchMethod: "exact_map",
    };
    const v2Ingredient = calculateIngredientNutrition(matchResult);

    // v1/v2 で共通に計算しているフィールドはすべて一致するはず
    expect(v2Ingredient.nutrition.calories_kcal).toBeCloseTo(v1Totals.calories_kcal, 5);
    expect(v2Ingredient.nutrition.protein_g).toBeCloseTo(v1Totals.protein_g, 5);
    expect(v2Ingredient.nutrition.fat_g).toBeCloseTo(v1Totals.fat_g, 5);
    expect(v2Ingredient.nutrition.carbs_g).toBeCloseTo(v1Totals.carbs_g, 5);
    expect(v2Ingredient.nutrition.fiber_g).toBeCloseTo(v1Totals.fiber_g, 5);
    expect(v2Ingredient.nutrition.potassium_mg).toBeCloseTo(v1Totals.potassium_mg, 5);
    expect(v2Ingredient.nutrition.calcium_mg).toBeCloseTo(v1Totals.calcium_mg, 5);
    expect(v2Ingredient.nutrition.phosphorus_mg).toBeCloseTo(v1Totals.phosphorus_mg, 5);
    expect(v2Ingredient.nutrition.magnesium_mg).toBeCloseTo(v1Totals.magnesium_mg, 5);
    expect(v2Ingredient.nutrition.iron_mg).toBeCloseTo(v1Totals.iron_mg, 5);
    expect(v2Ingredient.nutrition.zinc_mg).toBeCloseTo(v1Totals.zinc_mg, 5);
    expect(v2Ingredient.nutrition.iodine_ug).toBeCloseTo(v1Totals.iodine_ug, 5);
    expect(v2Ingredient.nutrition.cholesterol_mg).toBeCloseTo(v1Totals.cholesterol_mg, 5);
    expect(v2Ingredient.nutrition.vitamin_a_ug).toBeCloseTo(v1Totals.vitamin_a_ug, 5);
    expect(v2Ingredient.nutrition.vitamin_b1_mg).toBeCloseTo(v1Totals.vitamin_b1_mg, 5);
    expect(v2Ingredient.nutrition.vitamin_b2_mg).toBeCloseTo(v1Totals.vitamin_b2_mg, 5);
    expect(v2Ingredient.nutrition.vitamin_b6_mg).toBeCloseTo(v1Totals.vitamin_b6_mg, 5);
    expect(v2Ingredient.nutrition.vitamin_b12_ug).toBeCloseTo(v1Totals.vitamin_b12_ug, 5);
    expect(v2Ingredient.nutrition.vitamin_c_mg).toBeCloseTo(v1Totals.vitamin_c_mg, 5);
    expect(v2Ingredient.nutrition.vitamin_d_ug).toBeCloseTo(v1Totals.vitamin_d_ug, 5);
    expect(v2Ingredient.nutrition.vitamin_e_mg).toBeCloseTo(v1Totals.vitamin_e_mg, 5);
    expect(v2Ingredient.nutrition.vitamin_k_ug).toBeCloseTo(v1Totals.vitamin_k_ug, 5);
    expect(v2Ingredient.nutrition.folic_acid_ug).toBeCloseTo(v1Totals.folic_acid_ug, 5);
  });

  it("v1 treats a missing discard_rate_percent as 0% (no correction)", () => {
    const noDiscard = makeMatched({ calories_kcal: 50, discard_rate_percent: null });
    const totals = emptyNutrition();
    addNutritionFromMatch(totals, noDiscard, 200);
    expect(totals.calories_kcal).toBeCloseTo(100, 5); // 50 * 200/100, no correction
  });

  it("v1 parses a string-typed discard_rate_percent (Postgrest numeric column quirk)", () => {
    const stringDiscount = makeMatched({ calories_kcal: 50, discard_rate_percent: "20" as unknown as number });
    const totals = emptyNutrition();
    addNutritionFromMatch(totals, stringDiscount, 200);
    expect(totals.calories_kcal).toBeCloseTo(50 * 1.6, 5);
  });
});

// #1046 F5-12: calculateDishNutrition が丸めた値を calculateMealNutrition が
// 再度合算・丸めしていた二重丸め問題の回帰テスト。
// 受入基準: 「10品合成テストで生値合算→最終丸めと一致」
describe("#1046 F5-12: no double rounding when aggregating multiple dishes", () => {
  it("meal totals match raw-sum-then-round-once across 10 dishes (not round-then-sum-then-round)", () => {
    // 100gあたり vitamin_b1_mg=1.2mg の食材を 2g 使う 1皿 -> raw = 0.024mg
    const matched = makeMatched({ vitamin_b1_mg: 1.2 });
    const matchResult: IngredientMatchResult = {
      input: { name: "test", amount_g: 2 },
      matched,
      confidence: "high",
      matchMethod: "exact_map",
    };

    const dishes: DishNutrition[] = Array.from({ length: 10 }, (_, i) =>
      calculateDishNutrition(`dish-${i}`, "side", [matchResult])
    );

    // 各皿の丸め済み totals は round2(0.024) = 0.02 になる(二重丸めバグの温床)
    expect(dishes[0].totals.vitamin_b1_mg).toBe(0.02);
    // 生値(rawTotals)は丸められていない
    expect(dishes[0].rawTotals.vitamin_b1_mg).toBeCloseTo(0.024, 5);

    const meal = calculateMealNutrition(dishes);

    // 正しい計算: raw合算 10*0.024=0.24 -> 最終丸め1回 = 0.24
    expect(meal.totals.vitamin_b1_mg).toBe(0.24);

    // 誤ったロジック(丸め済みtotalsを合算)だと 10*0.02=0.20 になり、
    // 正しい値(0.24)とズレることを明示的に確認する
    const doubleRoundedSum = dishes.reduce((sum, d) => sum + d.totals.vitamin_b1_mg, 0);
    expect(doubleRoundedSum).toBeCloseTo(0.2, 5);
    expect(meal.totals.vitamin_b1_mg).not.toBeCloseTo(doubleRoundedSum, 5);
  });

  it("matches manually summing rawTotals and rounding once (contract check)", () => {
    const matched = makeMatched({ zinc_mg: 0.37 });
    const matchResult: IngredientMatchResult = {
      input: { name: "test", amount_g: 33 },
      matched,
      confidence: "high",
      matchMethod: "exact_map",
    };
    const dishes: DishNutrition[] = Array.from({ length: 7 }, (_, i) =>
      calculateDishNutrition(`dish-${i}`, "side", [matchResult])
    );

    const expectedRaw = dishes.reduce(
      (sum, d) => sumNutrition(sum, d.rawTotals),
      initNutritionTotals()
    );
    const expectedRounded = roundNutrition(expectedRaw);

    const meal = calculateMealNutrition(dishes);
    expect(meal.totals.zinc_mg).toBe(expectedRounded.zinc_mg);
  });
});

// #1146: 糖質 (sugar_g) を 炭水化物 − 食物繊維 で計算する。
// 食材 DB (dataset_ingredients) には糖質の列が無く、AI が作った献立の糖質が常に 0g と表示されていた。
describe("#1146: sugar_g = carbs_g - fiber_g (per ingredient, floored at 0)", () => {
  function nutritionOf(overrides: Partial<MatchedIngredientData>, amount_g = 100) {
    const matchResult: IngredientMatchResult = {
      input: { name: "test-ingredient", amount_g },
      matched: makeMatched(overrides),
      confidence: "high",
      matchMethod: "exact_map",
    };
    return calculateIngredientNutrition(matchResult).nutrition;
  }

  it("starts from 0 in both calculators", () => {
    expect(initNutritionTotals().sugar_g).toBe(0);
    expect(emptyNutrition().sugar_g).toBe(0);
  });

  it("carbs 50g / fiber 5g per 100g -> sugar 45g", () => {
    const n = nutritionOf({ carbs_g: 50, fiber_g: 5 });
    expect(n.carbs_g).toBeCloseTo(50, 5);
    expect(n.fiber_g).toBeCloseTo(5, 5);
    expect(n.sugar_g).toBeCloseTo(45, 5);
  });

  it("treats a missing fiber value as 0, so sugar equals carbs", () => {
    expect(nutritionOf({ carbs_g: 50, fiber_g: null }).sugar_g).toBeCloseTo(50, 5);
  });

  it("is 0 when carbs is missing (nothing to compute from)", () => {
    expect(nutritionOf({ carbs_g: null, fiber_g: 3 }).sugar_g).toBe(0);
    expect(nutritionOf({ carbs_g: null, fiber_g: null }).sugar_g).toBe(0);
  });

  it("never goes negative when fiber is larger than carbs (seaweed, agar)", () => {
    expect(nutritionOf({ carbs_g: 10, fiber_g: 30 }).sugar_g).toBe(0);
  });

  it("scales with the amount and the discard rate (200g, 20% discard -> factor 1.6)", () => {
    const n = nutritionOf({ carbs_g: 50, fiber_g: 5, discard_rate_percent: 20 }, 200);
    expect(n.sugar_g).toBeCloseTo(45 * 1.6, 5);
    expect(n.sugar_g).toBeCloseTo(n.carbs_g - n.fiber_g, 5);
  });

  it("sums per-ingredient sugar (a fiber-rich ingredient does not cancel the others)", () => {
    const rice = makeMatched({ id: "rice", carbs_g: 50, fiber_g: 5 }); // sugar 45
    const seaweed = makeMatched({ id: "seaweed", carbs_g: 10, fiber_g: 30 }); // sugar 0 (not -20)
    const dish = calculateDishNutrition("dish", "main", [
      { input: { name: "rice", amount_g: 100 }, matched: rice, confidence: "high", matchMethod: "exact_map" },
      { input: { name: "seaweed", amount_g: 100 }, matched: seaweed, confidence: "high", matchMethod: "exact_map" },
    ]);

    // 合計の 炭水化物(60) - 食物繊維(35) = 25 ではなく、材料ごとの 45 + 0 になる
    expect(dish.rawTotals.carbs_g).toBeCloseTo(60, 5);
    expect(dish.rawTotals.fiber_g).toBeCloseTo(35, 5);
    expect(dish.rawTotals.sugar_g).toBeCloseTo(45, 5);
    expect(dish.totals.sugar_g).toBe(45);
  });

  it("sumNutrition adds sugar_g and roundNutrition rounds it to 1 decimal", () => {
    const a = { ...initNutritionTotals(), sugar_g: 10.04 };
    const b = { ...initNutritionTotals(), sugar_g: 5.02 };
    expect(sumNutrition(a, b).sugar_g).toBeCloseTo(15.06, 5);
    expect(roundNutrition(sumNutrition(a, b)).sugar_g).toBe(15.1);
  });

  it("meal totals sum raw dish sugar and round once (no double rounding)", () => {
    // 100g あたり 糖質 0.04g の食材を 1品 100g 使う = 各品 0.04g (丸めると 0.0)
    const matched = makeMatched({ carbs_g: 0.04, fiber_g: 0 });
    const dishes = Array.from({ length: 10 }, (_, i) =>
      calculateDishNutrition(`dish-${i}`, "side", [
        { input: { name: "test", amount_g: 100 }, matched, confidence: "high", matchMethod: "exact_map" },
      ])
    );
    expect(dishes[0].totals.sugar_g).toBe(0);
    expect(calculateMealNutrition(dishes).totals.sugar_g).toBe(0.4);
  });

  it("v1 addNutritionFromMatch and v2 give the same sugar (incl. discard rate and string values)", () => {
    const matched = makeMatched({ carbs_g: 50, fiber_g: 5, discard_rate_percent: 20 });
    const v1 = emptyNutrition();
    addNutritionFromMatch(v1, matched, 200);
    expect(v1.sugar_g).toBeCloseTo(45 * 1.6, 5);
    expect(v1.sugar_g).toBeCloseTo(nutritionOf({ carbs_g: 50, fiber_g: 5, discard_rate_percent: 20 }, 200).sugar_g, 5);

    // PostgREST の numeric 列は文字列で返ることがある
    const v1String = emptyNutrition();
    addNutritionFromMatch(v1String, { ...matched, carbs_g: "50", fiber_g: "5" }, 100);
    expect(v1String.sugar_g).toBeCloseTo(36, 5); // 45 * 0.8 (廃棄率 20%)

    // 食物繊維が欠けていても、炭水化物がそのまま糖質になる
    const v1MissingFiber = emptyNutrition();
    addNutritionFromMatch(v1MissingFiber, makeMatched({ carbs_g: 50, fiber_g: null }), 100);
    expect(v1MissingFiber.sugar_g).toBeCloseTo(50, 5);
  });
});
