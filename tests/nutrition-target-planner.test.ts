import { describe, expect, it } from "vitest";

import { deriveMacroTargets, estimateGoalProjection } from "../src/lib/nutrition-target-planner";

describe("deriveMacroTargets", () => {
  it("preserves macro ratios while respecting protein floor", () => {
    const result = deriveMacroTargets({
      dailyCalories: 1600,
      ratios: { protein: 0.3, fat: 0.25, carbs: 0.45 },
      currentWeightKg: 88,
      nutritionGoal: "lose_weight",
    });

    expect(result.proteinG).toBeGreaterThanOrEqual(105.6);
    expect(result.fatG).toBeGreaterThan(0);
    expect(result.carbsG).toBeGreaterThan(0);
  });
});

describe("estimateGoalProjection", () => {
  it("estimates a reachable loss date when calories are below TDEE", () => {
    const result = estimateGoalProjection({
      currentWeightKg: 88,
      targetWeightKg: 80,
      dailyCalories: 1600,
      tdeeKcal: 2127,
      startDate: new Date("2026-03-16T00:00:00.000Z"),
    });

    expect(result.reachable).toBe(true);
    if (result.reachable) {
      expect(result.direction).toBe("lose");
      expect(result.estimatedDays).toBeGreaterThan(100);
      expect(result.dailyEnergyGapKcal).toBe(-527);
    }
  });

  it("rejects projections that do not move toward the target weight", () => {
    const result = estimateGoalProjection({
      currentWeightKg: 88,
      targetWeightKg: 80,
      dailyCalories: 2300,
      tdeeKcal: 2127,
    });

    expect(result.reachable).toBe(false);
    if (!result.reachable) {
      expect(result.reason).toContain("減量方向");
    }
  });
});
