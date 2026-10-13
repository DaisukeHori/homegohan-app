/**
 * #1505 料理画像のジョブの積み方の共通部分 (supabase/functions/_shared/meal-image.ts)。Next.js と Edge Function の両方が使う
 *
 *   1. buildMealImageJobRecords: trigger_source は渡したもの、無ければジョブのもの。priority・時刻は列の既定値に任せる
 *   2. insertMealImageJobRecords: 23505 は重複、それ以外のエラー・例外は失敗 (例外は投げない)
 *   3. markDishImagesEnqueueFailed: 積めなかった同じ料理の、画像が無い待ち・更新待ちだけを failed + enqueue_failed にする
 *      写真・商品・手の画像の料理と、商品の献立の画像の項目の無い古い商品の料理 (#1514 で AI の画像のジョブを積まない料理) は変えない
 *   4. markEnqueueFailedDishesInMeal: 読めない・無い・書けないときも例外を投げずに結果を返す。商品の献立かを読んだ行から見る。
 *      料理 (dishes) だけを書き、献立のカバーには触れない
 */
import { describe, expect, it, vi } from "vitest";

import {
  MEAL_IMAGE_ENQUEUE_FAILED_ERROR,
  MEAL_IMAGE_JOB_UNIQUE_VIOLATION_CODE,
  buildMealImageJobRecords,
  insertMealImageJobRecords,
  isMealImageSkippedError,
  markDishImagesEnqueueFailed,
  markEnqueueFailedDishesInMeal,
  needsImageRetry,
  summarizeMealImageJobOutcomes,
  type MealImageDish,
  type MealImageJobSeed,
} from "../supabase/functions/_shared/meal-image";

const SEED: MealImageJobSeed = {
  dishIndex: 2,
  dishName: "味噌汁",
  subjectHash: "hash-2",
  prompt: "prompt",
  model: "model",
  triggerSource: "seed-source",
  referenceImageUrls: [],
};

describe("buildMealImageJobRecords", () => {
  it("trigger_source は渡したものを優先し、無ければジョブのものを使う。priority・created_at・updated_at は書かない", async () => {
    const [explicit] = await buildMealImageJobRecords({ plannedMealId: "m", userId: "u", seeds: [SEED], triggerSource: "route" });
    const [fromSeed] = await buildMealImageJobRecords({ plannedMealId: "m", userId: "u", seeds: [SEED] });

    expect(explicit.trigger_source).toBe("route");
    expect(fromSeed.trigger_source).toBe("seed-source");
    expect(fromSeed.request_id).toBeNull();
    expect(Object.keys(fromSeed)).not.toEqual(expect.arrayContaining(["priority"]));
    expect(Object.keys(fromSeed)).not.toEqual(expect.arrayContaining(["created_at"]));
  });
});

describe("insertMealImageJobRecords / summarizeMealImageJobOutcomes", () => {
  it("23505 は重複、ほかのエラー・例外は失敗 (コードと文を残す)。例外は投げない", async () => {
    const records = await buildMealImageJobRecords({
      plannedMealId: "m",
      userId: "u",
      seeds: [0, 1, 2, 3].map((dishIndex) => ({ ...SEED, dishIndex, subjectHash: `hash-${dishIndex}` })),
    });
    const insertJob = vi.fn(async (record: { dish_index: number }) => {
      if (record.dish_index === 1) return { error: { code: MEAL_IMAGE_JOB_UNIQUE_VIOLATION_CODE, message: "dup" } };
      if (record.dish_index === 2) return { error: { code: "42501", message: "permission denied" } };
      if (record.dish_index === 3) throw new Error("network down");
      return { error: null };
    });

    const outcomes = await insertMealImageJobRecords(records, insertJob);

    expect(insertJob).toHaveBeenCalledTimes(4);
    expect(outcomes).toEqual([
      { kind: "inserted", dishIndex: 0, subjectHash: "hash-0" },
      { kind: "duplicate", dishIndex: 1, subjectHash: "hash-1" },
      { kind: "failed", dishIndex: 2, subjectHash: "hash-2", code: "42501", message: "permission denied" },
      { kind: "failed", dishIndex: 3, subjectHash: "hash-3", code: null, message: "network down" },
    ]);
    expect(summarizeMealImageJobOutcomes(outcomes)).toEqual({ inserted: 1, duplicates: 1, failed: 2 });
  });
});

