import { describe, expect, it } from "vitest";

import { fingerprintExistingMenu } from "../supabase/functions/generate-menu-v5/diversity-fingerprint";
import {
  normalizeSlotPlanForPrompt,
  planDiversityForRange,
} from "../supabase/functions/generate-menu-v5/diversity-scheduler";
import { buildTemplateCatalog } from "../supabase/functions/generate-menu-v5/template-catalog";

const templates = buildTemplateCatalog([
  {
    id: "tmpl-breakfast-weird",
    external_id: "ext-breakfast-weird",
    meal_type_hint: "breakfast",
    title: "ヘルシーだけどこくうま回鍋肉 / トマトと卵のスープ",
    dishes: [
      { name: "回鍋肉", role: "main" },
      { name: "トマトと卵のスープ", role: "soup" },
    ],
  },
  {
    id: "tmpl-breakfast-fish",
    external_id: "ext-breakfast-fish",
    title: "鮭の塩焼き朝食",
    dishes: [
      { name: "鮭の塩焼き", role: "main" },
      { name: "味噌汁", role: "soup" },
      { name: "ご飯", role: "rice" },
    ],
  },
  {
    id: "tmpl-breakfast-bread",
    external_id: "ext-breakfast-bread",
    title: "トーストとスクランブルエッグ",
    dishes: [
      { name: "スクランブルエッグ", role: "main" },
      { name: "トースト", role: "rice" },
      { name: "ヨーグルト", role: "side" },
    ],
  },
  {
    id: "tmpl-lunch-chicken",
    external_id: "ext-lunch-chicken",
    title: "鶏の照り焼き定食",
    dishes: [
      { name: "鶏の照り焼き", role: "main" },
      { name: "ほうれん草のおひたし", role: "side" },
      { name: "味噌汁", role: "soup" },
      { name: "ご飯", role: "rice" },
    ],
  },
  {
    id: "tmpl-lunch-pork",
    external_id: "ext-lunch-pork",
    title: "豚の生姜焼き定食",
    dishes: [
      { name: "豚の生姜焼き", role: "main" },
      { name: "きんぴらごぼう", role: "side" },
      { name: "すまし汁", role: "soup" },
      { name: "ご飯", role: "rice" },
    ],
  },
  {
    id: "tmpl-dinner-salmon",
    external_id: "ext-dinner-salmon",
    title: "鮭のホイル焼き定食",
    dishes: [
      { name: "鮭のホイル焼き", role: "main" },
      { name: "ひじき煮", role: "side" },
      { name: "すまし汁", role: "soup" },
      { name: "ご飯", role: "rice" },
    ],
  },
  {
    id: "tmpl-dinner-tofu",
    external_id: "ext-dinner-tofu",
    title: "豆腐ハンバーグ定食",
    dishes: [
      { name: "豆腐ハンバーグ", role: "main" },
      { name: "サラダ", role: "side" },
      { name: "コンソメスープ", role: "soup" },
      { name: "ご飯", role: "rice" },
    ],
  },
  {
    id: "tmpl-lunch-curry",
    external_id: "ext-lunch-curry",
    title: "野菜たっぷりカレーライス",
    dishes: [
      { name: "野菜たっぷりカレーライス", role: "main" },
      { name: "サラダ", role: "side" },
    ],
  },
  {
    id: "tmpl-dinner-gratin",
    external_id: "ext-dinner-gratin",
    title: "きのこグラタン",
    dishes: [
      { name: "きのこグラタン", role: "main" },
      { name: "コンソメスープ", role: "soup" },
      { name: "サラダ", role: "side" },
    ],
  },
]);

