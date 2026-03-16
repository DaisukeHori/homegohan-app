import { describe, expect, it } from "vitest";

import { buildSingleDaySlots } from "../lib/slot-builder";

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
