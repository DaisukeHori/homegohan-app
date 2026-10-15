/**
 * Edge Function の料理画像のジョブの積み方 (supabase/functions/_shared/meal-image-jobs.ts の enqueueMealImageJobs。#1505)
 *
 * 以前は 1 回の upsert (onConflict: 'idempotency_key', ignoreDuplicates) で積んでいた。冪等キーの一意な索引
 * (meal_image_jobs_idempotency_pending_idx) は待ち・処理中だけの部分索引なので、ON CONFLICT が索引を推論できず
 * 42P10 で必ず失敗し、エラーも見ていなかった。そのため献立の生成 (generate-menu-v4 / v5 の saveMealToDb) の料理画像のジョブが
 * 1 行も積まれていなかった。Next.js の lib/meal-image-jobs.ts (#1487) と同じく、行ごとに insert し、
 * 一意制約の違反 (23505) は重複として数える。書き込みに失敗した料理は、保存済みの献立の上で 'failed' + 'enqueue_failed' にする。
 *
 * 実 DB の部分索引に対して積めることは tests/integration/rls/meal-image-enqueue.test.ts で確かめる。
 */
import { describe, expect, it, vi } from "vitest";

import { enqueueMealImageJobs } from "../supabase/functions/_shared/meal-image-jobs";
import {
  MEAL_IMAGE_ENQUEUE_FAILED_ERROR,
  buildMealImageIdempotencyKey,
  type MealImageDish,
  type MealImageJobSeed,
} from "../supabase/functions/_shared/meal-image";

type InsertOutcome = { code: string; message: string } | null | "throw";

const UNIQUE_VIOLATION = { code: "23505", message: 'duplicate key value violates unique constraint "meal_image_jobs_idempotency_pending_idx"' };
const INVALID_UUID = { code: "22P02", message: 'invalid input syntax for type uuid: "req-1"' };

function seed(dishIndex: number, overrides: Partial<MealImageJobSeed> = {}): MealImageJobSeed {
  return {
    dishIndex,
    dishName: `料理${dishIndex}`,
    subjectHash: `hash-${dishIndex}`,
    prompt: `prompt-${dishIndex}`,
    model: "gemini-3.1-flash-image-preview",
    referenceImageUrls: [],
    triggerSource: "generate-menu-v5:req-1",
    ...overrides,
  };
}

function pendingDish(dishIndex: number, overrides: Partial<MealImageDish> = {}): MealImageDish {
  return {
    name: `料理${dishIndex}`,
    image_url: null,
    image_source: "generated_ai",
    image_status: "pending",
    image_subject_hash: `hash-${dishIndex}`,
    image_error: null,
    ...overrides,
  };
}

