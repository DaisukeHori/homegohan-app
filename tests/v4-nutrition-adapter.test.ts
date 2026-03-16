import { describe, expect, it } from "vitest";

import { normalizeV4IngredientsForDish } from "../supabase/functions/_shared/v4-nutrition-adapter.ts";

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
});
