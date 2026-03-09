import { describe, expect, it } from "vitest";

import {
  EXACT_NAME_NORM_MAP,
  INGREDIENT_ALIASES,
  normalizeIngredientNameJs,
} from "../supabase/functions/_shared/nutrition-calculator.ts";

describe("ingredient matcher safety nets", () => {
  it("keeps exact-map coverage for high-frequency Japanese ingredient inputs", () => {
    expect(EXACT_NAME_NORM_MAP["たまねぎ"]).toBe("たまねぎ類たまねぎりん茎生");
    expect(EXACT_NAME_NORM_MAP["玉ねぎ"]).toBe("たまねぎ類たまねぎりん茎生");
    expect(EXACT_NAME_NORM_MAP["鶏むね肉"]).toBe("＜鳥肉類＞にわとり［若どり主品目］むね皮つき生");
    expect(EXACT_NAME_NORM_MAP["白ご飯"]).toBe("こめ［水稲めし］精白米うるち米");
  });

  it("keeps alias coverage for ingredient names that often need fallback help", () => {
    expect(INGREDIENT_ALIASES["たまねぎ"]).toContain("玉ねぎ");
    expect(INGREDIENT_ALIASES["鶏むね肉"]).toContain("鶏肉 むね");
    expect(INGREDIENT_ALIASES["鶏むね肉"]).toContain("若どり むね 皮なし");
  });

  it("normalizes common ingredient strings the same way as the matcher path", () => {
    expect(normalizeIngredientNameJs(" 白ご飯 ")).toBe("白ご飯");
    expect(normalizeIngredientNameJs("鶏むね肉（皮なし）")).toBe("鶏むね肉皮なし");
    expect(normalizeIngredientNameJs("たま・ねぎ")).toBe("たまねぎ");
  });
});
