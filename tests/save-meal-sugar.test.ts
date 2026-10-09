/**
 * #1146: AI が作った献立の糖質 (sugar_g) の保存
 *
 * - 材料から計算した糖質 (炭水化物 − 食物繊維) を、料理ごと (dishes[].sugar_g) と食事全体 (planned_meals.sugar_g) に保存する。
 * - 栄養が 1 つも計算できていない料理 (計算の失敗・材料が 1 件も当たらない) は、糖質を 0g ではなく null (不明) で保存する。
 *   炭水化物の無い参照レシピで補正して kcal だけが入った料理も、炭水化物の根拠が無いので同じく null にする。
 *
 * saveMealToDb の DB 書き込み・栄養計算・画像ジョブは差し替え、planned_meals に渡る値だけを確かめる。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  hasComputedNutrition,
  saveMealToDb,
  sugarForSave,
} from "../supabase/functions/_shared/save-meal.ts";
import { emptyNutrition, type NutritionTotals } from "../supabase/functions/_shared/nutrition-calculator.ts";
import type { ReferenceRecipe } from "../supabase/functions/_shared/evidence-verifier.ts";

const { analyzeMock, validateMock } = vi.hoisted(() => ({
  analyzeMock: vi.fn(),
  validateMock: vi.fn(),
}));

vi.mock("../supabase/functions/_shared/v4-nutrition-adapter.ts", () => ({
  analyzeNutritionFromIngredientsV4: analyzeMock,
  validateAndAdjustNutritionV4: validateMock,
}));

vi.mock("../supabase/functions/_shared/meal-image.ts", () => ({
  DEFAULT_MEAL_IMAGE_MODEL: "test-image-model",
  reconcileDishImages: vi.fn(async (params: { nextDishes: unknown[] }) => ({
    dishes: params.nextDishes.map(() => ({})),
    mealCoverImageUrl: null,
    jobs: [],
  })),
}));

vi.mock("../supabase/functions/_shared/meal-image-jobs.ts", () => ({
  enqueueMealImageJobs: vi.fn(async () => undefined),
  triggerMealImageJobProcessing: vi.fn(async () => undefined),
}));

vi.mock("../supabase/functions/_shared/meal-nutrition-debug.ts", () => ({
  insertMealNutritionDebugLog: vi.fn(async () => null),
}));

function nutrition(overrides: Partial<NutritionTotals>): NutritionTotals {
  return { ...emptyNutrition(), ...overrides };
}

function analysisOf(calculatedNutrition: NutritionTotals) {
  return {
    normalizedIngredients: [],
    ingredientMatches: [],
    calculatedNutrition,
    timingMs: {
      normalize_ingredients_ms: 0,
      match_ingredients_ms: 0,
      calculate_dish_nutrition_ms: 0,
      total_ms: 0,
    },
  };
}

function referenceRecipe(overrides: Partial<ReferenceRecipe>): ReferenceRecipe {
  return {
    id: "reference-1",
    name: "参照レシピ",
    name_norm: "参照レシピ",
    source_url: null,
    ingredients_text: null,
    calories_kcal: 400,
    protein_g: null,
    fat_g: null,
    carbs_g: null,
    sodium_g: null,
    similarity: 0.9,
    ...overrides,
  };
}

/** validateAndAdjustNutritionV4 が参照レシピで補正したときの結果 */
function adjustedBy(reference: ReferenceRecipe, adjustedNutrition: NutritionTotals) {
  return {
    isValid: false,
    calculatedCalories: 0,
    referenceCalories: reference.calories_kcal ?? 0,
    deviationPercent: 100,
    adjustedNutrition,
    referenceSource: "dataset_recipes",
    message: "調整済み",
    appliedAdjustment: true,
    referenceRecipe: reference,
    referenceCandidates: [reference],
    timingMs: { reference_search_ms: 0, adjustment_ms: 0, total_ms: 0 },
  };
}

function makeFakeSupabase() {
  const inserted: Array<Record<string, any>> = [];
  const client = {
    from(table: string) {
      if (table !== "planned_meals") throw new Error(`unexpected table: ${table}`);
      const chain: any = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.insert = (row: Record<string, any>) => {
        inserted.push(row);
        return chain;
      };
      chain.single = async () => ({ data: { id: "planned-meal-1" }, error: null });
      return chain;
    },
  };
  return { client, inserted };
}

function dish(name: string, role = "main") {
  return {
    name,
    role,
    ingredients: [{ name: "材料", amount_g: 100 }],
    instructions: ["焼く"],
  };
}