describe("markDishImagesEnqueueFailed", () => {
  const pending = (overrides: Partial<MealImageDish> = {}): MealImageDish => ({
    image_url: null,
    image_source: "generated_ai",
    image_status: "pending",
    image_subject_hash: "hash-0",
    ...overrides,
  });

  it("同じ料理で画像が無い待ち・更新待ちだけを failed + enqueue_failed にする。元の配列は変えない", () => {
    const dishes = [pending(), pending({ image_status: "stale", image_subject_hash: "hash-1" }), pending({ image_subject_hash: "hash-2" })];
    const result = markDishImagesEnqueueFailed(dishes, [
      { dishIndex: 0, subjectHash: "hash-0" },
      { dishIndex: 1, subjectHash: "hash-1" },
    ]);

    expect(result.changed).toBe(true);
    expect(result.dishes[0]).toMatchObject({ image_status: "failed", image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR, image_generated_at: null });
    expect(result.dishes[1]).toMatchObject({ image_status: "failed", image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR });
    expect(result.dishes[2]).toBe(dishes[2]);
    expect(dishes[0].image_status).toBe("pending");
    // 見送り (安全弁・レート制限) ではない失敗として出す。保存し直せば積み直す
    expect(isMealImageSkippedError(MEAL_IMAGE_ENQUEUE_FAILED_ERROR)).toBe(false);
    expect(needsImageRetry(result.dishes[0])).toBe(true);
  });

  it.each([
    ["別の料理に変わった", pending({ image_subject_hash: "hash-other" })],
    ["画像がある", pending({ image_url: "https://example.com/x.png", image_status: "ready" })],
    ["すでに失敗", pending({ image_status: "failed", image_error: "storage upload failed" })],
    // #1514: 写真・商品・手の画像の料理は AI の画像のジョブを積まない料理なので、積めなかった扱いにもしない
    ["写真の (複数の料理の、画像の無い 'stale' の)", pending({ image_source: "meal_photo", image_status: "stale" })],
    ["商品の", pending({ image_source: "catalog" })],
    ["手で付けた画像の", pending({ image_source: "manual_override", image_status: "stale" })],
    ["画像なし (none) の", pending({ image_source: "none" })],
  ])("%s料理は変えない", (_label, dish) => {
    const result = markDishImagesEnqueueFailed([dish], [{ dishIndex: 0, subjectHash: "hash-0" }]);
    expect(result.changed).toBe(false);
    expect(result.dishes[0]).toBe(dish);
  });

  it("商品の献立の、画像の項目の無い古い商品の料理 (先頭) は変えない。商品の献立でなければ同じ料理を failed にする (#1514 の asCatalogMealDish)", () => {
    const legacyCatalogDish = pending({ image_source: null });
    const failures = [{ dishIndex: 0, subjectHash: "hash-0" }];

    const asCatalog = markDishImagesEnqueueFailed([legacyCatalogDish], failures, { mealIsCatalog: true });
    expect(asCatalog.changed).toBe(false);
    expect(asCatalog.dishes[0]).toBe(legacyCatalogDish);

    const notCatalog = markDishImagesEnqueueFailed([legacyCatalogDish], failures, { mealIsCatalog: false });
    expect(notCatalog.changed).toBe(true);
    expect(notCatalog.dishes[0]).toMatchObject({ image_status: "failed", image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR });

    // 商品の献立でも、商品の料理の位置 (先頭) でない料理は AI の画像の料理として扱う
    const second = markDishImagesEnqueueFailed([pending({ image_subject_hash: "hash-x" }), pending({ image_subject_hash: "hash-1" })], [
      { dishIndex: 1, subjectHash: "hash-1" },
    ], { mealIsCatalog: true });
    expect(second.dishes[1]).toMatchObject({ image_status: "failed", image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR });
  });
});

describe("markEnqueueFailedDishesInMeal", () => {
  const failures = [{ dishIndex: 0, subjectHash: "hash-0" }];
  const stored: MealImageDish[] = [{ image_status: "pending", image_url: null, image_subject_hash: "hash-0" }];

  it("待ちの料理を failed にして書く", async () => {
    const saveDishes = vi.fn(async () => ({ error: null }));
    const result = await markEnqueueFailedDishesInMeal({ failures, loadMeal: async () => ({ data: { dishes: stored }, error: null }), saveDishes });

    expect(result).toEqual({ status: "updated" });
    expect(saveDishes).toHaveBeenCalledWith([expect.objectContaining({ image_status: "failed", image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR })]);
  });

  it("商品の献立 (catalog_product_id / source_type) の古い商品の料理は書かない (#1514)", async () => {
    const saveDishes = vi.fn(async () => ({ error: null }));
    expect(
      await markEnqueueFailedDishesInMeal({ failures, loadMeal: async () => ({ data: { dishes: stored, catalog_product_id: "product-1" }, error: null }), saveDishes }),
    ).toEqual({ status: "unchanged" });
    expect(
      await markEnqueueFailedDishesInMeal({ failures, loadMeal: async () => ({ data: { dishes: stored, source_type: "catalog_product" }, error: null }), saveDishes }),
    ).toEqual({ status: "unchanged" });
    expect(saveDishes).not.toHaveBeenCalled();
  });

  it("失敗が無ければ読まない。献立が無い・変える料理が無いときは書かない", async () => {
    const loadMeal = vi.fn(async () => ({ data: { dishes: stored }, error: null }));
    const saveDishes = vi.fn(async () => ({ error: null }));

    expect(await markEnqueueFailedDishesInMeal({ failures: [], loadMeal, saveDishes })).toEqual({ status: "unchanged" });
    expect(loadMeal).not.toHaveBeenCalled();
    expect(await markEnqueueFailedDishesInMeal({ failures, loadMeal: async () => ({ data: null, error: null }), saveDishes })).toEqual({ status: "not_found" });
    expect(
      await markEnqueueFailedDishesInMeal({ failures, loadMeal: async () => ({ data: { dishes: "not-an-array" }, error: null }), saveDishes }),
    ).toEqual({ status: "unchanged" });
    expect(saveDishes).not.toHaveBeenCalled();
  });

  it("読めない・書けない・例外のときも例外を投げず、error と文を返す", async () => {
    const ok = async () => ({ data: { dishes: stored }, error: null });
    expect(
      await markEnqueueFailedDishesInMeal({ failures, loadMeal: async () => ({ data: null, error: { message: "read failed" } }), saveDishes: async () => ({ error: null }) }),
    ).toEqual({ status: "error", message: "read failed" });
    expect(await markEnqueueFailedDishesInMeal({ failures, loadMeal: ok, saveDishes: async () => ({ error: { message: "write failed" } }) })).toEqual({
      status: "error",
      message: "write failed",
    });
    expect(
      await markEnqueueFailedDishesInMeal({
        failures,
        loadMeal: async () => {
          throw new Error("boom");
        },
        saveDishes: async () => ({ error: null }),
      }),
    ).toEqual({ status: "error", message: "boom" });
  });
});
