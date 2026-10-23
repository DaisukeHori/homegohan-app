/**
 * AI が献立の枠を作り直す保存 (Edge の save-meal。plannedMealId を指定した更新) の料理の画像とカバー。
 * #1553: 料理が変わったら、前回の写真の料理 (buildPhotoDishList の出力) の写真・利用者のカバーを外し、新しい料理の AI の画像を作る。
 * 料理が同じまま (同じ数・同じ中身) なら外さない。
 * 商品の献立の古い商品の料理 (画像の項目なし) は、作り直しても商品の料理・商品の画像のまま
 * (#1487 の整合ゲート R1。献立の行の catalog_product_id / source_type を読む)。
 *
 * 料理の画像の組み立て (reconcileDishImages) は本物を使い、栄養計算・ジョブの積み方・DB だけを作り物にする
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveMealToDb } from "../supabase/functions/_shared/save-meal.ts";
import { buildDishImageSubjectHash, buildPhotoDishList, type MealImageDish } from "../supabase/functions/_shared/meal-image.ts";
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

describe("save-meal: AI の作り直しの料理の画像とカバー (#1553・#1487 の整合ゲート)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    analyzeMock.mockResolvedValue({
      normalizedIngredients: [],
      ingredientMatches: [],
      calculatedNutrition: { ...emptyNutrition(), calories_kcal: 400, carbs_g: 40 },
      timingMs: { normalize_ingredients_ms: 0, match_ingredients_ms: 0, calculate_dish_nutrition_ms: 0, total_ms: 0 },
    });
  });

  it("写真の料理 (1 つ) の枠を違う料理に作り直すと、写真を料理に写さず AI の画像のジョブを積み、写真のカバーを外す (#1553)", async () => {
    const previous = buildPhotoDishList([{ name: "親子丼", role: "main" }], PHOTO_URL);
    const row = await regenerate(previous, [aiDish("鮭の塩焼き")]);

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [expect.objectContaining({ dishIndex: 0 })] }));
    expect(row.dishes[0]).toMatchObject({ name: "鮭の塩焼き", image_url: null, image_source: "generated_ai", image_status: "stale" });
    expect(row.dishes[0].image_subject_hash).toBeTruthy();
    expect(row.image_url).toBeNull();
  });

  it("写真の料理 (複数) の枠を違う料理に作り直すと、主菜にだけ AI の画像のジョブを積み (汁物は画像の無い状態。billing/03 Q-16)、写真のカバーを外す (#1553)", async () => {
    const previous = buildPhotoDishList([{ name: "親子丼", role: "main" }, { name: "味噌汁", role: "soup" }], PHOTO_URL);
    const row = await regenerate(previous, [aiDish("鮭の塩焼き"), aiDish("けんちん汁", "soup")]);

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      jobs: [expect.objectContaining({ dishIndex: 0 })],
    }));
    expect(row.dishes.map((dish) => [dish.image_source, dish.image_status, dish.image_url])).toEqual([
      ["generated_ai", "stale", null],
      [null, null, null],
    ]);
    expect(row.image_url).toBeNull();
  });

  it("写真の料理の枠を同じ料理 (同じ数・同じ中身) で作り直したときは、写真もカバーも外さず、ジョブを積まない (#1553)", async () => {
    const previous = buildPhotoDishList([{ name: "親子丼", role: "main" }], PHOTO_URL);
    const row = await regenerate(previous, [{ name: "親子丼", role: "main", ingredients: [], instructions: [] } as never]);

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [] }));
    expect(triggerMock).not.toHaveBeenCalled();
    expect(row.dishes[0]).toMatchObject({ name: "親子丼", image_url: PHOTO_URL, image_source: "meal_photo", image_status: "ready", image_subject_hash: null });
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

  it("写真の料理 (複数) の枠を料理を増やして作り直すと、主菜にだけ AI の画像のジョブを積み (増えた料理と汁物は画像の無い状態。billing/03 Q-16)、写真のカバーを外す (#1553)", async () => {
    const previous = buildPhotoDishList([{ name: "親子丼", role: "main" }, { name: "味噌汁", role: "soup" }], PHOTO_URL);
    const row = await regenerate(previous, [aiDish("鮭の塩焼き"), aiDish("けんちん汁", "soup"), aiDish("お浸し", "side")]);

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      jobs: [expect.objectContaining({ dishIndex: 0 })],
    }));
    expect(row.dishes[2]).toMatchObject({ name: "お浸し", image_url: null, image_source: null, image_status: null });
    expect(row.image_url).toBeNull();
  });

  it("写真の料理 (複数) の枠を、料理の数だけ減らして (残った料理は同じ) 作り直すと、写真のカバーを外し、残った写真の料理も AI の画像の生成に回す (#1553)", async () => {
    const previous = buildPhotoDishList([{ name: "親子丼", role: "main" }, { name: "味噌汁", role: "soup" }], PHOTO_URL);
    const row = await regenerate(previous, [{ name: "親子丼", role: "main", ingredients: [], instructions: [] } as never]);

    // カバーが空・ジョブが 0 で、画像の無い写真の印の料理だけが残る献立にしない
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [expect.objectContaining({ dishIndex: 0, dishName: "親子丼" })] }));
    expect(row.dishes[0]).toMatchObject({ name: "親子丼", image_url: null, image_source: "generated_ai", image_status: "pending" });
    expect(row.dishes[0].image_subject_hash).toBeTruthy();
    expect(row.image_url).toBeNull();
  });

  it("写真の料理 (複数) の枠を、一部の料理だけ変えて作り直すと、同じまま残った写真の主菜は AI の画像の生成に回し、変わった汁物は画像の無い状態にする (billing/03 Q-16。#1553)", async () => {
    const previous = buildPhotoDishList([{ name: "親子丼", role: "main" }, { name: "味噌汁", role: "soup" }], PHOTO_URL);
    const row = await regenerate(previous, [{ name: "親子丼", role: "main", ingredients: [], instructions: [] } as never, aiDish("けんちん汁", "soup")]);

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      jobs: [expect.objectContaining({ dishIndex: 0 })],
    }));
    expect(row.dishes.map((dish) => [dish.image_source, dish.image_status, dish.image_url])).toEqual([
      ["generated_ai", "pending", null],
      [null, null, null],
    ]);
    expect(row.image_url).toBeNull();
  });

  it("手で付けた画像の料理 (1 品の PATCH の imageUrl) の枠を違う料理に作り直すと、手の画像とカバーを外して AI の画像のジョブを積む (#1553)", async () => {
    const manualUrl = "https://example.com/storage/generated/user-1/manual.png";
    const previous: MealImageDish[] = [
      { name: "カレー", role: "main", image_url: manualUrl, image_source: "manual_override", image_status: "ready", image_subject_hash: null },
    ];
    const row = await regenerate(previous, [aiDish("鮭の塩焼き")], { image_url: manualUrl });

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [expect.objectContaining({ dishIndex: 0 })] }));
    expect(row.dishes[0]).toMatchObject({ image_url: null, image_source: "generated_ai", image_status: "stale" });
    expect(row.image_url).toBeNull();
  });

  it("前提との対比: 商品の献立でない手入力の料理 (画像の項目なし) の枠を作り直すと、今までどおり AI の画像のジョブを積む", async () => {
    const previous: MealImageDish[] = [{ name: "カレー", role: "main" }];
    const row = await regenerate(previous, [aiDish("鮭の塩焼き")], { image_url: null });

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [expect.objectContaining({ dishIndex: 0 })] }));
    expect(row.dishes[0]).toMatchObject({ image_source: "generated_ai", image_status: "stale", image_url: null });
  });

  it("カバーの持ち主: 利用者が付けたカバー (どの AI の料理の画像とも一致しない) は、AI の料理の枠を違う料理に作り直すと外す (#1553)", async () => {
    const userCover = "https://example.com/storage/generated/user-1/user-made.png";
    const previous: MealImageDish[] = [
      { name: "カレー", role: "main", image_url: "https://example.com/ai-0.png", image_source: "generated_ai", image_status: "ready", image_subject_hash: "h0" },
      { name: "サラダ", role: "side", image_url: "https://example.com/ai-1.png", image_source: "generated_ai", image_status: "ready", image_subject_hash: "h1" },
    ];
    const row = await regenerate(previous, [aiDish("鮭の塩焼き"), aiDish("お浸し", "side")], { image_url: userCover });

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [expect.objectContaining({ dishIndex: 0 })] }));
    expect(row.image_url).toBeNull();
  });

  it("カバーの持ち主: 利用者が付けたカバーは、AI の料理の枠を同じ料理 (同じ数・同じ中身) で作り直したときは残す (#1553)", async () => {
    const userCover = "https://example.com/storage/generated/user-1/user-made.png";
    const sameDish = { name: "鮭の塩焼き", role: "main", ingredients: [], displayOrder: 0 };
    const subjectHash = await buildDishImageSubjectHash(sameDish, 0);
    const previous: MealImageDish[] = [
      { ...sameDish, image_url: "https://example.com/ai-0.png", image_source: "generated_ai", image_status: "ready", image_subject_hash: subjectHash },
    ];
    const row = await regenerate(previous, [{ name: "鮭の塩焼き", role: "main", ingredients: [], instructions: [] } as never], { image_url: userCover });

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [] }));
    expect(row.dishes[0]).toMatchObject({ image_url: "https://example.com/ai-0.png", image_source: "generated_ai", image_status: "ready" });
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

  it("billing/03 Q-16: 主菜・副菜・汁物の新しい献立を作ると、主菜の 1 品だけにジョブを積み、副菜と汁物は画像の無い状態で保存する", async () => {
    const row = await regenerate([], [aiDish("鮭の塩焼き"), aiDish("お浸し", "side"), aiDish("味噌汁", "soup")], { image_url: null });

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [expect.objectContaining({ dishIndex: 0 })] }));
    expect(row.dishes[0]).toMatchObject({ name: "鮭の塩焼き", image_source: "generated_ai", image_status: "pending", image_url: null });
    for (const index of [1, 2]) {
      expect(row.dishes[index], String(index)).toMatchObject({ image_source: null, image_status: null, image_url: null, image_subject_hash: null });
    }
  });

  it("billing/03 Q-16: 写真の料理 (複数) の枠を主菜だけ変えて作り直すと、主菜にだけ AI の画像のジョブを積み (stale)、同じまま残った写真の汁物は画像の無い状態にし (写真の印も外れる)、写真のカバーを外す", async () => {
    const previous = buildPhotoDishList([{ name: "親子丼", role: "main" }, { name: "味噌汁", role: "soup" }], PHOTO_URL);
    const row = await regenerate(previous, [aiDish("鮭の塩焼き"), { name: "味噌汁", role: "soup", ingredients: [], instructions: [] } as never]);

    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobs: [expect.objectContaining({ dishIndex: 0 })] }));
    expect(row.dishes.map((dish) => [dish.image_source, dish.image_status, dish.image_url])).toEqual([
      ["generated_ai", "stale", null],
      [null, null, null],
    ]);
    expect(row.dishes[1].image_subject_hash).toBeNull();
    expect(row.image_url).toBeNull();
  });
});