/** Edge の service role のクライアントの作り物。meal_image_jobs の insert の結果を行ごとに決め、planned_meals の読み書きを記録する */
function makeEdgeDb(params: { outcomeOf: (row: Record<string, unknown>, index: number) => InsertOutcome; dishes?: MealImageDish[] | null }) {
  const inserted: Array<Record<string, unknown>> = [];
  const upsert = vi.fn();
  const mealUpdates: Array<{ id: unknown; dishes: MealImageDish[] }> = [];
  let calls = 0;
  const from = vi.fn((table: string) => {
    if (table === "meal_image_jobs") {
      return {
        upsert,
        insert: vi.fn(async (row: Record<string, unknown>) => {
          const outcome = params.outcomeOf(row, calls++);
          if (outcome === "throw") throw new Error("network down");
          if (!outcome) inserted.push(row);
          return { data: null, error: outcome };
        }),
      };
    }
    if (table === "planned_meals") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: params.dishes === null ? null : { dishes: params.dishes ?? [] },
              error: null,
            }),
          }),
        }),
        update: (values: { dishes: MealImageDish[] }) => ({
          eq: async (_column: string, id: unknown) => {
            mealUpdates.push({ id, dishes: values.dishes });
            return { data: null, error: null };
          },
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { db: { from }, inserted, upsert, mealUpdates };
}

const base = { plannedMealId: "meal-1", userId: "user-1", requestId: "req-1" };

describe("Edge の料理画像のジョブの積み方 (#1505)", () => {
  it("行ごとに insert し (ON CONFLICT の upsert を使わない)、積めた行を数える。行の中身は Next.js 側と同じ", async () => {
    const queue = makeEdgeDb({ outcomeOf: () => null });
    const result = await enqueueMealImageJobs({
      ...base,
      supabase: queue.db,
      jobs: [seed(0, { referenceImageUrls: ["https://example.com/ref.png"] }), seed(1)],
    });

    expect(result).toEqual({ inserted: 2, duplicates: 0, duplicatesProcessing: 0, failed: 0 });
    expect(queue.upsert).not.toHaveBeenCalled();
    expect(queue.db.from).toHaveBeenCalledWith("meal_image_jobs");
    expect(queue.inserted.map((row) => row.dish_index)).toEqual([0, 1]);
    expect(queue.inserted[0]).toEqual({
      planned_meal_id: "meal-1",
      user_id: "user-1",
      dish_index: 0,
      job_kind: "dish",
      subject_hash: "hash-0",
      idempotency_key: await buildMealImageIdempotencyKey({ plannedMealId: "meal-1", dishIndex: 0, subjectHash: "hash-0" }),
      prompt: "prompt-0",
      model: "gemini-3.1-flash-image-preview",
      reference_image_urls: ["https://example.com/ref.png"],
      trigger_source: "generate-menu-v5:req-1",
      request_id: "req-1",
      status: "pending",
    });
    // 献立 (planned_meals) には触らない
    expect(queue.mealUpdates).toEqual([]);
  });

  it("一意制約の違反 (23505) は重複として数え、料理は待ちのまま (そのジョブが画像を作る)", async () => {
    const queue = makeEdgeDb({ outcomeOf: (_row, index) => (index === 0 ? UNIQUE_VIOLATION : null), dishes: [pendingDish(0), pendingDish(1)] });
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobs: [seed(0), seed(1)] });

    expect(result).toEqual({ inserted: 1, duplicates: 1, duplicatesProcessing: 0, failed: 0 });
    expect(queue.mealUpdates).toEqual([]);
  });

  it("書き込みに失敗した料理は、献立の上で failed + enqueue_failed にする (pending のまま残さない)。積めた料理は待ちのまま", async () => {
    const queue = makeEdgeDb({
      outcomeOf: (_row, index) => (index === 1 ? INVALID_UUID : null),
      dishes: [pendingDish(0), pendingDish(1)],
    });
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobs: [seed(0), seed(1)] });

    expect(result).toEqual({ inserted: 1, duplicates: 0, duplicatesProcessing: 0, failed: 1 });
    expect(queue.mealUpdates).toHaveLength(1);
    expect(queue.mealUpdates[0].id).toBe("meal-1");
    expect(queue.mealUpdates[0].dishes[0]).toMatchObject({ image_status: "pending", image_error: null });
    expect(queue.mealUpdates[0].dishes[1]).toMatchObject({ image_status: "failed", image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR, image_url: null });
  });

  it("insert が例外を投げても例外を投げず、失敗として数えて料理を failed にする", async () => {
    const queue = makeEdgeDb({ outcomeOf: () => "throw", dishes: [pendingDish(0)] });
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobs: [seed(0)] });

    expect(result).toEqual({ inserted: 0, duplicates: 0, duplicatesProcessing: 0, failed: 1 });
    expect(queue.mealUpdates[0].dishes[0]).toMatchObject({ image_status: "failed", image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR });
  });

  it("そのあいだに別の料理に変わった・画像ができた料理は、失敗にしない (献立を書かない)", async () => {
    const queue = makeEdgeDb({
      outcomeOf: () => INVALID_UUID,
      dishes: [pendingDish(0, { image_subject_hash: "hash-other" }), pendingDish(1, { image_url: "https://example.com/x.png", image_status: "ready" })],
    });
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobs: [seed(0), seed(1)] });

    expect(result).toEqual({ inserted: 0, duplicates: 0, duplicatesProcessing: 0, failed: 2 });
    expect(queue.mealUpdates).toEqual([]);
  });

  it("積むジョブが無ければ、何も書かない", async () => {
    const queue = makeEdgeDb({ outcomeOf: () => null });
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobs: [] });

    expect(result).toEqual({ inserted: 0, duplicates: 0, duplicatesProcessing: 0, failed: 0 });
    expect(queue.db.from).not.toHaveBeenCalled();
  });
});
