import { describe, expect, it } from "vitest";

import { buildSearchQueryBase, buildUserSummary } from "../supabase/functions/_shared/user-context";

describe("user-context onboarding reflection", () => {
  const profile = {
    nickname: "テストユーザー",
    age: 32,
    gender: "female",
    height: 160,
    weight: 52,
    nutrition_goal: "maintain",
    diet_style: "normal",
    family_size: 3,
    weekday_cooking_minutes: 20,
    weekend_cooking_minutes: 40,
    cooking_experience: "beginner",
    cuisine_preferences: { japanese: 5, western: 3 },
    favorite_ingredients: ["鮭", "ブロッコリー"],
    kitchen_appliances: ["microwave", "rice_cooker"],
    weekly_food_budget: 4800,
    shopping_frequency: "weekly",
    pregnancy_status: "breastfeeding",
    diet_flags: { allergies: ["えび"], dislikes: ["セロリ"] },
  };

  it("includes onboarding-derived profile details in summary", () => {
    const summary = buildUserSummary(profile, null, null, null, null, null);
    expect(summary).toContain("好きな食材: 鮭, ブロッコリー");
    expect(summary).toContain("キッチン家電: microwave, rice_cooker");
    expect(summary).toContain("週間食費予算: 4800円");
    expect(summary).toContain("買い物頻度: 週1回");
    expect(summary).toContain("妊娠・授乳状況: 授乳中");
  });

  it("feeds onboarding-derived hints into search query keywords", () => {
    const query = buildSearchQueryBase({ profile, note: "家族向けで簡単に" });
    expect(query).toContain("鮭");
    expect(query).toContain("ブロッコリー");
    expect(query).toContain("節約");
    expect(query).toContain("microwave");
    expect(query).toContain("授乳中");
  });
});
