import { describe, expect, it } from "vitest";

import { MEAL_ORDER } from "@homegohan/shared";

import { BASE_MEAL_TYPES, buildSingleDaySlots, EXTRA_MEAL_TYPES } from "../lib/slot-builder";

describe("buildSingleDaySlots", () => {
  it("attaches plannedMealId for existing breakfast/lunch/dinner slots", () => {
    const slots = buildSingleDaySlots({
      date: "2026-03-16",
      mealPlanDays: [
        {
          dayDate: "2026-03-16",
          meals: [
            { id: "pm-breakfast", mealType: "breakfast" } as any,
            { id: "pm-lunch", mealType: "lunch" } as any,
            { id: "pm-dinner", mealType: "dinner" } as any,
          ],
        },
      ],
    });

    expect(slots).toEqual([
      { date: "2026-03-16", mealType: "breakfast", plannedMealId: "pm-breakfast" },
      { date: "2026-03-16", mealType: "lunch", plannedMealId: "pm-lunch" },
      { date: "2026-03-16", mealType: "dinner", plannedMealId: "pm-dinner" },
    ]);
  });

  it("keeps empty slots creatable without plannedMealId", () => {
    const slots = buildSingleDaySlots({
      date: "2026-03-16",
      mealPlanDays: [
        {
          dayDate: "2026-03-16",
          meals: [
            { id: "pm-breakfast", mealType: "breakfast" } as any,
          ],
        },
      ],
    });

    expect(slots).toEqual([
      { date: "2026-03-16", mealType: "breakfast", plannedMealId: "pm-breakfast" },
      { date: "2026-03-16", mealType: "lunch", plannedMealId: undefined },
      { date: "2026-03-16", mealType: "dinner", plannedMealId: undefined },
    ]);
  });
});

// #1631: 食事の区分のボタンの並び (Web の献立画面・食事の記録の画面の 1 段目と 2 段目)。
// EXTRA_MEAL_TYPES は手書きをやめ、正本 MEAL_ORDER から基本の 3 食を除いて作る形に書き換えたので、その結果 (値と並び) を固定する
// (期待値はここで手で書く。正本から導いた値と比べると、導き方の誤りを見逃すため)
describe("BASE_MEAL_TYPES / EXTRA_MEAL_TYPES (#1631)", () => {
  it("1 段目は 朝食 → 昼食 → 夕食", () => {
    expect([...BASE_MEAL_TYPES]).toEqual(["breakfast", "lunch", "dinner"]);
  });

  it("2 段目は おやつ → 夜食 (基本の 3 食を含まない)", () => {
    expect([...EXTRA_MEAL_TYPES]).toEqual(["snack", "midnight_snack"]);
  });

  it("1 段目と 2 段目をつなぐと、正本 MEAL_ORDER と同じ 5 値が同じ順で、重なりなく並ぶ", () => {
    expect([...BASE_MEAL_TYPES, ...EXTRA_MEAL_TYPES]).toEqual([...MEAL_ORDER]);
    expect(EXTRA_MEAL_TYPES.filter((mealType) => BASE_MEAL_TYPES.includes(mealType))).toEqual([]);
  });
});
