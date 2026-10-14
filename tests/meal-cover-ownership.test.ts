/**
 * #1487 の整合ゲート (3 回目): 献立のカバー (planned_meals.image_url) の持ち主。
 *
 * カバーを料理の画像から自動で付け替えてよいのは、いまのカバーが空か、献立の AI の料理 (image_source: generated_ai) の画像と
 * 一致するときだけ (isMealCoverAutoReplaceable)。写真・商品・利用者が作った画像・手で付けた画像のカバーは、
 * 画像の処理 (process-meal-image-jobs)・保存し直し (reconcileDishImages / buildDishImagePayload)・AI の作り直し (save-meal) のどこからも置き換えない。
 *
 * ここでは、判定の関数・カバーを決める関数 (deriveMealCoverImage)・画像の処理の書き込み (applyGeneratedDishImage → writeGeneratedDishImage)・
 * 保存し直しの組み立て (buildDishImagePayload) を本物で動かす (入口の route を通すものは meal-image-skip-routes.test.ts の J)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db-logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import {
  applyGeneratedDishImage,
  buildPhotoDishList,
  deriveMealCoverImage,
  isMealCoverAutoReplaceable,
  reconcileDishImages,
  type MealImageDish,
} from '../supabase/functions/_shared/meal-image';
import { buildDishImagePayload } from '../lib/meal-image-jobs';
import { writeGeneratedDishImage, type PlannedMealWriter } from '../supabase/functions/process-meal-image-jobs/utils';

const USER_COVER = 'https://example.com/storage/generated/user-1/user-made.png';
const PHOTO_URL = 'https://example.com/storage/meal-photos/user-1/photo.jpg';
const PRODUCT_URL = 'https://example.com/catalog/bento.jpg';
const AI_0 = 'https://example.com/storage/fridge-images/generated/meal-1/job-0.png';
const AI_1 = 'https://example.com/storage/fridge-images/generated/meal-1/job-1.png';
const AI_2 = 'https://example.com/storage/fridge-images/generated/meal-1/job-2.png';
const AI_URLS = [AI_0, AI_1, AI_2];
const GENERATED_AT = '2026-10-12T00:00:00.000Z';
const THREE_DISHES: MealImageDish[] = [
  { name: '鮭の塩焼き', role: 'main', ingredients: ['鮭'] },
  { name: 'ほうれん草のおひたし', role: 'side', ingredients: ['ほうれん草'] },
  { name: '味噌汁', role: 'soup', ingredients: ['豆腐', 'わかめ'] },
];

/** 3 品の AI の献立 (reconcileDishImages を通した、画像がまだ無い pending の料理) */
async function pendingAiMeal(): Promise<MealImageDish[]> {
  const result = await reconcileDishImages({ previousDishes: [], nextDishes: THREE_DISHES, triggerSource: 'test' });
  expect(result.jobs).toHaveLength(THREE_DISHES.length);
  return result.dishes;
}

/** 画像の処理が、ジョブの料理ごとに AI の画像を書いたあとの料理とカバー (各回でカバーの持ち主の決まりを通す) */
function runWorker(
  dishes: MealImageDish[],
  cover: string | null,
  dishIndexes: number[],
): { dishes: MealImageDish[]; cover: string | null; coverWrites: number } {
  let current = dishes;
  let currentCover = cover;
  let coverWrites = 0;
  for (const dishIndex of dishIndexes) {
    const applied = applyGeneratedDishImage({
      dishes: current,
      dishIndex,
      imageUrl: AI_URLS[dishIndex],
      generatedAt: GENERATED_AT,
      currentCoverImageUrl: currentCover,
    });
    current = applied.dishes;
    if (applied.coverChanged) coverWrites += 1;
    currentCover = applied.coverImageUrl;
  }
  return { dishes: current, cover: currentCover, coverWrites };
}

