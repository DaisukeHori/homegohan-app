import { describe, expect, it } from "vitest";

import {
  buildTemplateCatalog,
  clusterMenuTemplates,
} from "../supabase/functions/generate-menu-v5/template-catalog";

describe("V5 template catalog", () => {
  it("classifies staple sample menus into template metadata", () => {
    const templates = buildTemplateCatalog([
      {
        id: "tmpl-1",
        external_id: "ext-1",
        title: "鮭の塩焼き朝食",
        dishes: [
          { name: "鮭の塩焼き", role: "main" },
          { name: "味噌汁", role: "soup" },
          { name: "ご飯", role: "rice" },
        ],
      },
    ]);

    expect(templates).toHaveLength(1);
    expect(templates[0].mainDishFamily).toBe("grilled_salmon");
    expect(templates[0].proteinFamily).toBe("salmon");
    expect(templates[0].breakfastTemplate).toBe("rice_miso_grilled_fish");
    expect(templates[0].soupKind).toBe("miso");
    expect(templates[0].clusterId).toContain("grilled_salmon");
  });

  it("separates templates when breakfast pattern changes", () => {
    const templates = buildTemplateCatalog([
      {
        id: "tmpl-1",
        external_id: "ext-1",
        title: "鮭の塩焼き朝食",
        dishes: [
          { name: "鮭の塩焼き", role: "main" },
          { name: "味噌汁", role: "soup" },
          { name: "ご飯", role: "rice" },
        ],
      },
      {
        id: "tmpl-2",
        external_id: "ext-2",
        title: "鮭の塩焼き朝食 2",
        dishes: [
          { name: "鮭の塩焼き", role: "main" },
          { name: "豆腐の味噌汁", role: "soup" },
          { name: "ご飯", role: "rice" },
        ],
      },
    ]);

    const clusters = clusterMenuTemplates(templates);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((cluster) => cluster.breakfastTemplate).sort()).toEqual([
      "rice_miso_grilled_fish",
      "rice_soup_tofu",
    ]);
  });

  it("classifies curry samples into a dedicated family", () => {
    const templates = buildTemplateCatalog([
      {
        id: "tmpl-curry",
        external_id: "ext-curry",
        title: "夏野菜と鶏ひき肉のヘルシーキーマカレー",
        dishes: [
          { name: "夏野菜と鶏ひき肉のヘルシーキーマカレー", role: "main" },
          { name: "サラダ", role: "side" },
        ],
      },
    ]);

    expect(templates[0].mainDishFamily).toBe("curry_main");
  });

  it("prefers a rice/main-like dish over soup when roles are missing", () => {
    const templates = buildTemplateCatalog([
      {
        id: "tmpl-mixed",
        external_id: "ext-mixed",
        title: "けんちん汁 / 鮭としその混ぜ御飯",
        dishes: [
          { name: "けんちん汁" },
          { name: "鮭としその混ぜ御飯" },
        ],
      },
    ]);

    expect(templates[0].mainDishName).toBe("鮭としその混ぜ御飯");
    expect(templates[0].mainDishFamily).toBe("rice_bowl");
  });

  it("classifies spaghetti mains as noodle family", () => {
    const templates = buildTemplateCatalog([
      {
        id: "tmpl-spaghetti",
        external_id: "ext-spaghetti",
        title: "スパゲッティミートソース",
        dishes: [
          { name: "スパゲッティミートソース", role: "main" },
          { name: "サラダ", role: "side" },
        ],
      },
    ]);

    expect(templates[0].mainDishFamily).toBe("noodle_soup");
  });

  it("classifies common fish simmered dishes as fish family instead of other_main", () => {
    const templates = buildTemplateCatalog([
      {
        id: "tmpl-fish-simmered",
        external_id: "ext-fish-simmered",
        title: "さわらの生姜煮定食",
        dishes: [
          { name: "さわらの生姜煮", role: "main" },
          { name: "小松菜の胡麻和え", role: "side" },
        ],
      },
    ]);

    expect(templates[0].proteinFamily).toBe("other_fish");
    expect(templates[0].mainDishFamily).toBe("simmered_fish");
  });

  it("classifies semantic variants used by V5 prompts into the intended families", () => {
    const templates = buildTemplateCatalog([
      {
        id: "tmpl-chicken-saute",
        external_id: "ext-chicken-saute",
        title: "鶏肉のレモンソテー",
        dishes: [{ name: "鶏肉のレモンソテー", role: "main" }],
      },
      {
        id: "tmpl-salmon-foil",
        external_id: "ext-salmon-foil",
        title: "鮭の包み焼き",
        dishes: [{ name: "鮭の包み焼き", role: "main" }],
      },
      {
        id: "tmpl-pork-kimchi",
        external_id: "ext-pork-kimchi",
        title: "豚キムチ炒め",
        dishes: [{ name: "豚キムチ炒め", role: "main" }],
      },
    ]);

    const byId = Object.fromEntries(templates.map((template) => [template.id, template]));
    expect(byId["tmpl-chicken-saute"].mainDishFamily).toBe("stir_fry_chicken");
    expect(byId["tmpl-salmon-foil"].mainDishFamily).toBe("foil_salmon");
    expect(byId["tmpl-pork-kimchi"].mainDishFamily).toBe("stir_fry_pork");
  });

  it("treats egg dish names written in katakana as egg family", () => {
    const templates = buildTemplateCatalog([
      {
        id: "tmpl-egg-scramble",
        external_id: "ext-egg-scramble",
        title: "野菜とチーズのスクランブルエッグ",
        dishes: [{ name: "野菜とチーズのスクランブルエッグ", role: "main" }],
      },
    ]);

    expect(templates[0].proteinFamily).toBe("egg");
    expect(templates[0].mainDishFamily).toBe("egg_main");
  });

  it("ranks balanced breakfast templates ahead of sparse low-calorie ones", () => {
    const templates = buildTemplateCatalog([
      {
        id: "tmpl-light-breakfast",
        external_id: "ext-light-breakfast",
        meal_type_hint: "breakfast",
        title: "トーストとスクランブルエッグ",
        calories_kcal: 180,
        dishes: [
          { name: "スクランブルエッグ", role: "main" },
          { name: "トースト", role: "rice" },
        ],
      },
      {
        id: "tmpl-balanced-breakfast",
        external_id: "ext-balanced-breakfast",
        meal_type_hint: "breakfast",
        title: "鮭の塩焼き朝食",
        calories_kcal: 430,
        dishes: [
          { name: "鮭の塩焼き", role: "main" },
          { name: "味噌汁", role: "soup" },
          { name: "ご飯", role: "rice" },
        ],
      },
    ]);

    expect(templates[0].id).toBe("tmpl-balanced-breakfast");
  });
});
