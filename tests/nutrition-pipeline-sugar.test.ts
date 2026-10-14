/**
 * #1146: 食事写真の栄養分析 (nutrition-pipeline) でも、v2 の NutritionTotals に増えた sugar_g を
 * 倍率の換算・AI 推定値の上書きで取りこぼさない (NaN や、炭水化物・食物繊維と食い違う糖質にならない) ことを確かめる。
 */
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  initNutritionTotals,
  roundNutrition,
  type DishNutrition,
  type NutritionTotals,
} from "../supabase/functions/_shared/nutrition-calculator-v2.ts";

// nutrition-pipeline.ts は読み込み時に Deno.env を読む。外部サービスに繋がる依存は差し替える。
vi.stubGlobal("Deno", { env: { get: () => undefined } });
vi.mock("../supabase/functions/_shared/ingredient-matcher.ts", () => ({
  matchIngredients: vi.fn(),
  calculateMatchingStats: vi.fn(),
}));
vi.mock("../supabase/functions/_shared/evidence-verifier.ts", () => ({
  verifyNutrition: vi.fn(),
  createEvidenceInfo: vi.fn(),
  applyCalorieCorrection: vi.fn(),
}));
vi.mock("../supabase/functions/_shared/gemini-json.ts", () => ({
  generateGeminiJson: vi.fn(),
}));
vi.mock("../supabase/functions/_shared/perplexity-nutrition.ts", () => ({
  estimateNutritionWithPerplexity: vi.fn(),
  isPerplexityNutritionCandidate: vi.fn(),
}));

afterAll(() => {
  vi.unstubAllGlobals();
});

const {
  applyDishNutritionCalibration,
  overlayEstimatedTopLineNutrition,
  scaleNutritionTotalsRaw,
  totalsFromEstimatedNutritionRaw,
} = await import("../supabase/functions/_shared/nutrition-pipeline.ts");

function dishNutritionOf(rawTotals: NutritionTotals): DishNutrition {
  return {
    name: "テスト料理",
    role: "main",
    ingredients: [],
    totals: roundNutrition(rawTotals),
    rawTotals,
  };
}

describe("nutrition-pipeline: sugar_g (#1146)", () => {
  it("scaleNutritionTotalsRaw は糖質も倍率で換算する", () => {
    const raw = { ...initNutritionTotals(), carbs_g: 50, fiber_g: 5, sugar_g: 45 };

    const scaled = scaleNutritionTotalsRaw(raw, 1.5);

    expect(scaled.sugar_g).toBeCloseTo(67.5, 5);
    expect(roundNutrition(scaled).sugar_g).toBe(67.5);
  });

  it("totalsFromEstimatedNutritionRaw は推定した炭水化物 − 食物繊維 を糖質にする", () => {
    const totals = totalsFromEstimatedNutritionRaw({
      calories_kcal: 520,
      protein_g: 20,
      fat_g: 15,
      carbs_g: 60,
      fiber_g: 5,
      salt_eq_g: 2,
      confidence: "high",
    });

    expect(totals.carbs_g).toBe(60);
    expect(totals.fiber_g).toBe(5);
    expect(totals.sugar_g).toBe(55);
  });

  it("推定した食物繊維が炭水化物より多くても糖質は負にならない", () => {
    const totals = totalsFromEstimatedNutritionRaw({
      calories_kcal: 40,
      protein_g: 2,
      fat_g: 0,
      carbs_g: 4,
      fiber_g: 6,
      salt_eq_g: 0,
      confidence: "medium",
    });

    expect(totals.sugar_g).toBe(0);
  });

  it("overlayEstimatedTopLineNutrition: 炭水化物・食物繊維を AI 推定値で上書きしたら、糖質もその値から求め直す", () => {
    // 材料から計算した値は 炭水化物 20 / 食物繊維 2 / 糖質 18
    const ingredientBased = dishNutritionOf({
      ...initNutritionTotals(),
      calories_kcal: 200,
      carbs_g: 20,
      fiber_g: 2,
      sugar_g: 18,
    });

    const overlaid = overlayEstimatedTopLineNutrition(ingredientBased, {
      calories_kcal: 520,
      protein_g: 20,
      fat_g: 15,
      carbs_g: 60,
      fiber_g: 5,
      salt_eq_g: 2,
      confidence: "high",
    });

    expect(overlaid.rawTotals.carbs_g).toBe(60);
    expect(overlaid.rawTotals.fiber_g).toBe(5);
    expect(overlaid.rawTotals.sugar_g).toBe(55); // 18 のまま残らない
    expect(overlaid.totals.sugar_g).toBe(55);
  });

  it("applyDishNutritionCalibration: 補正の倍率が糖質にもかかり、NaN にならない", () => {
    // 120g の主菜が 600kcal = 500kcal/100g (密度の上限を大きく超える) -> 倍率の下限 0.5 まで補正される
    const dish = {
      name: "ステーキ",
      role: "main",
      cookingMethod: "grilled",
      visiblePortionWeightG: 120,
      visibleIngredients: [],
      estimatedIngredients: [],
    } as never;
    const dishNutrition = dishNutritionOf({
      ...initNutritionTotals(),
      calories_kcal: 600,
      carbs_g: 40,
      fiber_g: 4,
      sugar_g: 36,
    });

    const { dishNutrition: calibrated, factor } = applyDishNutritionCalibration(dish, dishNutrition);

    expect(factor).toBeLessThan(1);
    expect(calibrated.rawTotals.sugar_g).toBeCloseTo(36 * factor, 5);
    expect(Number.isNaN(calibrated.totals.sugar_g)).toBe(false);
    expect(calibrated.totals.sugar_g).toBeCloseTo(36 * factor, 0);
  });
});
