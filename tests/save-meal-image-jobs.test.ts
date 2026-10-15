/**
 * #1505 献立の生成 (generate-menu-v4 / v5 の saveMealToDb) が料理画像のジョブを積んだあと、処理を起こす条件
 *
 * saveMealToDb は料理 (planned_meals) を保存したあと、enqueueMealImageJobs (行ごとの insert) でジョブを積む。
 *   - 積めた行か、重複 (同じ料理のジョブが待ち・処理中) の行があれば、process-meal-image-jobs を起こす (待ちのジョブを処理させる)
 *   - 1 行も積めず重複も無い (書き込みの失敗だけ) なら起こさない (料理は enqueueMealImageJobs が 'failed' にする)
 *   - 積むジョブが無ければ起こさない
 * ジョブの積み方そのものは tests/meal-image-generation-contracts.test.ts、実 DB は tests/integration/rls/meal-image-enqueue.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enqueue: vi.fn(),
  trigger: vi.fn(async () => undefined),
  jobs: [] as Array<Record<string, unknown>>,
}));

vi.mock("../supabase/functions/_shared/v4-nutrition-adapter.ts", () => ({
  analyzeNutritionFromIngredientsV4: vi.fn(async () => {
    throw new Error("not used");
  }),
  validateAndAdjustNutritionV4: vi.fn(async () => {
    throw new Error("not used");
  }),
}));

// 料理画像の判定 (isCatalogProductMeal など。#1514) は本物を使い、reconcileDishImages だけを差し替える
vi.mock("../supabase/functions/_shared/meal-image.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../supabase/functions/_shared/meal-image.ts")>()),
  DEFAULT_MEAL_IMAGE_MODEL: "test-image-model",
  reconcileDishImages: vi.fn(async (params: { nextDishes: unknown[] }) => ({
    dishes: params.nextDishes.map(() => ({})),
    mealCoverImageUrl: null,
    jobs: h.jobs,
  })),
}));

vi.mock("../supabase/functions/_shared/meal-image-jobs.ts", () => ({
  enqueueMealImageJobs: h.enqueue,
  triggerMealImageJobProcessing: h.trigger,
}));

vi.mock("../supabase/functions/_shared/meal-nutrition-debug.ts", () => ({
  insertMealNutritionDebugLog: vi.fn(async () => null),
}));

import { saveMealToDb } from "../supabase/functions/_shared/save-meal.ts";

const JOB = {
  dishIndex: 0,
  dishName: "カレー",
  subjectHash: "hash-0",
  prompt: "prompt",
  model: "test-image-model",
  triggerSource: "generate-menu-v5:req-1",
  referenceImageUrls: [],
};

function makeFakeSupabase() {
  return {
    from(table: string) {
      if (table !== "planned_meals") throw new Error(`unexpected table: ${table}`);
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.insert = () => chain;
      chain.single = async () => ({ data: { id: "planned-meal-1" }, error: null });
      return chain;
    },
  };
}

async function save() {
  return saveMealToDb(makeFakeSupabase(), {
    userId: "user-1",
    requestId: "req-1",
    targetSlot: { date: "2026-10-12", mealType: "dinner" },
    generatedMeal: {
      mealType: "dinner",
      dishes: [{ name: "カレー", role: "main", ingredients: [], instructions: ["煮る"] }],
      advice: "",
    } as never,
    dailyMealIdByDate: new Map([["2026-10-12", "daily-meal-1"]]),
  });
}

describe("saveMealToDb: 料理画像のジョブを積んだあとに処理を起こす条件 (#1505)", () => {
  beforeEach(() => {
    h.enqueue.mockReset();
    h.trigger.mockClear();
    h.jobs = [JOB];
    // save-meal は処理を起こすときに Deno.env から接続先を読む (vitest は Node なので作り物を置く)
    vi.stubGlobal("Deno", { env: { get: (name: string) => (name === "SUPABASE_URL" ? "http://supabase.test" : name === "SUPABASE_SERVICE_ROLE_KEY" ? "service-key" : undefined) } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("積めた行があれば、その献立の待ちのジョブの処理を起こす", async () => {
    h.enqueue.mockResolvedValue({ inserted: 1, duplicates: 0, duplicatesProcessing: 0, failed: 0 });
    const result = await save();

    expect(result.outcome).toBe("inserted");
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0][0]).toMatchObject({ plannedMealId: "planned-meal-1", userId: "user-1", jobs: [JOB], requestId: "req-1" });
    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(h.trigger).toHaveBeenCalledWith({
      supabaseUrl: "http://supabase.test",
      serviceRoleKey: "service-key",
      plannedMealId: "planned-meal-1",
      limit: 1,
    });
  });

  it("重複だけ (同じ料理のジョブが待ち) でも、待ちのジョブを処理させるために起こす", async () => {
    h.enqueue.mockResolvedValue({ inserted: 0, duplicates: 1, duplicatesProcessing: 0, failed: 0 });
    await save();

    expect(h.trigger).toHaveBeenCalledTimes(1);
  });

  it("#1561 重複がどれも処理中なら起こさない (画像の処理は待ちのジョブだけを拾うので空振りになる)。待ちの重複と積めた行だけを limit に数える", async () => {
    h.enqueue.mockResolvedValue({ inserted: 0, duplicates: 2, duplicatesProcessing: 2, failed: 0 });
    await save();
    expect(h.trigger).not.toHaveBeenCalled();

    h.jobs = [JOB, { ...JOB, dishIndex: 1, subjectHash: "hash-1" }, { ...JOB, dishIndex: 2, subjectHash: "hash-2" }];
    h.enqueue.mockResolvedValue({ inserted: 1, duplicates: 2, duplicatesProcessing: 1, failed: 0 });
    await save();
    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(h.trigger).toHaveBeenCalledWith(expect.objectContaining({ plannedMealId: "planned-meal-1", limit: 2 }));
  });

  it("書き込みの失敗だけで待ちのジョブが無ければ、起こさない (料理は enqueueMealImageJobs が failed にする)", async () => {
    h.enqueue.mockResolvedValue({ inserted: 0, duplicates: 0, duplicatesProcessing: 0, failed: 1 });
    const result = await save();

    expect(result.outcome).toBe("inserted");
    expect(h.trigger).not.toHaveBeenCalled();
  });

  it("#1532 limit は積めた行と重複の数 (書き込みに失敗した行は数えない)。3 品のうち 1 品が失敗なら 2", async () => {
    h.jobs = [JOB, { ...JOB, dishIndex: 1, subjectHash: "hash-1" }, { ...JOB, dishIndex: 2, subjectHash: "hash-2" }];
    h.enqueue.mockResolvedValue({ inserted: 1, duplicates: 1, duplicatesProcessing: 0, failed: 1 });
    await save();

    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(h.trigger).toHaveBeenCalledWith(expect.objectContaining({ plannedMealId: "planned-meal-1", limit: 2 }));
  });

  it("積むジョブが無ければ、起こさない", async () => {
    h.jobs = [];
    h.enqueue.mockResolvedValue({ inserted: 0, duplicates: 0, duplicatesProcessing: 0, failed: 0 });
    await save();

    expect(h.trigger).not.toHaveBeenCalled();
  });
});
