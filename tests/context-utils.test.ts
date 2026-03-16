import { describe, expect, it } from "vitest";

import { selectRecentMenusForVariety } from "../supabase/functions/generate-menu-v4/context-utils";

describe("selectRecentMenusForVariety", () => {
  it("excludes overwrite targets from nearby variety history", () => {
    const recentMenus = selectRecentMenusForVariety({
      targetDate: "2026-03-16",
      targetSlots: [
        { date: "2026-03-16", mealType: "breakfast", plannedMealId: "pm-breakfast" },
      ],
      existingMenus: [
        { date: "2026-03-16", mealType: "breakfast", dishName: "大満足ステーキ朝食プレート" },
        { date: "2026-03-16", mealType: "lunch", dishName: "鶏そぼろ丼" },
        { date: "2026-03-14", mealType: "dinner", dishName: "鮭の塩焼き" },
      ],
    });

    expect(recentMenus).toEqual([
      { date: "2026-03-16", mealType: "lunch", dishName: "鶏そぼろ丼" },
      { date: "2026-03-14", mealType: "dinner", dishName: "鮭の塩焼き" },
    ]);
  });

  it("keeps other nearby meals but drops menus older than 7 days", () => {
    const recentMenus = selectRecentMenusForVariety({
      targetDate: "2026-03-16",
      existingMenus: [
        { date: "2026-03-09", mealType: "dinner", dishName: "豚汁" },
        { date: "2026-03-08", mealType: "dinner", dishName: "カレー" },
      ],
    });

    expect(recentMenus).toEqual([
      { date: "2026-03-09", mealType: "dinner", dishName: "豚汁" },
    ]);
  });
});
