import { describe, expect, it } from "vitest";

import { normalizeV4IngredientsForDish } from "../supabase/functions/_shared/v4-nutrition-adapter.ts";
import { EXACT_NAME_NORM_MAP } from "../supabase/functions/_shared/nutrition-calculator.ts";

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
