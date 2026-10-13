/**
 * #1487 の整合ゲート: AI が献立の枠を作り直す保存 (Edge の save-meal。plannedMealId を指定した更新) でも、
 * 前回の写真の料理 (buildPhotoDishList の出力。subject_hash を持たない) の画像を AI の画像で置き換えない。
 * 商品の献立の古い商品の料理 (画像の項目なし) も同じ (整合ゲート R1。献立の行の catalog_product_id / source_type を読む)。
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
const PRODUCT_URL = "https://example.com/catalog/bento.jpg";

/** 献立の行の、料理以外 (カバー・商品) */
interface ExistingMealRow {
  image_url: string | null;
  catalog_product_id?: string | null;
  source_type?: string | null;
}

/** select の列の指定の、列 (埋め込みは表の名前) の一覧 (入口が名指しした列だけを返すため) */
function selectedColumns(columns: unknown): Set<string> | null {
  if (typeof columns !== "string" || columns.trim() === "" || columns.trim() === "*") return null;
  const names: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of columns) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      names.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  names.push(current);
  return new Set(names.map((name) => name.trim().split(/[!(:\s]/)[0]).filter(Boolean));
}

/** 既存の献立 (写真・商品の料理) を読み、更新を記録する DB の作り物。献立の行は select で名指しした列だけを返す */
function makeFakeSupabase(existingDishes: MealImageDish[], existingRow: ExistingMealRow = { image_url: PHOTO_URL }) {
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      let op: "select" | "update" | "upsert" = "select";
      let readColumns: Set<string> | null = null;
      chain.select = (columns?: unknown) => {
        if (op === "select") readColumns = selectedColumns(columns);
        return chain;
      };
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
          const row: Record<string, unknown> = {
            id: MEAL_ID,
            dishes: existingDishes,
            catalog_product_id: null,
            source_type: null,
            ...existingRow,
            user_daily_meals: { user_id: USER_ID },
          };
          const columns = readColumns;
          return { data: columns ? Object.fromEntries(Object.entries(row).filter(([key]) => columns.has(key))) : row, error: null };
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

async function regenerate(existingDishes: MealImageDish[], dishes: ReturnType<typeof aiDish>[], existingRow?: ExistingMealRow) {
  const { client, updates } = makeFakeSupabase(existingDishes, existingRow);
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

  it("商品の献立の古い商品の料理 (画像の項目なし) の枠を作り直しても、商品の料理として残してジョブを積まず、カバーは商品の画像のまま (整合ゲート R1)", async () => {
    const previous: MealImageDish[] = [{ name: "幕の内弁当", role: "main", calories_kcal: 650 }];
    const row = await regenerate(previous, [aiDish("鮭の塩焼き")], { image_url: PRODUCT_URL, catalog_product_id: "catalog-1", source_type: "catalog_product" });

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [] }));
    expect(triggerMock).not.toHaveBeenCalled();
    expect(row.dishes[0]).toMatchObject({ name: "鮭の塩焼き", image_url: null, image_source: "catalog", image_status: null, image_subject_hash: null });
    expect(row.image_url).toBe(PRODUCT_URL);
  });

  it("写真の料理 (複数) の枠を料理を増やして作り直しても、増えた料理に積まず (状態なし)、カバーは写真のまま (整合ゲート R1)", async () => {
    const previous = buildPhotoDishList([{ name: "親子丼", role: "main" }, { name: "味噌汁", role: "soup" }], PHOTO_URL);
    const row = await regenerate(previous, [aiDish("鮭の塩焼き"), aiDish("けんちん汁", "soup"), aiDish("お浸し", "side")]);

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [] }));
    expect(row.dishes[2]).toMatchObject({ name: "お浸し", image_url: null, image_source: null, image_status: null, image_subject_hash: null });
    expect(row.image_url).toBe(PHOTO_URL);
  });

  it("前提との対比: 商品の献立でない手入力の料理 (画像の項目なし) の枠を作り直すと、今までどおり AI の画像のジョブを積む", async () => {
    const previous: MealImageDish[] = [{ name: "カレー", role: "main" }];
    const row = await regenerate(previous, [aiDish("鮭の塩焼き")], { image_url: null });

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [expect.objectContaining({ dishIndex: 0 })] }));
    expect(row.dishes[0]).toMatchObject({ image_source: "generated_ai", image_status: "stale", image_url: null });
  });

  it("カバーの持ち主: 利用者が付けたカバー (どの AI の料理の画像とも一致しない) は、AI の料理の枠を作り直しても残す", async () => {
    const userCover = "https://example.com/storage/generated/user-1/user-made.png";
    const previous: MealImageDish[] = [
      { name: "カレー", role: "main", image_url: "https://example.com/ai-0.png", image_source: "generated_ai", image_status: "ready", image_subject_hash: "h0" },
      { name: "サラダ", role: "side", image_url: "https://example.com/ai-1.png", image_source: "generated_ai", image_status: "ready", image_subject_hash: "h1" },
    ];
    const row = await regenerate(previous, [aiDish("鮭の塩焼き"), aiDish("お浸し", "side")], { image_url: userCover });

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [expect.objectContaining({ dishIndex: 0 }), expect.objectContaining({ dishIndex: 1 })] }));
    expect(row.image_url).toBe(userCover);
  });

  it("カバーの持ち主: 前の AI の料理の画像だったカバーは、作り直した料理の画像ができるまで空にする (前の料理の画像を残さない)", async () => {
    const previous: MealImageDish[] = [
      { name: "カレー", role: "main", image_url: "https://example.com/ai-0.png", image_source: "generated_ai", image_status: "ready", image_subject_hash: "h0" },
    ];
    const row = await regenerate(previous, [aiDish("鮭の塩焼き")], { image_url: "https://example.com/ai-0.png" });

    expect(row.dishes[0]).toMatchObject({ image_source: "generated_ai", image_status: "stale", image_url: null });
    expect(row.image_url).toBeNull();
  });
});
