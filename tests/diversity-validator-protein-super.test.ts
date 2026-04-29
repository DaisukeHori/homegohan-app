import { describe, expect, it } from "vitest";

import { validateGeneratedMeals } from "../supabase/functions/generate-menu-v5/diversity-validator";

type MealType = "breakfast" | "lunch" | "dinner";

function makeMeal(mainDishName: string, mealType: MealType) {
  return {
    mealType,
    dishes: [
      { name: mainDishName, role: "main", ingredients: [], instructions: [] },
      { name: "味噌汁", role: "soup", ingredients: [], instructions: [] },
      { name: "ご飯", role: "rice", ingredients: [], instructions: [] },
    ],
  };
}

describe("V5 diversity validator: protein super-category (魚偏重バグ修正)", () => {
  it("weekly_super_protein_overuse: 鮭3+さわら3 で魚6回 → hard violation", () => {
    const dates = ["2026-04-30", "2026-04-30", "2026-04-30", "2026-05-01", "2026-05-01", "2026-05-01"];
    const meals = [
      "鮭の塩レモン焼き",
      "鮭のホイル焼き",
      "さわらのグリル黒酢ソース",
      "さわらの煮付け",
      "鮭の味噌焼き",
      "さわらの照り焼き",
    ];
    const targetSlots = dates.map((date, i) => ({
      date,
      mealType: (i % 3 === 0 ? "breakfast" : i % 3 === 1 ? "lunch" : "dinner") as MealType,
    }));
    const generatedMeals = Object.fromEntries(
      targetSlots.map((slot, i) => [`${slot.date}:${slot.mealType}`, makeMeal(meals[i], slot.mealType)]),
    );

    const { violations } = validateGeneratedMeals({ targetSlots, generatedMeals });

    const fishOveruse = violations.filter((v) => v.code === "weekly_super_protein_overuse");
    expect(fishOveruse.length).toBeGreaterThanOrEqual(2);
    const hardViolations = fishOveruse.filter((v) => v.severity === "hard");
    expect(hardViolations.length).toBeGreaterThanOrEqual(1);
  });

  it("same_day_super_protein_duplicate: 朝鮭+昼鮭 → 4/30 で violation", () => {
    const targetSlots = [
      { date: "2026-04-30", mealType: "breakfast" as const },
      { date: "2026-04-30", mealType: "lunch" as const },
      { date: "2026-04-30", mealType: "dinner" as const },
    ];
    const generatedMeals = {
      "2026-04-30:breakfast": makeMeal("鮭の塩レモン焼き", "breakfast"),
      "2026-04-30:lunch": makeMeal("鮭のホイル焼き", "lunch"),
      "2026-04-30:dinner": makeMeal("豚肉の生姜焼き", "dinner"),
    };

    const { violations } = validateGeneratedMeals({ targetSlots, generatedMeals });

    const sameDaySuperFish = violations.filter(
      (v) => v.code === "same_day_super_protein_duplicate" && v.message.includes("魚"),
    );
    expect(sameDaySuperFish.length).toBeGreaterThanOrEqual(1);
  });

  it("egg/tofu super category は同日複数回でも検出されない", () => {
    const targetSlots = [
      { date: "2026-04-30", mealType: "breakfast" as const },
      { date: "2026-04-30", mealType: "lunch" as const },
    ];
    const generatedMeals = {
      "2026-04-30:breakfast": makeMeal("卵焼き", "breakfast"),
      "2026-04-30:lunch": makeMeal("卵チャーハン", "lunch"),
    };

    const { violations } = validateGeneratedMeals({ targetSlots, generatedMeals });

    const sameDaySuperEgg = violations.filter(
      (v) => v.code === "same_day_super_protein_duplicate" && v.message.includes("卵"),
    );
    expect(sameDaySuperEgg.length).toBe(0);
  });
});
