/**
 * #1527: 画像の処理 (process-meal-image-jobs) が献立の料理を書くときの競合。
 *
 * 以前は、カバーの条件つきの更新が 0 行 (読んでから書くまでに行が変わった) のとき、読んだときの古い料理を条件なしで書いていた。
 * そのため、同じ献立の別の料理を書いた別のワーカーの画像や、利用者が付けた料理の画像を巻き戻していた。
 * いまは、読んだときの updated_at の行にだけ書き (楽観的な排他)、0 行なら読み直して、最新の料理にジョブの料理の画像だけを当て直す。
 *
 * ここでは planned_meals の 1 行を持つ作り物で、書き込みの条件 (eq / is) を本当に評価する。
 * 更新が当たると updated_at を進める (本物の trg_planned_meals_updated_at と同じく、どの書き手が書いても変わる)。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db-logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { DEFAULT_MEAL_IMAGE_MODEL, buildDishImagePrompt, buildDishImageSubjectHash, type MealImageDish } from '../supabase/functions/_shared/meal-image';
import { buildDishImagePayload } from '../lib/meal-image-jobs';
import {
  MEAL_DISH_WRITE_MAX_ATTEMPTS,
  writeDishImageFailure,
  writeGeneratedDishImage,
  type PlannedMealSnapshot,
  type PlannedMealWriter,
} from '../supabase/functions/process-meal-image-jobs/utils';

const MEAL_ID = 'meal-1';
const USER_COVER = 'https://example.com/storage/generated/user-1/user-made.png';
const AI_0 = 'https://example.com/storage/fridge-images/generated/meal-1/job-0.png';
const AI_1 = 'https://example.com/storage/fridge-images/generated/meal-1/job-1.png';
const READ_AT = '2026-10-14T00:00:00.000000+00:00';
const TWO_DISHES: MealImageDish[] = [
  { name: '鮭の塩焼き', role: 'main', ingredients: ['鮭'] },
  { name: '味噌汁', role: 'soup', ingredients: ['豆腐', 'わかめ'] },
];

/** 画像を待つ AI の料理 (generated_ai・pending・subject_hash つき) を手で作る。billing/03 Q-16 の後 reconcileDishImages は主菜の 1 品にしか積まないが、同じ献立の 2 つの料理のジョブ (段 B の前に積んだジョブ・主菜を入れ替えた前後のジョブ) は残りうるので、#1527 の競合は 2 品で確かめる */
async function pendingAiDishes(nextDishes: MealImageDish[]): Promise<MealImageDish[]> {
  return Promise.all(nextDishes.map(async (dish, index) => ({ ...dish, image_url: null, image_source: 'generated_ai' as const, image_status: 'pending' as const, image_subject_hash: await buildDishImageSubjectHash(dish, index), image_prompt: buildDishImagePrompt(dish), image_model: DEFAULT_MEAL_IMAGE_MODEL })));
}

interface UpdateRecord {
  values: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
  matched: boolean;
}