describe('isMealCoverAutoReplaceable: カバーの持ち主の判定 (ひとつの関数)', () => {
  const aiDish: MealImageDish = { name: 'a', image_url: AI_0, image_source: 'generated_ai', image_status: 'ready' };

  it('空のカバーは付け替えてよい', () => {
    expect(isMealCoverAutoReplaceable(null, [])).toBe(true);
    expect(isMealCoverAutoReplaceable('', [[aiDish]])).toBe(true);
  });

  it('AI の料理の画像と一致するカバーは付け替えてよい (保存する前の料理・保存する料理のどちらでも)', () => {
    expect(isMealCoverAutoReplaceable(AI_0, [[aiDish]])).toBe(true);
    expect(isMealCoverAutoReplaceable(AI_0, [[], [aiDish]])).toBe(true);
    // 更新待ち (stale) で画像が残っている AI の料理も、AI の料理の画像
    expect(isMealCoverAutoReplaceable(AI_0, [[{ ...aiDish, image_status: 'stale' }]])).toBe(true);
  });

  it('写真・商品・手で付けた画像・source の無い画像の料理と一致しても、AI のものではない', () => {
    for (const image_source of ['meal_photo', 'catalog', 'manual_override', 'none', null] as const) {
      expect(isMealCoverAutoReplaceable(AI_0, [[{ ...aiDish, image_source }]])).toBe(false);
    }
  });

  it('どの料理の画像とも一致しない空でないカバー (利用者が作った画像・写真の複数の料理のカバー) は付け替えない', () => {
    expect(isMealCoverAutoReplaceable(USER_COVER, [[aiDish]])).toBe(false);
    expect(isMealCoverAutoReplaceable(PHOTO_URL, [buildPhotoDishList(THREE_DISHES, PHOTO_URL)])).toBe(false);
    expect(isMealCoverAutoReplaceable(USER_COVER, [null, undefined])).toBe(false);
  });
});

describe('deriveMealCoverImage: カバーの持ち主の決まりでカバーを決める', () => {
  const readyAi = (url: string): MealImageDish => ({ name: 'x', image_url: url, image_source: 'generated_ai', image_status: 'ready' });

  it('利用者・写真・商品のカバーは、AI の料理の画像ができても置き換えない', () => {
    for (const cover of [USER_COVER, PHOTO_URL, PRODUCT_URL]) {
      expect(deriveMealCoverImage({ dishes: [readyAi(AI_0), readyAi(AI_1)], currentCoverImageUrl: cover })).toBe(cover);
    }
  });

  it('空のカバーは、先頭のできあがった料理の画像を選ぶ (料理の画像が無ければ空のまま)', () => {
    expect(deriveMealCoverImage({ dishes: [{ name: 'p' }, readyAi(AI_1)], currentCoverImageUrl: null })).toBe(AI_1);
    expect(deriveMealCoverImage({ dishes: [{ name: 'p' }], currentCoverImageUrl: null })).toBeNull();
  });

  it('AI の料理の画像だったカバーは、料理の画像から選び直す', () => {
    expect(deriveMealCoverImage({ dishes: [readyAi(AI_0), readyAi(AI_1)], currentCoverImageUrl: AI_1 })).toBe(AI_0);
  });

  it('前回の AI の料理の画像だったカバーは、その料理が変わって画像が無くなったら空にする (前の料理の画像を残さない)', () => {
    const previous = [readyAi(AI_0)];
    const next: MealImageDish[] = [{ name: 'y', image_url: null, image_source: 'generated_ai', image_status: 'stale' }];
    expect(deriveMealCoverImage({ dishes: next, currentCoverImageUrl: AI_0, previousDishes: previous })).toBeNull();
  });

  it('AI の料理の画像のカバーは、その料理が画像を持ち続ける間は残す (できあがっていない stale でも)', () => {
    const next: MealImageDish[] = [{ name: 'y', image_url: AI_0, image_source: 'generated_ai', image_status: 'stale' }];
    expect(deriveMealCoverImage({ dishes: next, currentCoverImageUrl: AI_0 })).toBe(AI_0);
  });
});

