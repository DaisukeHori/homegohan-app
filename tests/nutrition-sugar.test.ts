/**
 * #1146: 糖質 (sugar_g) の定義 = 炭水化物 − 食物繊維 (supabase/functions/_shared/nutrition-sugar.ts)
 */
import { describe, expect, it } from "vitest";

import { calcSugarG, resolveRecipeSugarG } from "../supabase/functions/_shared/nutrition-sugar.ts";

describe("calcSugarG", () => {
  it("炭水化物 50g / 食物繊維 5g -> 45g", () => {
    expect(calcSugarG(50, 5)).toBe(45);
  });

  it("食物繊維が未登録 (null / undefined) のときは 0 として扱い、炭水化物をそのまま返す", () => {
    expect(calcSugarG(50, null)).toBe(50);
    expect(calcSugarG(50, undefined)).toBe(50);
  });

  it("炭水化物が未登録のときは 0", () => {
    expect(calcSugarG(null, 5)).toBe(0);
    expect(calcSugarG(undefined, undefined)).toBe(0);
  });

  it("食物繊維が炭水化物より多くても負にならない", () => {
    expect(calcSugarG(10, 30)).toBe(0);
    expect(calcSugarG(25, 25)).toBe(0);
  });

  it("DB から文字列で返る numeric も計算できる", () => {
    expect(calcSugarG("50", "5")).toBe(45);
    expect(calcSugarG("12.5", null)).toBe(12.5);
  });

  it("数値でない値 (NaN・Infinity・文字) は 0 として扱う", () => {
    expect(calcSugarG(Number.NaN, 5)).toBe(0);
    expect(calcSugarG(50, Number.NaN)).toBe(50);
    expect(calcSugarG("abc", "def")).toBe(0);
    expect(calcSugarG(Number.POSITIVE_INFINITY, 5)).toBe(0);
  });
});

describe("resolveRecipeSugarG (dataset_recipes の 1 行)", () => {
  it("行に sugar_g があればそれを使う", () => {
    expect(resolveRecipeSugarG({ sugar_g: 40, carbs_g: 50, fiber_g: 5 })).toBe(40);
    expect(resolveRecipeSugarG({ sugar_g: 0, carbs_g: 50, fiber_g: 5 })).toBe(0);
    expect(resolveRecipeSugarG({ sugar_g: "41.5", carbs_g: 50, fiber_g: 5 })).toBe(41.5);
  });

  it("sugar_g が無ければ 炭水化物 − 食物繊維 で求める", () => {
    expect(resolveRecipeSugarG({ sugar_g: null, carbs_g: 50, fiber_g: 5 })).toBe(45);
    expect(resolveRecipeSugarG({ carbs_g: 50 })).toBe(50);
  });

  it("sugar_g が負や数値でないときも 炭水化物 − 食物繊維 に戻る", () => {
    expect(resolveRecipeSugarG({ sugar_g: -3, carbs_g: 50, fiber_g: 5 })).toBe(45);
    expect(resolveRecipeSugarG({ sugar_g: "abc", carbs_g: 50, fiber_g: 5 })).toBe(45);
  });

  it("何も無ければ 0", () => {
    expect(resolveRecipeSugarG({})).toBe(0);
  });
});