describe("V5 diversity scheduler", () => {
  it("avoids adjacent-day main family and breakfast template duplicates", () => {
    const existingFingerprints = [
      fingerprintExistingMenu({
        date: "2026-03-17",
        mealType: "dinner",
        dishName: "鶏の照り焼き",
      }),
    ];

    const result = planDiversityForRange({
      targetSlots: [
        { date: "2026-03-18", mealType: "breakfast" },
        { date: "2026-03-18", mealType: "lunch" },
        { date: "2026-03-18", mealType: "dinner" },
        { date: "2026-03-19", mealType: "breakfast" },
        { date: "2026-03-19", mealType: "lunch" },
        { date: "2026-03-19", mealType: "dinner" },
      ],
      templates,
      existingFingerprints,
      sodiumMode: "normal",
    });

    const day1Breakfast = result.slotPlans["2026-03-18:breakfast"];
    const day2Breakfast = result.slotPlans["2026-03-19:breakfast"];
    const day1Lunch = result.slotPlans["2026-03-18:lunch"];
    const day1Dinner = result.slotPlans["2026-03-18:dinner"];
    const day2Lunch = result.slotPlans["2026-03-19:lunch"];

    expect(day1Breakfast.requiredBreakfastTemplate).not.toBe(day2Breakfast.requiredBreakfastTemplate);
    expect(day1Lunch.requiredMainDishFamily).not.toBe(day1Dinner.requiredMainDishFamily);
    expect(day1Lunch.requiredMainDishFamily).not.toBe(day2Lunch.requiredMainDishFamily);
    expect(day1Breakfast.templateTitle).not.toContain("回鍋肉");
  });

  it("does not collapse curry and gratin into the same lunch/dinner family", () => {
    const result = planDiversityForRange({
      targetSlots: [
        { date: "2026-03-21", mealType: "lunch" },
        { date: "2026-03-21", mealType: "dinner" },
      ],
      templates,
      sodiumMode: "normal",
    });

    expect(result.slotPlans["2026-03-21:lunch"].requiredMainDishFamily).not.toBe(
      result.slotPlans["2026-03-21:dinner"].requiredMainDishFamily,
    );
  });

  it("normalizes breakfast fallback plans to a safe breakfast brief", () => {
    const weirdBreakfastTemplate = templates.find((template) => template.id === "tmpl-breakfast-weird");
    const normalized = normalizeSlotPlanForPrompt({
      date: "2026-03-18",
      mealType: "breakfast",
      seedTemplateId: "tmpl-breakfast-weird",
      seedClusterId: "breakfast|other_main|other",
      templateTitle: "ヘルシーだけどこくうま回鍋肉 / トマトと卵のスープ",
      requiredMainDishFamily: "other_main",
      requiredProteinFamily: "other",
      requiredBreakfastTemplate: "other_breakfast",
      sodiumMode: "normal",
      forbiddenTemplateIds: [],
      forbiddenClusterIds: [],
      forbiddenDishNames: [],
      themeTags: [],
    }, weirdBreakfastTemplate);

    expect(normalized.requiredBreakfastTemplate).not.toBe("other_breakfast");
    expect(normalized.requiredMainDishFamily).not.toBe("other_main");
  });

  it("prefers moderate lunch templates over oversized heavy ones", () => {
    const focusedTemplates = buildTemplateCatalog([
      {
        id: "tmpl-lunch-heavy",
        external_id: "ext-lunch-heavy",
        meal_type_hint: "lunch",
        title: "野菜たっぷりカレーライス定食",
        calories_kcal: 1090,
        dishes: [
          { name: "野菜たっぷりカレーライス", role: "main" },
          { name: "サラダ", role: "side" },
          { name: "スープ", role: "soup" },
          { name: "ご飯", role: "rice" },
        ],
      },
      {
        id: "tmpl-lunch-moderate",
        external_id: "ext-lunch-moderate",
        meal_type_hint: "lunch",
        title: "豚の生姜焼き定食",
        calories_kcal: 680,
        dishes: [
          { name: "豚の生姜焼き", role: "main" },
          { name: "小松菜の和え物", role: "side" },
          { name: "すまし汁", role: "soup" },
          { name: "ご飯", role: "rice" },
        ],
      },
    ]);

    const result = planDiversityForRange({
      targetSlots: [
        { date: "2026-03-22", mealType: "lunch" },
      ],
      templates: focusedTemplates,
      sodiumMode: "normal",
    });

    expect(result.slotPlans["2026-03-22:lunch"].seedTemplateId).toBe("tmpl-lunch-moderate");
  });
});