describe('#1487 の整合ゲート: 3 品の AI の献立に利用者がカバーを付けたあと', () => {
  it('ワーカーが料理の画像を書いても、完了を切り替えても、カバーは利用者の画像のまま', async () => {
    const dishes = await pendingAiMeal();

    // 利用者がカバーを付ける (PATCH {imageUrl}): 料理が 2 品以上なので、カバーにだけ付く。ジョブは今の決まりのまま積む
    const patched = await buildDishImagePayload({
      previousDishes: dishes,
      triggerSource: 'test:PATCH',
      imageUrlOverride: USER_COVER,
      existingCover: null,
      fallbackMealImageUrl: null,
    });
    expect(patched.mealCoverImageUrl).toBe(USER_COVER);
    expect(patched.jobs.map((job) => job.dishIndex)).toEqual([0, 1, 2]);
    // 料理は AI の料理のまま (利用者の画像は料理に付かない)
    expect(patched.dishes.every((dish) => dish.image_source === 'generated_ai' && !dish.image_url)).toBe(true);

    // ワーカーが 3 品の画像を書く: カバーは一度も書かれない
    const worked = runWorker(patched.dishes, patched.mealCoverImageUrl, [0, 1, 2]);
    expect(worked.cover).toBe(USER_COVER);
    expect(worked.coverWrites).toBe(0);
    expect(worked.dishes.map((dish) => dish.image_url)).toEqual(AI_URLS);

    // 完了の切り替え (料理を変えない保存し直し): カバーは利用者の画像のまま、ジョブも積まない
    const toggled = await buildDishImagePayload({
      previousDishes: worked.dishes,
      triggerSource: 'test:PATCH',
      existingCover: worked.cover,
      fallbackMealImageUrl: worked.cover,
    });
    expect(toggled.mealCoverImageUrl).toBe(USER_COVER);
    expect(toggled.jobs).toEqual([]);
  });

  it('料理の画像ができあがったあとに利用者がカバーを付けても、保存し直しで AI の料理の画像に戻らない', async () => {
    const dishes = await pendingAiMeal();
    const ready = runWorker(dishes, null, [0, 1, 2]);
    // 空のカバーは AI の料理の画像で付け替わる (今までどおり)
    expect(ready.cover).toBe(AI_0);

    const patched = await buildDishImagePayload({
      previousDishes: ready.dishes,
      triggerSource: 'test:PATCH',
      imageUrlOverride: USER_COVER,
      existingCover: ready.cover,
      fallbackMealImageUrl: ready.cover,
    });
    expect(patched.mealCoverImageUrl).toBe(USER_COVER);
    expect(patched.jobs).toEqual([]);

    const resaved = await buildDishImagePayload({
      previousDishes: patched.dishes,
      triggerSource: 'test:PATCH',
      existingCover: USER_COVER,
      fallbackMealImageUrl: USER_COVER,
    });
    expect(resaved.mealCoverImageUrl).toBe(USER_COVER);
  });

  it('料理が 1 品のときは、今までどおり料理を手で付けた画像 (manual_override) にし、ジョブを積まない', async () => {
    const single = await reconcileDishImages({ previousDishes: [], nextDishes: [THREE_DISHES[0]], triggerSource: 'test' });
    const patched = await buildDishImagePayload({
      previousDishes: single.dishes,
      triggerSource: 'test:PATCH',
      imageUrlOverride: USER_COVER,
      existingCover: null,
    });
    expect(patched.mealCoverImageUrl).toBe(USER_COVER);
    expect(patched.jobs).toEqual([]);
    expect(patched.dishes[0]).toMatchObject({ image_url: USER_COVER, image_source: 'manual_override', image_status: 'ready' });
    // 料理を足しても、カバーは利用者の画像のまま (手で付けた画像の料理は AI の料理ではない)
    const added = await buildDishImagePayload({
      previousDishes: patched.dishes,
      nextDishes: [...patched.dishes, THREE_DISHES[1]],
      triggerSource: 'test:PATCH',
      existingCover: USER_COVER,
    });
    const worked = runWorker(added.dishes, added.mealCoverImageUrl, added.jobs.map((job) => job.dishIndex));
    expect(worked.cover).toBe(USER_COVER);
  });
});

