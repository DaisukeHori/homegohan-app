/**
 * #1505 料理画像のジョブの積み方の共通部分 (supabase/functions/_shared/meal-image.ts)。Next.js と Edge Function の両方が使う
 *
 *   1. buildMealImageJobRecords: trigger_source は渡したもの、無ければジョブのもの。priority・時刻は列の既定値に任せる
 *   2. insertMealImageJobRecords: 23505 は重複、それ以外のエラー・例外は失敗 (例外は投げない)
 *   3. markDishImagesEnqueueFailed: 積めなかった同じ料理の、画像が無い待ち・更新待ちだけを failed + enqueue_failed にする
 *      写真・商品・手の画像の料理と、商品の献立の画像の項目の無い古い商品の料理 (#1514 で AI の画像のジョブを積まない料理) は変えない
 *   4. markEnqueueFailedDishesInMeal: 読めない・無い・書けないときも例外を投げずに結果を返す。商品の献立かを読んだ行から見る。
 *      料理 (dishes) だけを書き、献立のカバーには触れない。読んだときの updated_at の行にだけ書き、0 行なら読み直して当て直す (#1532)
 */
import { describe, expect, it, vi } from "vitest";

import {
  MEAL_IMAGE_ENQUEUE_FAILED_ERROR,
  MEAL_IMAGE_JOB_UNIQUE_VIOLATION_CODE,
  buildMealImageJobRecords,
  insertMealImageJobRecords,
  isMealImageSkippedError,
  markDishImagesEnqueueFailed,
  MEAL_DISH_WRITE_MAX_ATTEMPTS,
  markEnqueueFailedDishesInMeal,
  needsImageRetry,
  summarizeMealImageJobOutcomes,
  type MealImageDish,
  type MealImageJobSeed,
  type PlannedMealWriter,
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

/** 積めなかった料理の印付けで読む献立の行の作り物 (planned_meals の 1 行。ENQUEUE_FAILED_MEAL_COLUMNS の列) */
interface FakeMealRow {
  dishes: unknown;
  image_url: string | null;
  updated_at: string | null;
  catalog_product_id?: string | null;
  source_type?: string | null;
}

/**
 * planned_meals の 1 行の作り物。update の条件 (eq / is) を本当に評価し、当たれば値を書いて updated_at を進める
 * (本物の trg_planned_meals_updated_at と同じく、どの書き手が書いても変わる)
 */
function makeMealTable(initial: FakeMealRow | null, options: { writeError?: { message: string } } = {}) {
  let row: FakeMealRow | null = initial ? structuredClone(initial) : null;
  let tick = 0;
  const updates: Array<{ values: Record<string, unknown>; filters: Array<[string, string, unknown]>; matched: boolean }> = [];
  const bump = (): string => {
    tick += 1;
    return `2026-10-14T00:00:0${tick}.000000+00:00`;
  };

  const db: PlannedMealWriter = {
    from: () => ({
      update: (values) => {
        const record = { values, filters: [] as Array<[string, string, unknown]>, matched: false };
        const filter = {
          eq: (column: string, value: string) => {
            record.filters.push(["eq", column, value]);
            return filter;
          },
          is: (column: string, value: null) => {
            record.filters.push(["is", column, value]);
            return filter;
          },
          select: async () => {
            updates.push(record);
            if (options.writeError) return { data: null, error: options.writeError };
            const current = row as Record<string, unknown> | null;
            const byColumn = (column: string) => (column === "id" ? MEAL_ID : current?.[column]);
            record.matched = current !== null && record.filters.every(([, column, value]) => byColumn(column) === value);
            if (record.matched && row) row = { ...row, ...structuredClone(values), updated_at: bump() } as FakeMealRow;
            return { data: record.matched ? [{ id: MEAL_ID }] : [], error: null };
          },
        };
        return filter;
      },
    }),
  };

  return {
    db,
    updates,
    get row(): FakeMealRow | null {
      return row;
    },
    /** loadMeal の形 (書き込みの値を共有しないように写しを返す) */
    loadMeal: vi.fn(async () => ({ data: row ? structuredClone(row) : null, error: null })),
    /** ワーカー・利用者の保存など、ほかの書き手が条件なしで書く (updated_at が進む) */
    writeDirectly(values: Partial<FakeMealRow>): void {
      if (!row) throw new Error("row deleted");
      row = { ...row, ...structuredClone(values), updated_at: bump() };
    },
  };
}

const MEAL_ID = "meal-1";
const READ_AT = "2026-10-14T00:00:00.000000+00:00";

describe("markEnqueueFailedDishesInMeal", () => {
  const failures = [{ dishIndex: 0, subjectHash: "hash-0" }];
  const stored: MealImageDish[] = [{ image_status: "pending", image_url: null, image_subject_hash: "hash-0" }];
  const storedRow = (extra: Partial<FakeMealRow> = {}): FakeMealRow => ({ dishes: stored, image_url: null, updated_at: READ_AT, ...extra });

  it("待ちの料理を failed にして、読んだときの updated_at の行にだけ書く。カバー (image_url) には触れない", async () => {
    const table = makeMealTable(storedRow({ image_url: "https://example.com/cover.png" }));
    const result = await markEnqueueFailedDishesInMeal({ failures, mealId: MEAL_ID, db: table.db, loadMeal: table.loadMeal });

    expect(result).toEqual({ status: "updated" });
    expect(table.updates).toHaveLength(1);
    expect(table.updates[0].filters).toEqual([
      ["eq", "id", MEAL_ID],
      ["eq", "updated_at", READ_AT],
    ]);
    expect(table.updates[0].values).not.toHaveProperty("image_url");
    expect(table.row?.dishes).toEqual([expect.objectContaining({ image_status: "failed", image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR })]);
    expect(table.row?.image_url).toBe("https://example.com/cover.png");
  });

  it("updated_at が null の行は is null を条件にする", async () => {
    const table = makeMealTable(storedRow({ updated_at: null }));
    expect(await markEnqueueFailedDishesInMeal({ failures, mealId: MEAL_ID, db: table.db, loadMeal: table.loadMeal })).toEqual({ status: "updated" });
    expect(table.updates[0].filters).toEqual([
      ["eq", "id", MEAL_ID],
      ["is", "updated_at", null],
    ]);
  });

  it("#1532 読んでから書くまでにワーカーが別の料理の画像を書いたら (0 行)、読み直して当て直し、その画像を巻き戻さない", async () => {
    const worker: MealImageDish = { image_status: "ready", image_url: "https://example.com/dish-1.png", image_subject_hash: "hash-1" };
    const twoDishes: MealImageDish[] = [stored[0], { image_status: "pending", image_url: null, image_subject_hash: "hash-1" }];
    const table = makeMealTable(storedRow({ dishes: twoDishes }));
    let reads = 0;
    const loadMeal = async () => {
      const loaded = await table.loadMeal();
      reads += 1;
      // 最初に読んだ直後に、別の料理のワーカーが条件なしで書く (updated_at が進む)
      if (reads === 1) table.writeDirectly({ dishes: [twoDishes[0], worker] });
      return loaded;
    };

    const result = await markEnqueueFailedDishesInMeal({ failures, mealId: MEAL_ID, db: table.db, loadMeal });

    expect(result).toEqual({ status: "updated" });
    expect(reads).toBe(2);
    expect(table.updates.map((u) => u.matched)).toEqual([false, true]);
    expect(table.row?.dishes).toEqual([
      expect.objectContaining({ image_status: "failed", image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR }),
      worker,
    ]);
  });

  it("#1532 読み直したら料理がもう待ちでない (そのあいだに画像が付いた) なら、書かずに unchanged", async () => {
    const table = makeMealTable(storedRow());
    let reads = 0;
    const loadMeal = async () => {
      const loaded = await table.loadMeal();
      reads += 1;
      if (reads === 1) table.writeDirectly({ dishes: [{ image_status: "ready", image_url: "https://example.com/dish-0.png", image_subject_hash: "hash-0" }] });
      return loaded;
    };

    expect(await markEnqueueFailedDishesInMeal({ failures, mealId: MEAL_ID, db: table.db, loadMeal })).toEqual({ status: "unchanged" });
    expect(table.updates).toHaveLength(1);
    expect(table.row?.dishes).toEqual([expect.objectContaining({ image_status: "ready", image_url: "https://example.com/dish-0.png" })]);
  });

  it(`#1532 ${MEAL_DISH_WRITE_MAX_ATTEMPTS} 回続けて負けたら書くのをやめ、error を返す (例外は投げない)`, async () => {
    const table = makeMealTable(storedRow());
    // 読むたびに、書く前にほかの書き手が書く (毎回 0 行になる)
    const loadMeal = async () => {
      const loaded = await table.loadMeal();
      table.writeDirectly({ dishes: stored });
      return loaded;
    };

    const result = await markEnqueueFailedDishesInMeal({ failures, mealId: MEAL_ID, db: table.db, loadMeal });

    expect(result).toEqual({
      status: "error",
      message: `failed to update meal: the meal kept changing while writing (${MEAL_DISH_WRITE_MAX_ATTEMPTS} attempts)`,
    });
    expect(table.updates).toHaveLength(MEAL_DISH_WRITE_MAX_ATTEMPTS);
    expect(table.updates.every((u) => !u.matched)).toBe(true);
    expect(table.row?.dishes).toEqual(stored);
  });

  it("商品の献立 (catalog_product_id / source_type) の古い商品の料理は書かない (#1514)", async () => {
    for (const extra of [{ catalog_product_id: "product-1" }, { source_type: "catalog_product" }]) {
      const table = makeMealTable(storedRow(extra));
      expect(await markEnqueueFailedDishesInMeal({ failures, mealId: MEAL_ID, db: table.db, loadMeal: table.loadMeal })).toEqual({ status: "unchanged" });
      expect(table.updates).toEqual([]);
    }
  });

  it("失敗が無ければ読まない。献立が無い・変える料理が無いときは書かない", async () => {
    const table = makeMealTable(storedRow());
    expect(await markEnqueueFailedDishesInMeal({ failures: [], mealId: MEAL_ID, db: table.db, loadMeal: table.loadMeal })).toEqual({ status: "unchanged" });
    expect(table.loadMeal).not.toHaveBeenCalled();

    const missing = makeMealTable(null);
    expect(await markEnqueueFailedDishesInMeal({ failures, mealId: MEAL_ID, db: missing.db, loadMeal: missing.loadMeal })).toEqual({ status: "not_found" });
    expect(missing.updates).toEqual([]);

    const notArray = makeMealTable(storedRow({ dishes: "not-an-array" }));
    expect(await markEnqueueFailedDishesInMeal({ failures, mealId: MEAL_ID, db: notArray.db, loadMeal: notArray.loadMeal })).toEqual({ status: "unchanged" });
    expect(notArray.updates).toEqual([]);
  });

  it("読めない・書けない・例外のときも例外を投げず、error と文を返す", async () => {
    const table = makeMealTable(storedRow());
    expect(
      await markEnqueueFailedDishesInMeal({ failures, mealId: MEAL_ID, db: table.db, loadMeal: async () => ({ data: null, error: { message: "read failed" } }) }),
    ).toEqual({ status: "error", message: "read failed" });

    const failing = makeMealTable(storedRow(), { writeError: { message: "write failed" } });
    expect(await markEnqueueFailedDishesInMeal({ failures, mealId: MEAL_ID, db: failing.db, loadMeal: failing.loadMeal })).toEqual({
      status: "error",
      message: "failed to update meal: write failed",
    });
    expect(
      await markEnqueueFailedDishesInMeal({
        failures,
        mealId: MEAL_ID,
        db: table.db,
        loadMeal: async () => {
          throw new Error("boom");
        },
      }),
    ).toEqual({ status: "error", message: "boom" });
  });
});
