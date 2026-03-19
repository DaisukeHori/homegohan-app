import { describe, expect, it } from "vitest";

import { validateGeneratedMeals } from "../supabase/functions/generate-menu-v5/diversity-validator";

describe("V5 diversity validator", () => {
  it("flags same-day and exact-duplicate violations", () => {
    const result = validateGeneratedMeals({
      targetSlots: [
        { date: "2026-03-18", mealType: "lunch" },
        { date: "2026-03-18", mealType: "dinner" },
        { date: "2026-03-19", mealType: "breakfast" },
        { date: "2026-03-20", mealType: "breakfast" },
      ],
      generatedMeals: {
        "2026-03-18:lunch": {
          mealType: "lunch",
          dishes: [
            { name: "鶏の照り焼き", role: "main", ingredients: [], instructions: [] },
            { name: "味噌汁", role: "soup", ingredients: [], instructions: [] },
            { name: "ご飯", role: "rice", ingredients: [], instructions: [] },
          ],
        },
        "2026-03-18:dinner": {
          mealType: "dinner",
          dishes: [
            { name: "鶏の照り焼き", role: "main", ingredients: [], instructions: [] },
            { name: "味噌汁", role: "soup", ingredients: [], instructions: [] },
            { name: "ご飯", role: "rice", ingredients: [], instructions: [] },
          ],
        },
        "2026-03-19:breakfast": {
          mealType: "breakfast",
          dishes: [
            { name: "鮭の塩焼き", role: "main", ingredients: [], instructions: [] },
            { name: "味噌汁", role: "soup", ingredients: [], instructions: [] },
            { name: "ご飯", role: "rice", ingredients: [], instructions: [] },
          ],
        },
        "2026-03-20:breakfast": {
          mealType: "breakfast",
          dishes: [
            { name: "鮭の塩焼き", role: "main", ingredients: [], instructions: [] },
            { name: "味噌汁", role: "soup", ingredients: [], instructions: [] },
            { name: "ご飯", role: "rice", ingredients: [], instructions: [] },
          ],
        },
      },
    });

    expect(result.violations.some((violation) => violation.code === "same_day_main_family_duplicate")).toBe(true);
    expect(result.violations.some((violation) => violation.code === "exact_duplicate_signature")).toBe(true);
    expect(result.violations.some((violation) => violation.code === "adjacent_breakfast_template_duplicate")).toBe(true);
  });

  it("does not treat same-day breakfast and dinner as adjacent-day duplicates", () => {
    const result = validateGeneratedMeals({
      targetSlots: [
        { date: "2026-03-18", mealType: "breakfast" },
        { date: "2026-03-18", mealType: "dinner" },
      ],
      generatedMeals: {
        "2026-03-18:breakfast": {
          mealType: "breakfast",
          dishes: [
            { name: "鮭の塩焼き", role: "main", ingredients: [], instructions: [] },
            { name: "味噌汁", role: "soup", ingredients: [], instructions: [] },
            { name: "ご飯", role: "rice", ingredients: [], instructions: [] },
          ],
        },
        "2026-03-18:dinner": {
          mealType: "dinner",
          dishes: [
            { name: "鮭のホイル焼き", role: "main", ingredients: [], instructions: [] },
            { name: "すまし汁", role: "soup", ingredients: [], instructions: [] },
            { name: "ご飯", role: "rice", ingredients: [], instructions: [] },
          ],
        },
      },
    });

    expect(result.violations.some((violation) => violation.code === "adjacent_main_family_duplicate")).toBe(false);
  });

  it("infers the actual protein main even when role labels are noisy", () => {
    const result = validateGeneratedMeals({
      targetSlots: [
        { date: "2026-03-18", mealType: "lunch" },
      ],
      generatedMeals: {
        "2026-03-18:lunch": {
          mealType: "lunch",
          dishes: [
            { name: "ご飯", role: "rice", ingredients: [], instructions: [] },
            { name: "豚肉とピーマンの炒め物", role: "side", ingredients: [], instructions: [] },
            { name: "味噌汁", role: "soup", ingredients: [], instructions: [] },
          ],
        },
      },
      slotPlans: {
        "2026-03-18:lunch": {
          date: "2026-03-18",
          mealType: "lunch",
          seedTemplateId: "tmpl-lunch-pork",
          seedClusterId: "cluster-lunch-pork",
          templateTitle: "豚炒め定食",
          requiredMainDishFamily: "stir_fry_pork",
          requiredProteinFamily: "pork",
          requiredBreakfastTemplate: "other_breakfast",
          sodiumMode: "normal",
          forbiddenTemplateIds: [],
          forbiddenClusterIds: [],
          forbiddenDishNames: [],
          themeTags: [],
        },
      },
    });

    expect(result.fingerprints["2026-03-18:lunch"].mainDishFamily).toBe("stir_fry_pork");
    expect(result.violations.some((violation) => violation.code === "brief_mismatch")).toBe(false);
  });

  it("flags stacked bread staples at breakfast", () => {
    const result = validateGeneratedMeals({
      targetSlots: [
        { date: "2026-03-18", mealType: "breakfast" },
      ],
      generatedMeals: {
        "2026-03-18:breakfast": {
          mealType: "breakfast",
          dishes: [
            { name: "トースト", role: "rice", ingredients: [], instructions: [] },
            { name: "ふわふわ卵サンド", role: "other", ingredients: [], instructions: [] },
            { name: "ヨーグルト", role: "side", ingredients: [], instructions: [] },
          ],
        },
      },
    });

    expect(result.violations.some((violation) => violation.code === "duplicate_bread_staples")).toBe(true);
  });

  it("downgrades brief mismatch to soft when protein family still matches", () => {
    const result = validateGeneratedMeals({
      targetSlots: [
        { date: "2026-03-18", mealType: "lunch" },
      ],
      generatedMeals: {
        "2026-03-18:lunch": {
          mealType: "lunch",
          dishes: [
            { name: "鮭のレモンソテー", role: "main", ingredients: [], instructions: [] },
            { name: "サラダ", role: "side", ingredients: [], instructions: [] },
          ],
        },
      },
      slotPlans: {
        "2026-03-18:lunch": {
          date: "2026-03-18",
          mealType: "lunch",
          seedTemplateId: "tmpl-salmon-simmered",
          seedClusterId: "cluster-salmon-simmered",
          templateTitle: "鮭の煮物定食",
          requiredMainDishFamily: "foil_salmon",
          requiredProteinFamily: "salmon",
          requiredBreakfastTemplate: "other_breakfast",
          sodiumMode: "normal",
          forbiddenTemplateIds: [],
          forbiddenClusterIds: [],
          forbiddenDishNames: [],
          themeTags: [],
        },
      },
    });

    const mismatch = result.violations.find((violation) => violation.code === "brief_mismatch");
    expect(mismatch?.severity).toBe("soft");
  });

  it("flags breakfasts that are too light structurally", () => {
    const result = validateGeneratedMeals({
      targetSlots: [
        { date: "2026-03-18", mealType: "breakfast" },
      ],
      generatedMeals: {
        "2026-03-18:breakfast": {
          mealType: "breakfast",
          dishes: [
            { name: "ふわふわスクランブルエッグ", role: "main", ingredients: [], instructions: [] },
            { name: "トースト", role: "rice", ingredients: [], instructions: [] },
          ],
        },
      },
    });

    expect(result.violations.some((violation) => violation.code === "breakfast_structure_too_light")).toBe(true);
  });

  it("does not flag breakfasts that meet minimum staple/protein/support grams", () => {
    const result = validateGeneratedMeals({
      targetSlots: [
        { date: "2026-03-18", mealType: "breakfast" },
      ],
      generatedMeals: {
        "2026-03-18:breakfast": {
          mealType: "breakfast",
          dishes: [
            {
              name: "スクランブルエッグ",
              role: "main",
              ingredients: [{ name: "卵", amount_g: 100 }],
              instructions: [],
            },
            {
              name: "トースト",
              role: "rice",
              ingredients: [{ name: "食パン", amount_g: 70 }],
              instructions: [],
            },
            {
              name: "ヨーグルトとバナナ",
              role: "side",
              ingredients: [{ name: "ヨーグルト", amount_g: 120 }, { name: "バナナ", amount_g: 80 }],
              instructions: [],
            },
          ],
        },
      },
    });

    expect(result.violations.some((violation) => violation.code === "breakfast_structure_too_light")).toBe(false);
  });

  it("flags heavy mains that stack extra staples or too many dishes", () => {
    const result = validateGeneratedMeals({
      targetSlots: [
        { date: "2026-03-18", mealType: "dinner" },
      ],
      generatedMeals: {
        "2026-03-18:dinner": {
          mealType: "dinner",
          dishes: [
            { name: "シーフードドリア", role: "main", ingredients: [], instructions: [] },
            { name: "ご飯", role: "rice", ingredients: [], instructions: [] },
            { name: "コーンスープ", role: "soup", ingredients: [], instructions: [] },
            { name: "サラダ", role: "side", ingredients: [], instructions: [] },
          ],
        },
      },
    });

    expect(result.violations.some((violation) => violation.code === "heavy_main_overbuilt")).toBe(true);
  });

  it("flags stacked salty items in a single meal", () => {
    const result = validateGeneratedMeals({
      targetSlots: [
        { date: "2026-03-18", mealType: "dinner" },
      ],
      generatedMeals: {
        "2026-03-18:dinner": {
          mealType: "dinner",
          dishes: [
            { name: "さばの味噌煮", role: "main", ingredients: [], instructions: [] },
            { name: "味噌汁", role: "soup", ingredients: [], instructions: [] },
            { name: "ご飯", role: "rice", ingredients: [], instructions: [] },
          ],
        },
      },
    });

    expect(result.violations.some((violation) => violation.code === "stacked_salty_items")).toBe(true);
  });
});
