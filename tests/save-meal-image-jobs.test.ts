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

import { enqueueSavedMealImageJobs, saveMealToDb } from "../supabase/functions/_shared/save-meal.ts";
import { MEAL_IMAGE_ENQUEUE_FAILED_ERROR } from "../supabase/functions/_shared/meal-image.ts";
import { createRecordingSupabase, firstMethodOf, type RecordedQuery } from "./helpers/recording-supabase";

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

describe("#2206 G4 積み込みと処理の起動の例外を分ける (enqueueSavedMealImageJobs)", () => {
  /** 保存済みの献立の、画像を待つ料理 (ジョブ JOB の料理) */
  const PENDING_DISH = { name: "カレー", role: "main", image_source: "generated_ai", image_status: "pending", image_subject_hash: "hash-0", image_url: null };
  const SAVED_AT = "2026-11-04T00:00:00.000Z";

  /** service role のクライアント: 献立の読み取りは画像を待つ料理のある行、料理の書き込み (select('id')) は 1 行書けた */
  function serviceDb() {
    return createRecordingSupabase((query: RecordedQuery) => {
      if (query.table !== "planned_meals") throw new Error(`unexpected table: ${query.table}`);
      if (firstMethodOf(query) === "update") return { data: [{ id: "planned-meal-1" }] };
      return { data: { dishes: [PENDING_DISH], image_url: null, updated_at: SAVED_AT, catalog_product_id: null, source_type: null } };
    });
  }

  /** 料理を 'failed' + 'enqueue_failed' にした書き込み */
  function enqueueFailedMarks(queries: RecordedQuery[]) {
    return queries.filter((query) => {
      if (firstMethodOf(query) !== "update") return false;
      const values = query.calls[0].args[0] as { dishes?: Array<{ image_status?: string; image_error?: string }> };
      return values.dishes?.[0]?.image_status === "failed" && values.dishes[0].image_error === MEAL_IMAGE_ENQUEUE_FAILED_ERROR;
    });
  }

  beforeEach(() => {
    h.enqueue.mockReset();
    h.trigger.mockClear();
    h.jobs = [JOB];
    vi.stubGlobal("Deno", { env: { get: (name: string) => (name === "SUPABASE_URL" ? "http://supabase.test" : name === "SUPABASE_SERVICE_ROLE_KEY" ? "service-key" : undefined) } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function run() {
    const db = serviceDb();
    await enqueueSavedMealImageJobs({ supabase: db.client, plannedMealId: "planned-meal-1", userId: "user-1", jobs: [JOB], requestId: "req-1" });
    return db.queries;
  }

  it("積み込みが投げたら、処理を起こさず、ジョブの無い料理を見送りの状態 (failed + enqueue_failed) に書き直す。例外は外へ出さない", async () => {
    h.enqueue.mockRejectedValue(new Error("enqueue failed"));

    const queries = await run();

    expect(h.trigger).not.toHaveBeenCalled();
    const marks = enqueueFailedMarks(queries);
    expect(marks).toHaveLength(1);
    // 読んだときの updated_at の行にだけ書く (ワーカーと同時でも、そのあいだに書かれた画像を巻き戻さない)
    expect(marks[0].calls).toEqual(expect.arrayContaining([{ method: "eq", args: ["updated_at", SAVED_AT] }]));
  });

  it("処理の起動が投げても、料理は書き直さず、例外を外へ出さない (積んだジョブは定期の処理が拾う)", async () => {
    h.enqueue.mockResolvedValue({ inserted: 1, duplicates: 0, duplicatesProcessing: 0, failed: 0 });
    h.trigger.mockRejectedValueOnce(new Error("trigger failed"));

    const queries = await run();

    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(queries).toEqual([]);
  });

  it("saveMealToDb は、積み込みが投げても献立の保存を成功として返す", async () => {
    h.enqueue.mockRejectedValue(new Error("enqueue failed"));

    const result = await save();

    expect(result).toMatchObject({ outcome: "inserted", plannedMealId: "planned-meal-1" });
    expect(h.trigger).not.toHaveBeenCalled();
  });
});
