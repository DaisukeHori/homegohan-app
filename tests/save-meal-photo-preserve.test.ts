/**
 * #1487 の整合ゲート: AI が献立の枠を作り直す保存 (Edge の save-meal。plannedMealId を指定した更新) でも、
 * 前回の写真の料理 (buildPhotoDishList の出力。subject_hash を持たない) の画像を AI の画像で置き換えない。
 *
 * 料理の画像の組み立て (reconcileDishImages) は本物を使い、栄養計算・ジョブの積み方・DB だけを作り物にする
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveMealToDb } from "../supabase/functions/_shared/save-meal.ts";
import { buildPhotoDishList, type MealImageDish } from "../supabase/functions/_shared/meal-image.ts";
import { emptyNutrition } from "../supabase/functions/_shared/nutrition-calculator.ts";

const { analyzeMock, enqueueMock, triggerMock } = vi.hoisted(() => ({
  analyzeMock: vi.fn(),
  enqueueMock: vi.fn(async () => undefined),
  triggerMock: vi.fn(async () => undefined),
}));

vi.mock("../supabase/functions/_shared/v4-nutrition-adapter.ts", () => ({
  analyzeNutritionFromIngredientsV4: analyzeMock,
  validateAndAdjustNutritionV4: vi.fn(),
}));
vi.mock("../supabase/functions/_shared/meal-image-jobs.ts", () => ({
  enqueueMealImageJobs: enqueueMock,
  triggerMealImageJobProcessing: triggerMock,
}));
vi.mock("../supabase/functions/_shared/meal-nutrition-debug.ts", () => ({
  insertMealNutritionDebugLog: vi.fn(async () => null),
}));

const USER_ID = "user-1";
const MEAL_ID = "planned-meal-1";
const PHOTO_URL = "https://example.com/storage/meal-photos/user-1/photo.jpg";

/** 既存の献立 (写真の料理) を読み、更新を記録する DB の作り物 */
function makeFakeSupabase(existingDishes: MealImageDish[]) {
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      let op: "select" | "update" | "upsert" = "select";
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.upsert = () => {
        op = "upsert";
        return chain;
      };
      chain.update = (row: Record<string, unknown>) => {
        op = "update";
        updates.push(row);
        return chain;
      };
      const result = async () => {
        if (table === "user_daily_meals") return { data: { id: "daily-meal-1" }, error: null };
        if (table === "planned_meals" && op === "select") {
          return { data: { id: MEAL_ID, dishes: existingDishes, image_url: PHOTO_URL, user_daily_meals: { user_id: USER_ID } }, error: null };
        }
        if (table === "planned_meals" && op === "update") return { data: { id: MEAL_ID }, error: null };
        throw new Error(`unexpected ${op} on ${table}`);
      };
      chain.single = result;
      chain.maybeSingle = result;
      return chain;
    },
  };
  return { client, updates };
}

function aiDish(name: string, role = "main") {
  return { name, role, ingredients: [{ name: "材料", amount_g: 100 }], instructions: ["焼く"] };
}

async function regenerate(existingDishes: MealImageDish[], dishes: ReturnType<typeof aiDish>[]) {
  const { client, updates } = makeFakeSupabase(existingDishes);
  const result = await saveMealToDb(client, {
    userId: USER_ID,
    targetSlot: { date: "2026-10-12", mealType: "dinner", plannedMealId: MEAL_ID },
    generatedMeal: { mealType: "dinner", dishes, advice: "" } as never,
    dailyMealIdByDate: new Map([["2026-10-12", "daily-meal-1"]]),
  });
  expect(result.outcome).toBe("updated");
  expect(updates).toHaveLength(1);
  return updates[0] as { dishes: MealImageDish[]; image_url: string | null };
}

describe("save-meal: 前回の写真の料理を AI の画像で置き換えない (#1487 の整合ゲート)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    analyzeMock.mockResolvedValue({
      normalizedIngredients: [],
      ingredientMatches: [],
      calculatedNutrition: { ...emptyNutrition(), calories_kcal: 400, carbs_g: 40 },
      timingMs: { normalize_ingredients_ms: 0, match_ingredients_ms: 0, calculate_dish_nutrition_ms: 0, total_ms: 0 },
    });
  });

  it("写真の料理 (1 つ) の枠を作り直しても、写真を残してジョブを積まない", async () => {
    const previous = buildPhotoDishList([{ name: "親子丼", role: "main" }], PHOTO_URL);
    const row = await regenerate(previous, [aiDish("鮭の塩焼き")]);

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [] }));
    expect(triggerMock).not.toHaveBeenCalled();
    expect(row.dishes[0]).toMatchObject({ name: "鮭の塩焼き", image_url: PHOTO_URL, image_source: "meal_photo", image_status: "ready", image_subject_hash: null });
    expect(row.image_url).toBe(PHOTO_URL);
  });

  it("写真の料理 (複数) の枠を作り直しても、写真の料理の状態を写し、ジョブを積まない", async () => {
    const previous = buildPhotoDishList([{ name: "親子丼", role: "main" }, { name: "味噌汁", role: "soup" }], PHOTO_URL);
    const row = await regenerate(previous, [aiDish("鮭の塩焼き"), aiDish("けんちん汁", "soup")]);

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [] }));
    expect(row.dishes.map((dish) => [dish.image_source, dish.image_status, dish.image_url])).toEqual([
      ["meal_photo", "stale", null],
      ["meal_photo", "stale", null],
    ]);
    expect(row.image_url).toBe(PHOTO_URL);
  });
});
