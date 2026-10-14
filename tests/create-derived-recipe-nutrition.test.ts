/**
 * #1146: 派生レシピ (create-derived-recipe) の糖質 (sugar_g) が 0 固定だった問題
 *
 * 食材 DB に糖質の列が無いことを理由に、derived_recipes.sugar_g には常に 0 が保存されていた。
 * 炭水化物 − 食物繊維 を食材ごとに計算して合算し、保存できるデータが無いときは 0 ではなく null にする。
 */
import { describe, expect, it } from "vitest";

import {
  addScaled,
  emptyTotals,
  hasSugarData,
  type MatchedIngredientNutrients,
} from "../supabase/functions/create-derived-recipe/nutrition-totals.ts";

function matched(overrides: Partial<MatchedIngredientNutrients>): MatchedIngredientNutrients {
  return {
    calories_kcal: null,
    protein_g: null,
    fat_g: null,
    carbs_g: null,
    fiber_g: null,
    salt_eq_g: null,
    potassium_mg: null,
    calcium_mg: null,
    phosphorus_mg: null,
    iron_mg: null,
    zinc_mg: null,
    iodine_ug: null,
    cholesterol_mg: null,
    vitamin_b1_mg: null,
    vitamin_b2_mg: null,
    vitamin_b6_mg: null,
    vitamin_b12_ug: null,
    folic_acid_ug: null,
    vitamin_c_mg: null,
    vitamin_a_ug: null,
    vitamin_d_ug: null,
    vitamin_k_ug: null,
    vitamin_e_alpha_mg: null,
    ...overrides,
  };
}

describe("create-derived-recipe: 糖質 (sugar_g) = 炭水化物 − 食物繊維 (#1146)", () => {
  it("合計は 0 から始まる", () => {
    expect(emptyTotals().sugar_g).toBe(0);
  });

  it("100g あたり 炭水化物 50g / 食物繊維 5g の食材を 100g 使うと 糖質 45g", () => {
    const totals = emptyTotals();
    addScaled(totals, matched({ carbs_g: 50, fiber_g: 5 }), 100);

    expect(totals.carbs_g).toBeCloseTo(50, 5);
    expect(totals.fiber_g).toBeCloseTo(5, 5);
    expect(totals.sugar_g).toBeCloseTo(45, 5);
  });

  it("使用量に応じて換算する (250g -> 112.5g)", () => {
    const totals = emptyTotals();
    addScaled(totals, matched({ carbs_g: 50, fiber_g: 5 }), 250);

    expect(totals.sugar_g).toBeCloseTo(112.5, 5);
  });

  it("食物繊維が未登録の食材は 炭水化物 = 糖質 として扱う", () => {
    const totals = emptyTotals();
    addScaled(totals, matched({ carbs_g: 50, fiber_g: null }), 100);

    expect(totals.fiber_g).toBe(0);
    expect(totals.sugar_g).toBeCloseTo(50, 5);
  });

  it("炭水化物が未登録の食材は糖質に加算しない (ほかの栄養素は加算する)", () => {
    const totals = emptyTotals();
    addScaled(totals, matched({ calories_kcal: 200, protein_g: 20, carbs_g: null, fiber_g: 3 }), 100);

    expect(totals.calories_kcal).toBeCloseTo(200, 5);
    expect(totals.protein_g).toBeCloseTo(20, 5);
    expect(totals.sugar_g).toBe(0);
  });

  it("食物繊維が炭水化物より多い食材 (海藻など) は 0 で下限をとり、他の食材の糖質を打ち消さない", () => {
    const totals = emptyTotals();
    addScaled(totals, matched({ carbs_g: 50, fiber_g: 5 }), 100); // 糖質 45
    addScaled(totals, matched({ carbs_g: 10, fiber_g: 30 }), 100); // 糖質 0 (-20 にはしない)

    // 合計の 炭水化物 60 - 食物繊維 35 = 25 ではなく、食材ごとの 45 + 0
    expect(totals.carbs_g).toBeCloseTo(60, 5);
    expect(totals.fiber_g).toBeCloseTo(35, 5);
    expect(totals.sugar_g).toBeCloseTo(45, 5);
  });

  it("これまで計算していた栄養素は変わらない", () => {
    const totals = emptyTotals();
    addScaled(
      totals,
      matched({ calories_kcal: 100, salt_eq_g: 2, vitamin_e_alpha_mg: 1.5, carbs_g: 20, fiber_g: 2 }),
      200,
    );

    expect(totals.calories_kcal).toBeCloseTo(200, 5);
    expect(totals.sodium_g).toBeCloseTo(4, 5);
    expect(totals.vitamin_e_mg).toBeCloseTo(3, 5);
    expect(totals.sugar_g).toBeCloseTo(36, 5);
  });

  it("食材が当たらなかった (matched = null) ときは何も加算しない", () => {
    const totals = emptyTotals();
    addScaled(totals, null, 100);

    expect(totals).toEqual(emptyTotals());
  });

  describe("hasSugarData: 糖質を保存できるか (できなければ 0g ではなく null にする)", () => {
    it("炭水化物のデータがある食材が 1 つでも当たっていれば true", () => {
      expect(
        hasSugarData([
          { skip: false, matched: { carbs_g: 30 } },
          { skip: false, matched: null },
        ]),
      ).toBe(true);
      // 炭水化物 0g は「データあり」(肉・魚など)
      expect(hasSugarData([{ skip: false, matched: { carbs_g: 0 } }])).toBe(true);
    });

    it("1 つも当たらなかった、または当たった食材に炭水化物のデータが無いときは false", () => {
      expect(hasSugarData([])).toBe(false);
      expect(hasSugarData([{ skip: false, matched: null }])).toBe(false);
      expect(hasSugarData([{ skip: false, matched: { carbs_g: null } }])).toBe(false);
    });

    it("水など栄養計算の対象外にした食材 (skip) は数えない", () => {
      expect(hasSugarData([{ skip: true, matched: { carbs_g: 30 } }])).toBe(false);
    });
  });
});
