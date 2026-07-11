import { describe, expect, it } from "vitest";

import { aggregateIngredientOccurrences } from "../supabase/functions/_shared/shopping-list-aggregation.ts";

// #1046 F5-13: 同名材料の分量合算は関数側で確定させ、LLMのプロンプト任せにしない。

describe("aggregateIngredientOccurrences", () => {
  it("sums grams for the same ingredient across multiple occurrences", () => {
    // 受入基準: 「玉ねぎ100g×3」で出力が300g
    const result = aggregateIngredientOccurrences([
      { name: "玉ねぎ", amount_g: 100 },
      { name: "玉ねぎ", amount_g: 100 },
      { name: "玉ねぎ", amount_g: 100 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "玉ねぎ", amount: "300g", count: 3 });
  });

  it("sums differing gram amounts for the same ingredient (200g + 300g -> 500g)", () => {
    const result = aggregateIngredientOccurrences([
      { name: "にんじん", amount_g: 200 },
      { name: "にんじん", amount_g: 300 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "にんじん", amount: "500g", count: 2 });
  });

  it("keeps different ingredient names as separate entries", () => {
    const result = aggregateIngredientOccurrences([
      { name: "玉ねぎ", amount_g: 100 },
      { name: "にんじん", amount_g: 50 },
    ]);

    expect(result).toHaveLength(2);
    const names = result.map((r) => r.name).sort();
    expect(names).toEqual(["にんじん", "玉ねぎ"]);
  });

  it("keeps amount null for zero/unknown-amount ingredients (e.g. 適量) without treating them as 0g", () => {
    const result = aggregateIngredientOccurrences([
      { name: "塩", amount_g: 0 },
      { name: "塩", amount_g: 0 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "塩", amount: null, count: 2 });
  });

  it("trims whitespace and drops empty names", () => {
    const result = aggregateIngredientOccurrences([
      { name: "  玉ねぎ  ", amount_g: 100 },
      { name: "   ", amount_g: 50 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("玉ねぎ");
  });
});