async function save(generatedMeal: Record<string, any>) {
  const { client, inserted } = makeFakeSupabase();
  const result = await saveMealToDb(client, {
    userId: "user-1",
    targetSlot: { date: "2026-10-08", mealType: "dinner" },
    generatedMeal: generatedMeal as never,
    dailyMealIdByDate: new Map([["2026-10-08", "daily-meal-1"]]),
  });
  expect(result.outcome).toBe("inserted");
  expect(inserted).toHaveLength(1);
  return inserted[0];
}

describe("save-meal: 糖質 (sugar_g) の保存 (#1146)", () => {
  beforeEach(() => {
    analyzeMock.mockReset();
    validateMock.mockReset();
  });

  describe("hasComputedNutrition / sugarForSave", () => {
    it("kcal か炭水化物が 0 より大きければ計算済み、すべて 0 なら未計算", () => {
      expect(hasComputedNutrition(nutrition({ calories_kcal: 300 }))).toBe(true);
      expect(hasComputedNutrition(nutrition({ carbs_g: 12 }))).toBe(true);
      expect(hasComputedNutrition(emptyNutrition())).toBe(false);
      expect(hasComputedNutrition(null)).toBe(false);
      expect(hasComputedNutrition(undefined)).toBe(false);
    });

    it("計算済みの料理は糖質を小数 1 桁に丸め、未計算の料理は null にする", () => {
      expect(sugarForSave(nutrition({ calories_kcal: 300, carbs_g: 50, fiber_g: 5, sugar_g: 45.04 }))).toBe(45);
      expect(sugarForSave(nutrition({ calories_kcal: 300, carbs_g: 50, sugar_g: 12.36 }))).toBe(12.4);
      expect(sugarForSave(emptyNutrition())).toBeNull();
      expect(sugarForSave(null)).toBeNull();
    });

    it("肉・魚だけの料理 (炭水化物 0、kcal あり) の糖質 0g は null ではなく 0", () => {
      expect(sugarForSave(nutrition({ calories_kcal: 220, protein_g: 30, fat_g: 10 }))).toBe(0);
    });

    it("炭水化物の根拠 (hasCarbBasis) を渡したときは、栄養の中身ではなくそれで決める", () => {
      // kcal だけが入った補正後の栄養 (炭水化物 0) でも、根拠が無ければ null
      expect(sugarForSave(nutrition({ calories_kcal: 400 }), false)).toBeNull();
      // 根拠があれば、糖質 0g も 0 として保存する
      expect(sugarForSave(nutrition({ calories_kcal: 400 }), true)).toBe(0);
      expect(sugarForSave(nutrition({ calories_kcal: 400, carbs_g: 60, sugar_g: 52 }), true)).toBe(52);
      // 栄養そのものが無ければ、根拠を渡しても null
      expect(sugarForSave(null, true)).toBeNull();
    });
  });

  it("材料から計算した糖質を、料理と食事全体に保存する (炭水化物 50 / 食物繊維 5 -> 45)", async () => {
    analyzeMock.mockResolvedValue(
      analysisOf(nutrition({ calories_kcal: 450, carbs_g: 50, fiber_g: 5, sugar_g: 45 })),
    );

    const row = await save({ mealType: "dinner", dishes: [dish("パスタ")], advice: "" });

    expect(row.dishes).toHaveLength(1);
    expect(row.dishes[0].sugar_g).toBe(45);
    expect(row.carbs_g).toBe(50);
    expect(row.fiber_g).toBe(5);
    expect(row.sugar_g).toBe(45);
  });

  it("複数の料理は糖質を合計する (小数 1 桁)", async () => {
    analyzeMock
      .mockResolvedValueOnce(analysisOf(nutrition({ calories_kcal: 450, carbs_g: 50, fiber_g: 5, sugar_g: 45 })))
      .mockResolvedValueOnce(analysisOf(nutrition({ calories_kcal: 90, carbs_g: 13, fiber_g: 0.66, sugar_g: 12.34 })));

    const row = await save({
      mealType: "dinner",
      dishes: [dish("パスタ", "main"), dish("サラダ", "side")],
      advice: "",
    });

    expect(row.dishes.map((d: { sugar_g: number | null }) => d.sugar_g)).toEqual([45, 12.3]);
    expect(row.sugar_g).toBe(57.3);
  });

  it("栄養計算が失敗した料理の糖質は 0 ではなく null で保存する", async () => {
    analyzeMock.mockRejectedValue(new Error("matcher down"));
    validateMock.mockRejectedValue(new Error("no reference"));

    const row = await save({ mealType: "dinner", dishes: [dish("謎の料理")], advice: "" });

    expect(row.dishes[0].sugar_g).toBeNull();
    expect(row.sugar_g).toBeNull();
    // 他の栄養素はこれまでどおり 0 (糖質だけ「不明」を表す)
    expect(row.calories_kcal).toBe(0);
    expect(row.carbs_g).toBe(0);
  });

  it("材料が 1 件も当たらず栄養がすべて 0 の料理も、糖質は null で保存する", async () => {
    analyzeMock.mockResolvedValue(analysisOf(emptyNutrition()));
    validateMock.mockResolvedValue({
      isValid: true,
      calculatedCalories: 0,
      referenceCalories: 0,
      deviationPercent: 0,
      adjustedNutrition: null,
      referenceSource: "none",
      message: "参照レシピなし",
      appliedAdjustment: false,
      referenceRecipe: null,
      referenceCandidates: [],
      timingMs: { reference_search_ms: 0, adjustment_ms: 0, total_ms: 0 },
    });

    const row = await save({ mealType: "dinner", dishes: [dish("謎の料理")], advice: "" });

    expect(row.dishes[0].sugar_g).toBeNull();
    expect(row.sugar_g).toBeNull();
  });

  it("計算できた料理が 1 品でもあれば、食事全体の糖質は計算できた分を合計する (失敗した料理は null)", async () => {
    analyzeMock
      .mockResolvedValueOnce(analysisOf(nutrition({ calories_kcal: 450, carbs_g: 50, fiber_g: 5, sugar_g: 45 })))
      .mockRejectedValueOnce(new Error("matcher down"));
    validateMock.mockRejectedValue(new Error("no reference"));

    const row = await save({
      mealType: "dinner",
      dishes: [dish("パスタ", "main"), dish("謎のスープ", "soup")],
      advice: "",
    });

    expect(row.dishes[0].sugar_g).toBe(45);
    expect(row.dishes[1].sugar_g).toBeNull();
    expect(row.sugar_g).toBe(45);
  });

  it("炭水化物のない料理 (焼き魚など) は糖質 0g として保存する (null にしない)", async () => {
    analyzeMock.mockResolvedValue(
      analysisOf(nutrition({ calories_kcal: 220, protein_g: 30, fat_g: 10, carbs_g: 0, sugar_g: 0 })),
    );

    const row = await save({ mealType: "dinner", dishes: [dish("焼き魚")], advice: "" });

    expect(row.dishes[0].sugar_g).toBe(0);
    expect(row.sugar_g).toBe(0);
  });

  it("参照レシピで調整された栄養の糖質を保存する", async () => {
    // 計算したカロリーが低い (< 100kcal) ので参照レシピで検証・調整される
    analyzeMock.mockResolvedValue(
      analysisOf(nutrition({ calories_kcal: 60, carbs_g: 10, fiber_g: 1, sugar_g: 9 })),
    );
    validateMock.mockResolvedValue({
      isValid: false,
      calculatedCalories: 60,
      referenceCalories: 400,
      deviationPercent: 566,
      adjustedNutrition: nutrition({ calories_kcal: 400, carbs_g: 60, fiber_g: 8, sugar_g: 52 }),
      referenceSource: "dataset_recipes",
      message: "調整済み",
      appliedAdjustment: true,
      referenceRecipe: null,
      referenceCandidates: [],
      timingMs: { reference_search_ms: 0, adjustment_ms: 0, total_ms: 0 },
    });

    const row = await save({ mealType: "dinner", dishes: [dish("カレーライス")], advice: "" });

    expect(row.dishes[0].sugar_g).toBe(52);
    expect(row.sugar_g).toBe(52);
  });

  describe("計算できなかった料理を参照レシピで補正したとき", () => {
    it("参照レシピに炭水化物が無ければ、kcal だけが入っても糖質は 0g ではなく null で保存する", async () => {
      analyzeMock.mockResolvedValue(analysisOf(emptyNutrition()));
      const reference = referenceRecipe({ calories_kcal: 400, carbs_g: null });
      validateMock.mockResolvedValue(
        adjustedBy(reference, nutrition({ calories_kcal: 400, protein_g: 20, fat_g: 15 })),
      );

      const row = await save({ mealType: "dinner", dishes: [dish("謎の料理")], advice: "" });

      // 補正で kcal は入るが、炭水化物は 0 のまま (他の栄養素はこれまでどおり)
      expect(row.calories_kcal).toBe(400);
      expect(row.carbs_g).toBe(0);
      expect(row.dishes[0].sugar_g).toBeNull();
      expect(row.sugar_g).toBeNull();
    });

    it("参照レシピに炭水化物があれば、それから求めた糖質を保存する", async () => {
      analyzeMock.mockResolvedValue(analysisOf(emptyNutrition()));
      const reference = referenceRecipe({ calories_kcal: 400, carbs_g: 60 });
      validateMock.mockResolvedValue(
        adjustedBy(reference, nutrition({ calories_kcal: 400, carbs_g: 60, fiber_g: 0, sugar_g: 60 })),
      );

      const row = await save({ mealType: "dinner", dishes: [dish("謎の丼")], advice: "" });

      expect(row.dishes[0].sugar_g).toBe(60);
      expect(row.sugar_g).toBe(60);
    });

    it("参照レシピの炭水化物が 0g (肉・魚の料理) なら、糖質 0g は根拠があるので 0 で保存する", async () => {
      analyzeMock.mockResolvedValue(analysisOf(emptyNutrition()));
      const reference = referenceRecipe({ calories_kcal: 300, carbs_g: 0 });
      validateMock.mockResolvedValue(
        adjustedBy(reference, nutrition({ calories_kcal: 300, protein_g: 35, fat_g: 18, carbs_g: 0, sugar_g: 0 })),
      );

      const row = await save({ mealType: "dinner", dishes: [dish("謎の焼き魚")], advice: "" });

      expect(row.dishes[0].sugar_g).toBe(0);
      expect(row.sugar_g).toBe(0);
    });

    it("補正の前から栄養が計算できていた料理は、参照レシピに炭水化物が無くても糖質を保存する", async () => {
      // 計算した kcal は低いが、炭水化物 10 / 食物繊維 1 は材料から計算できている
      analyzeMock.mockResolvedValue(
        analysisOf(nutrition({ calories_kcal: 60, carbs_g: 10, fiber_g: 1, sugar_g: 9 })),
      );
      const reference = referenceRecipe({ calories_kcal: 300, carbs_g: null });
      validateMock.mockResolvedValue(
        adjustedBy(reference, nutrition({ calories_kcal: 300, carbs_g: 50, fiber_g: 5, sugar_g: 45 })),
      );

      const row = await save({ mealType: "dinner", dishes: [dish("カレーライス")], advice: "" });

      expect(row.dishes[0].sugar_g).toBe(45);
      expect(row.sugar_g).toBe(45);
    });

    it("食事全体の糖質は、根拠のある料理の分だけを合計する (根拠の無い料理の 0 は足さないが、null にもしない)", async () => {
      analyzeMock
        .mockResolvedValueOnce(analysisOf(nutrition({ calories_kcal: 450, carbs_g: 50, fiber_g: 5, sugar_g: 45 })))
        .mockResolvedValueOnce(analysisOf(emptyNutrition()));
      // 1 品目 (パスタ) は kcal が十分で検証されない。2 品目 (謎のスープ) だけ、炭水化物の無い参照レシピで補正される
      validateMock.mockResolvedValue(
        adjustedBy(referenceRecipe({ calories_kcal: 80, carbs_g: null }), nutrition({ calories_kcal: 80 })),
      );

      const row = await save({
        mealType: "dinner",
        dishes: [dish("パスタ", "main"), dish("謎のスープ", "soup")],
        advice: "",
      });

      expect(row.dishes[0].sugar_g).toBe(45);
      expect(row.dishes[1].sugar_g).toBeNull();
      expect(row.sugar_g).toBe(45);
    });
  });

  it("レシピDBから解決した栄養 (_resolvedNutrition) の糖質をそのまま保存する", async () => {
    const row = await save({
      mealType: "dinner",
      dishes: [dish("麻婆豆腐")],
      advice: "",
      _resolvedNutrition: nutrition({ calories_kcal: 500, carbs_g: 60, fiber_g: 4, sugar_g: 56 }),
      _recipeSource: { type: "dataset_recipe", id: "recipe-1", externalId: "ext-1" },
    });

    expect(analyzeMock).not.toHaveBeenCalled();
    expect(row.dishes[0].sugar_g).toBe(56);
    expect(row.sugar_g).toBe(56);
  });
});
