import { describe, expect, it } from "vitest";

import {
  buildNutritionRadarChartData,
  calculateAverageAchievementPercentage,
} from "../src/components/NutritionRadarChart";

// #1046 UX3-20: 塩分・コレステロール等の上限系(DG/UL)栄養素の過剰摂取が
// 「平均達成率」を押し上げてはいけない。

describe("NutritionRadarChart average achievement rate (UX3-20)", () => {
  it("excludes upper-limit nutrients (sodium) from the average even when over-consumed", () => {
    // proteinG は dri=60 で ちょうど100%、sodiumG は dri=7.5 で 300%(過剰摂取)
    const nutrition = { proteinG: 60, sodiumG: 22.5 };
    const chartData = buildNutritionRadarChartData(["proteinG", "sodiumG"], nutrition);
    const average = calculateAverageAchievementPercentage(chartData);

    // sodiumG(上限系)を含めれば (100+300)/2=200% になってしまうが、
    // 上限系を除外した場合は proteinG のみの 100% になるはず
    expect(average).toBe(100);
  });

  it("does not raise the average as an upper-limit nutrient's excess grows", () => {
    const base = buildNutritionRadarChartData(["proteinG", "sodiumG"], { proteinG: 60, sodiumG: 7.5 });
    const overConsumed = buildNutritionRadarChartData(["proteinG", "sodiumG"], { proteinG: 60, sodiumG: 45 });

    const averageBase = calculateAverageAchievementPercentage(base);
    const averageOverConsumed = calculateAverageAchievementPercentage(overConsumed);

    expect(averageBase).toBe(100);
    expect(averageOverConsumed).toBe(100);
  });

  it("still averages normal (non upper-limit) nutrients as before", () => {
    // caloriesKcal dri=2000 -> 50%, proteinG dri=60 -> 100%
    const chartData = buildNutritionRadarChartData(["caloriesKcal", "proteinG"], {
      caloriesKcal: 1000,
      proteinG: 60,
    });
    const average = calculateAverageAchievementPercentage(chartData);
    expect(average).toBe(75);
  });

  it("returns 0 when only upper-limit nutrients are selected", () => {
    const chartData = buildNutritionRadarChartData(["sodiumG", "cholesterolMg"], {
      sodiumG: 30,
      cholesterolMg: 900,
    });
    const average = calculateAverageAchievementPercentage(chartData);
    expect(average).toBe(0);
  });

  it("marks sodium/saturatedFat/cholesterol as isUpperLimit and other nutrients as not", () => {
    const chartData = buildNutritionRadarChartData(
      ["sodiumG", "saturatedFatG", "cholesterolMg", "proteinG", "fiberG"],
      {}
    );
    const flags = Object.fromEntries(chartData.map((d, i) => [
      ["sodiumG", "saturatedFatG", "cholesterolMg", "proteinG", "fiberG"][i],
      d.isUpperLimit,
    ]));

    expect(flags.sodiumG).toBe(true);
    expect(flags.saturatedFatG).toBe(true);
    expect(flags.cholesterolMg).toBe(true);
    expect(flags.proteinG).toBe(false);
    expect(flags.fiberG).toBe(false);
  });
});