describe('#1487 の整合ゲート: 写真・商品のカバーの献立に、画像の処理が料理の画像を書いても置き換えない', () => {
  it('写真の複数の料理の献立 (カバーは写真) に足した AI の料理の画像ができても、カバーは写真のまま', () => {
    const dishes: MealImageDish[] = [
      ...buildPhotoDishList(THREE_DISHES.slice(0, 2), PHOTO_URL),
      { name: '足した料理', image_source: 'generated_ai', image_status: 'pending', image_subject_hash: 'h' },
    ];
    const worked = runWorker(dishes, PHOTO_URL, [2]);
    expect(worked.cover).toBe(PHOTO_URL);
    expect(worked.coverWrites).toBe(0);
  });

  it('商品の献立 (カバーは商品の画像) でも、AI の料理の画像ができてもカバーは商品の画像のまま', () => {
    const dishes: MealImageDish[] = [
      { name: '幕の内弁当', image_url: PRODUCT_URL, image_source: 'catalog', image_status: 'ready' },
      { name: '足した料理', image_source: 'generated_ai', image_status: 'pending', image_subject_hash: 'h' },
    ];
    const worked = runWorker(dishes, PRODUCT_URL, [1]);
    expect(worked.cover).toBe(PRODUCT_URL);
    // カバーが空の古い商品の献立では、先頭の商品の画像を選ぶ (AI の画像ではない)
    expect(runWorker(dishes, null, [1]).cover).toBe(PRODUCT_URL);
  });

  it('カバーが空か AI の料理の画像のときは、今までどおり付け替わる', async () => {
    const dishes = await pendingAiMeal();
    // 空: 最初にできた料理の画像
    const first = runWorker(dishes, null, [1]);
    expect(first.cover).toBe(AI_1);
    expect(first.coverWrites).toBe(1);
    // AI の料理の画像: 先頭の料理の画像ができたら先頭に付け替わる
    const second = runWorker(first.dishes, first.cover, [0]);
    expect(second.cover).toBe(AI_0);
  });
});

describe('#1487 の整合ゲート: 新しく作る入口 (POST) で送られた写真・商品・手の画像の料理を AI の画像の料理にしない', () => {
  it('写真の料理 (1 品・画像あり) は、画像と source を保持し、ジョブを積まない', async () => {
    const photo = buildPhotoDishList([THREE_DISHES[0]], PHOTO_URL);
    const payload = await buildDishImagePayload({
      previousDishes: null,
      nextDishes: photo,
      triggerSource: 'test:POST',
      existingCover: null,
      fallbackMealImageUrl: PHOTO_URL,
      preserveSubmittedDishImages: true,
    });
    expect(payload.jobs).toEqual([]);
    expect(payload.dishes[0]).toMatchObject({ image_url: PHOTO_URL, image_source: 'meal_photo', image_status: 'ready', image_subject_hash: null });
    expect(payload.mealCoverImageUrl).toBe(PHOTO_URL);
  });

  it('写真の複数の料理 (料理ごとの画像なし・カバーは写真) も保持し、ジョブを積まない', async () => {
    const photo = buildPhotoDishList(THREE_DISHES, PHOTO_URL);
    const payload = await buildDishImagePayload({
      previousDishes: null,
      nextDishes: photo,
      triggerSource: 'test:POST',
      existingCover: null,
      fallbackMealImageUrl: PHOTO_URL,
      preserveSubmittedDishImages: true,
    });
    expect(payload.jobs).toEqual([]);
    expect(payload.dishes.every((dish) => dish.image_source === 'meal_photo' && dish.image_status === 'stale')).toBe(true);
    expect(payload.mealCoverImageUrl).toBe(PHOTO_URL);
  });

  it('商品・手で付けた画像の料理も保持する。source の無い料理と generated_ai の料理は今までどおりジョブを積む', async () => {
    const payload = await buildDishImagePayload({
      previousDishes: null,
      nextDishes: [
        { name: '幕の内弁当', image_url: PRODUCT_URL, image_source: 'catalog' },
        { name: '手の画像', image_url: USER_COVER, image_source: 'manual_override', image_status: 'ready' },
        { name: 'ふつうの料理' },
        { name: 'AI の料理', image_url: AI_0, image_source: 'generated_ai', image_status: 'ready' },
      ],
      triggerSource: 'test:POST',
      existingCover: null,
      preserveSubmittedDishImages: true,
    });
    expect(payload.dishes[0]).toMatchObject({ image_url: PRODUCT_URL, image_source: 'catalog' });
    expect(payload.dishes[1]).toMatchObject({ image_url: USER_COVER, image_source: 'manual_override', image_status: 'ready' });
    expect(payload.jobs.map((job) => job.dishIndex)).toEqual([2, 3]);
  });

  it('更新の入口 (preserveSubmittedDishImages なし) では、送られた source を見ない (前回の料理で決める)', async () => {
    const payload = await buildDishImagePayload({
      previousDishes: null,
      nextDishes: [{ name: '写真の料理', image_url: PHOTO_URL, image_source: 'meal_photo', image_status: 'ready' }],
      triggerSource: 'test',
      existingCover: null,
    });
    expect(payload.jobs).toHaveLength(1);
  });
});