/** planned_meals の 1 行の作り物。update の条件を評価し、当たれば値を書いて updated_at を進める */
function makeMealTable(initial: PlannedMealSnapshot) {
  let row: PlannedMealSnapshot | null = structuredClone(initial);
  let tick = 0;
  const updates: UpdateRecord[] = [];

  function bumpUpdatedAt(): string {
    tick += 1;
    return `2026-10-14T00:00:0${tick}.000000+00:00`;
  }

  const db: PlannedMealWriter = {
    from: () => ({
      update: (values) => {
        const record: UpdateRecord = { values, filters: [], matched: false };
        const filter = {
          eq: (column: string, value: string) => {
            record.filters.push(['eq', column, value]);
            return filter;
          },
          is: (column: string, value: null) => {
            record.filters.push(['is', column, value]);
            return filter;
          },
          select: async () => {
            const current = row as Record<string, unknown> | null;
            record.matched = current !== null && record.filters.every(([, column, value]) => current[column] === value);
            updates.push(record);
            if (record.matched && row) {
              row = { ...row, ...structuredClone(values), updated_at: bumpUpdatedAt() } as PlannedMealSnapshot;
            }
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
    get row(): PlannedMealSnapshot | null {
      return row;
    },
    /** 画像の処理の読み方 (readMealSnapshot と同じ形。書き込みの値を共有しないように写しを返す) */
    read: async (): Promise<PlannedMealSnapshot | null> => (row ? structuredClone(row) : null),
    /** 利用者の保存など、ほかの書き手が条件なしで書く (updated_at が進む) */
    writeDirectly(values: Partial<PlannedMealSnapshot>): void {
      if (!row) throw new Error('row deleted');
      row = { ...row, ...structuredClone(values), updated_at: bumpUpdatedAt() };
    },
    deleteRow(): void {
      row = null;
    },
  };
}

/** 最初に読んだ直後だけ interleave を走らせる読み方 (読んでから書くまでのあいだに、ほかの書き手が書いた状況を作る) */
function readThenInterleave(
  read: () => Promise<PlannedMealSnapshot | null>,
  interleave: () => Promise<void>,
): { read: () => Promise<PlannedMealSnapshot | null>; reads: () => number } {
  let count = 0;
  return {
    read: async () => {
      const snapshot = await read();
      count += 1;
      if (count === 1) await interleave();
      return snapshot;
    },
    reads: () => count,
  };
}

describe('process-meal-image-jobs: 料理の書き込みの競合 (#1527)', () => {
  it.each([
    { label: 'カバーが利用者の画像 (料理だけを書く経路)', cover: USER_COVER, expectedCover: USER_COVER },
    { label: 'カバーが空 (カバーも書く経路)', cover: null, expectedCover: AI_0 },
  ])('2 つのワーカーが同じ献立の別の料理を書いても、両方の画像が残る: $label', async ({ cover, expectedCover }) => {
    const dishes = await pendingAiDishes(TWO_DISHES);
    const table = makeMealTable({ id: MEAL_ID, dishes, image_url: cover, updated_at: READ_AT });

    const workerA = readThenInterleave(table.read, async () => {
      // ワーカー A が読んだあと、書く前に、ワーカー B が料理 1 の画像を書き終える
      const outcomeB = await writeGeneratedDishImage(table.db, {
        mealId: MEAL_ID,
        dishIndex: 1,
        subjectHash: dishes[1].image_subject_hash ?? null,
        imageUrl: AI_1,
        read: table.read,
      });
      expect(outcomeB).toEqual({ status: 'written' });
    });
    const outcomeA = await writeGeneratedDishImage(table.db, {
      mealId: MEAL_ID,
      dishIndex: 0,
      subjectHash: dishes[0].image_subject_hash ?? null,
      imageUrl: AI_0,
      read: workerA.read,
    });

    expect(outcomeA).toEqual({ status: 'written' });
    const finalDishes = table.row?.dishes as MealImageDish[];
    expect(finalDishes[0]).toMatchObject({ image_url: AI_0, image_status: 'ready', image_source: 'generated_ai' });
    expect(finalDishes[1]).toMatchObject({ image_url: AI_1, image_status: 'ready', image_source: 'generated_ai' });
    expect(table.row?.image_url).toBe(expectedCover);
    // B が書けた → A の 1 回目は読んだときの updated_at と合わず 0 行 → A は読み直して書けた
    expect(table.updates.map((update) => update.matched)).toEqual([true, false, true]);
    expect(workerA.reads()).toBe(2);
    // どの書き込みも、読んだときの updated_at を条件にする
    for (const update of table.updates) {
      expect(update.filters.some(([op, column]) => op === 'eq' && column === 'updated_at')).toBe(true);
    }
  });

  it('カバーの条件で 0 行のときも、ほかの料理の画像を巻き戻さない (利用者が付けたカバーにも触れない)', async () => {
    const dishes = await pendingAiDishes(TWO_DISHES);
    const table = makeMealTable({ id: MEAL_ID, dishes, image_url: null, updated_at: READ_AT });

    const workerA = readThenInterleave(table.read, async () => {
      // A が読んだあと: B が料理 1 の画像を書き (カバーが AI_1 になる)、利用者がカバーに自分の画像を付ける
      await writeGeneratedDishImage(table.db, {
        mealId: MEAL_ID,
        dishIndex: 1,
        subjectHash: dishes[1].image_subject_hash ?? null,
        imageUrl: AI_1,
        read: table.read,
      });
      table.writeDirectly({ image_url: USER_COVER });
    });
    const outcomeA = await writeGeneratedDishImage(table.db, {
      mealId: MEAL_ID,
      dishIndex: 0,
      subjectHash: dishes[0].image_subject_hash ?? null,
      imageUrl: AI_0,
      read: workerA.read,
    });

    expect(outcomeA).toEqual({ status: 'written' });
    // A の 1 回目は、読んだときのカバー (空) を条件にしたが、カバーが変わっていて 0 行
    const firstA = table.updates[1];
    expect(firstA.matched).toBe(false);
    expect(firstA.filters).toContainEqual(['is', 'image_url', null]);
    // 読み直した 2 回目は、利用者のカバーを置き換えないので image_url に触れない
    const secondA = table.updates[2];
    expect(secondA.matched).toBe(true);
    expect(secondA.values).not.toHaveProperty('image_url');

    const finalDishes = table.row?.dishes as MealImageDish[];
    expect(finalDishes[0]).toMatchObject({ image_url: AI_0, image_source: 'generated_ai' });
    expect(finalDishes[1]).toMatchObject({ image_url: AI_1, image_source: 'generated_ai' });
    expect(table.row?.image_url).toBe(USER_COVER);
  });

  it('1 品の献立で、読んでから書くまでに利用者が画像を付けたら (PATCH imageUrl)、手の画像を AI の画像に戻さない', async () => {
    const dishes = await pendingAiDishes([TWO_DISHES[0]]);
    const table = makeMealTable({ id: MEAL_ID, dishes, image_url: null, updated_at: READ_AT });

    const worker = readThenInterleave(table.read, async () => {
      const payload = await buildDishImagePayload({
        previousDishes: dishes,
        nextDishes: dishes,
        triggerSource: 'test',
        existingCover: null,
        imageUrlOverride: USER_COVER,
      });
      table.writeDirectly({ dishes: payload.dishes, image_url: payload.mealCoverImageUrl });
    });
    const outcome = await writeGeneratedDishImage(table.db, {
      mealId: MEAL_ID,
      dishIndex: 0,
      subjectHash: dishes[0].image_subject_hash ?? null,
      imageUrl: AI_0,
      read: worker.read,
    });

    // 読み直すと、料理は手の画像 (subject_hash なし) になっているので、書かずにやめる (呼び出し元はジョブを取り消す)
    expect(outcome).toEqual({ status: 'skipped', reason: 'dish_changed' });
    expect(table.updates.filter((update) => update.matched)).toHaveLength(0);
    const finalDishes = table.row?.dishes as MealImageDish[];
    expect(finalDishes[0]).toMatchObject({ image_url: USER_COVER, image_source: 'manual_override' });
    expect(table.row?.image_url).toBe(USER_COVER);
  });

  it('読み直したら献立が消えていたら、書かずにやめる (meal_deleted)', async () => {
    const dishes = await pendingAiDishes(TWO_DISHES);
    const table = makeMealTable({ id: MEAL_ID, dishes, image_url: null, updated_at: READ_AT });
    const worker = readThenInterleave(table.read, async () => table.deleteRow());

    const outcome = await writeGeneratedDishImage(table.db, {
      mealId: MEAL_ID,
      dishIndex: 0,
      subjectHash: dishes[0].image_subject_hash ?? null,
      imageUrl: AI_0,
      read: worker.read,
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'meal_deleted' });
    expect(table.row).toBeNull();
  });

  it('書き直しが上限 (MEAL_DISH_WRITE_MAX_ATTEMPTS 回) に達したら throw し、料理を書かない', async () => {
    const dishes = await pendingAiDishes(TWO_DISHES);
    const table = makeMealTable({ id: MEAL_ID, dishes, image_url: USER_COVER, updated_at: READ_AT });
    let reads = 0;
    // 毎回、読んだ直後にほかの書き手が書く (読んだときの updated_at の行が、書くときには無い)
    const read = async () => {
      const snapshot = await table.read();
      reads += 1;
      table.writeDirectly({});
      return snapshot;
    };

    await expect(
      writeGeneratedDishImage(table.db, {
        mealId: MEAL_ID,
        dishIndex: 0,
        subjectHash: dishes[0].image_subject_hash ?? null,
        imageUrl: AI_0,
        read,
      }),
    ).rejects.toThrow(`failed to update meal: the meal kept changing while writing (${MEAL_DISH_WRITE_MAX_ATTEMPTS} attempts)`);

    expect(MEAL_DISH_WRITE_MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(reads).toBe(MEAL_DISH_WRITE_MAX_ATTEMPTS);
    expect(table.updates).toHaveLength(MEAL_DISH_WRITE_MAX_ATTEMPTS);
    expect(table.updates.every((update) => !update.matched)).toBe(true);
    expect((table.row?.dishes as MealImageDish[])[0].image_url ?? null).toBeNull();
  });

  it('料理を失敗にするとき (writeDishImageFailure) も、別のワーカーが書いたほかの料理の画像を巻き戻さない', async () => {
    const dishes = await pendingAiDishes(TWO_DISHES);
    const table = makeMealTable({ id: MEAL_ID, dishes, image_url: null, updated_at: READ_AT });

    const failing = readThenInterleave(table.read, async () => {
      await writeGeneratedDishImage(table.db, {
        mealId: MEAL_ID,
        dishIndex: 1,
        subjectHash: dishes[1].image_subject_hash ?? null,
        imageUrl: AI_1,
        read: table.read,
      });
    });
    const outcome = await writeDishImageFailure(table.db, {
      mealId: MEAL_ID,
      dishIndex: 0,
      subjectHash: dishes[0].image_subject_hash ?? null,
      reason: 'storage upload failed: boom',
      read: failing.read,
    });

    expect(outcome).toEqual({ status: 'written' });
    const finalDishes = table.row?.dishes as MealImageDish[];
    expect(finalDishes[0]).toMatchObject({ image_status: 'failed', image_error: 'storage upload failed: boom' });
    expect(finalDishes[1]).toMatchObject({ image_url: AI_1, image_status: 'ready', image_source: 'generated_ai' });
    expect(table.row?.image_url).toBe(AI_1);
    // 失敗の書き込みはカバーに触れない
    expect(table.updates.at(-1)?.values).not.toHaveProperty('image_url');
  });

  it('料理を失敗にするとき、料理が変わっていたら (subject_hash が違う) 書かない', async () => {
    const dishes = await pendingAiDishes(TWO_DISHES);
    const table = makeMealTable({ id: MEAL_ID, dishes, image_url: null, updated_at: READ_AT });

    const outcome = await writeDishImageFailure(table.db, {
      mealId: MEAL_ID,
      dishIndex: 0,
      subjectHash: 'another-subject',
      reason: 'boom',
      read: table.read,
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'dish_changed' });
    expect(table.updates).toHaveLength(0);
  });
});