describe('process-meal-image-jobs の書き込み: カバーの二重の守り (writeGeneratedDishImage)', () => {
  interface Call {
    values: Record<string, unknown>;
    filters: Array<[string, string, unknown]>;
    selected: boolean;
  }

  /** planned_meals の update の作り物。guardedRows はカバーを条件にした update が当たる行数 */
  function makeDb(guardedRows: number): { db: PlannedMealWriter; calls: Call[] } {
    const calls: Call[] = [];
    const db: PlannedMealWriter = {
      from: () => ({
        update: (values) => {
          const call: Call = { values, filters: [], selected: false };
          calls.push(call);
          const filter = {
            eq: (column: string, value: string) => {
              call.filters.push(['eq', column, value]);
              return filter;
            },
            is: (column: string, value: null) => {
              call.filters.push(['is', column, value]);
              return filter;
            },
            select: () => {
              call.selected = true;
              return Promise.resolve({ data: Array.from({ length: guardedRows }, () => ({ id: 'meal-1' })), error: null });
            },
            then: <T>(resolve: (value: { error: null }) => T) => Promise.resolve({ error: null }).then(resolve),
          };
          return filter;
        },
      }),
    };
    return { db, calls };
  }

  it('カバーを変えないときは、料理だけを書き、image_url に触れない', async () => {
    const { db, calls } = makeDb(1);
    await writeGeneratedDishImage(db, { mealId: 'meal-1', dishes: [], currentCover: USER_COVER, nextCover: undefined });
    expect(calls).toHaveLength(1);
    expect(calls[0].values).not.toHaveProperty('image_url');
    expect(calls[0].filters).toEqual([['eq', 'id', 'meal-1']]);
  });

  it('カバーを変えるときは、読んだときのカバーのままの行にだけ書く', async () => {
    const { db, calls } = makeDb(1);
    await writeGeneratedDishImage(db, { mealId: 'meal-1', dishes: [], currentCover: AI_1, nextCover: AI_0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toMatchObject({ image_url: AI_0 });
    expect(calls[0].filters).toEqual([['eq', 'id', 'meal-1'], ['eq', 'image_url', AI_1]]);

    const empty = makeDb(1);
    await writeGeneratedDishImage(empty.db, { mealId: 'meal-1', dishes: [], currentCover: null, nextCover: AI_0 });
    expect(empty.calls[0].filters).toEqual([['eq', 'id', 'meal-1'], ['is', 'image_url', null]]);
  });

  it('読んでから書くまでにカバーが付け替えられていたら (0 行)、カバーに触れずに料理だけを書く', async () => {
    const { db, calls } = makeDb(0);
    await writeGeneratedDishImage(db, { mealId: 'meal-1', dishes: [{ name: 'x' }], currentCover: null, nextCover: AI_0 });
    expect(calls).toHaveLength(2);
    expect(calls[1].values).not.toHaveProperty('image_url');
    expect(calls[1].values).toMatchObject({ dishes: [{ name: 'x' }] });
  });

  it('画像の処理 (index.ts) は、カバーを applyGeneratedDishImage で決め、writeGeneratedDishImage で書く (直に image_url を書かない)', () => {
    const source = readFileSync(join(process.cwd(), 'supabase/functions/process-meal-image-jobs/index.ts'), 'utf8');
    expect(source).toContain('applyGeneratedDishImage(');
    expect(source).toContain('writeGeneratedDishImage(supabase');
    expect(source).not.toContain('deriveMealCoverImage(');
    expect(source).not.toMatch(/image_url:\s*cover/);
  });
});
