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
  buildDishImageSubjectHash,
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

/** 3 品の AI の献立 (reconcileDishImages を通した。画像を待つのは主菜の鮭の塩焼きだけで、副菜と汁物は画像の無い状態。billing/03 Q-16) */
async function pendingAiMeal(): Promise<MealImageDish[]> {
  const result = await reconcileDishImages({ previousDishes: [], nextDishes: THREE_DISHES, triggerSource: 'test' });
  expect(result.jobs.map((job) => job.dishIndex)).toEqual([0]);
  return result.dishes;
}

/** 3 品とも画像を待つ AI の献立 (段 B の前に積んだ献立の形。billing/03 Q-16 の後は主菜だけを積むが、段 B の前の待ちのジョブは主菜でない料理にも画像を書く。§7.3) */
async function legacyPendingAiMeal(): Promise<MealImageDish[]> {
  return Promise.all(THREE_DISHES.map(async (dish, index) => ({ ...dish, image_url: null, image_source: 'generated_ai' as const, image_status: 'pending' as const, image_subject_hash: await buildDishImageSubjectHash(dish, index) })));
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
    expect(patched.jobs.map((job) => job.dishIndex)).toEqual([0]);
    // 料理は AI の料理のまま (利用者の画像は料理に付かない)
    expect(patched.dishes[0]).toMatchObject({ image_source: 'generated_ai', image_url: null });
    expect(patched.dishes.slice(1).every((dish) => dish.image_source === null && !dish.image_url)).toBe(true);

    // ワーカーが 3 品の画像を書く: カバーは一度も書かれない
    const worked = runWorker(patched.dishes, patched.mealCoverImageUrl, [0]);
    expect(worked.cover).toBe(USER_COVER);
    expect(worked.coverWrites).toBe(0);
    expect(worked.dishes.map((dish) => dish.image_url)).toEqual([AI_0, null, null]);

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
    const ready = runWorker(dishes, null, [0]);
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
    const dishes = await legacyPendingAiMeal();
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

  it('商品・手で付けた画像の料理も保持する。source の無い料理と generated_ai の料理は今までどおり AI の画像の料理として扱い、主菜 (ふつうの料理) にだけ積む (billing/03 Q-16)', async () => {
    const payload = await buildDishImagePayload({
      previousDishes: null,
      nextDishes: [
        { name: '幕の内弁当', image_url: PRODUCT_URL, image_source: 'catalog' },
        { name: '手の画像', image_url: USER_COVER, image_source: 'manual_override', image_status: 'ready' },
        { name: 'ふつうの料理', role: 'main' },
        { name: 'AI の料理', image_url: AI_0, image_source: 'generated_ai', image_status: 'ready' },
      ],
      triggerSource: 'test:POST',
      existingCover: null,
      preserveSubmittedDishImages: true,
    });
    expect(payload.dishes[0]).toMatchObject({ image_url: PRODUCT_URL, image_source: 'catalog' });
    expect(payload.dishes[1]).toMatchObject({ image_url: USER_COVER, image_source: 'manual_override', image_status: 'ready' });
    expect(payload.jobs.map((job) => job.dishIndex)).toEqual([2]);
    expect(payload.dishes[3]).toMatchObject({ image_url: null, image_source: null, image_status: null, image_subject_hash: null });
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

describe('#1553 料理が 2 品以上の献立で、PATCH の image_url: null (clearCover) が利用者のカバーを外す', () => {
  it('料理の画像ができあがった献立: 利用者のカバーを外し、先頭の AI の料理の画像に戻す (ジョブは積まない)', async () => {
    const ready = runWorker(await pendingAiMeal(), USER_COVER, [0]);
    expect(ready.cover).toBe(USER_COVER);

    const cleared = await buildDishImagePayload({
      previousDishes: ready.dishes,
      triggerSource: 'test:PATCH',
      clearCover: true,
      existingCover: USER_COVER,
      fallbackMealImageUrl: USER_COVER,
    });
    expect(cleared.mealCoverImageUrl).toBe(AI_0);
    expect(cleared.jobs).toEqual([]);
    expect(cleared.dishes.map((dish) => dish.image_url)).toEqual([AI_0, null, null]);
  });

  it('料理の画像がまだ無い献立: カバーを空にし、できた AI の料理の画像が付く', async () => {
    const cleared = await buildDishImagePayload({
      previousDishes: await pendingAiMeal(),
      triggerSource: 'test:PATCH',
      clearCover: true,
      existingCover: USER_COVER,
      fallbackMealImageUrl: USER_COVER,
    });
    expect(cleared.mealCoverImageUrl).toBeNull();
    expect(cleared.jobs.map((job) => job.dishIndex)).toEqual([0]);

    const worked = runWorker(cleared.dishes, cleared.mealCoverImageUrl, [0]);
    expect(worked.cover).toBe(AI_0);
    expect(worked.coverWrites).toBe(1);
  });

  it('写真の複数の料理の献立 (カバーは写真): カバーを空にする (料理の写真の状態は変えない)', async () => {
    const photoDishes = buildPhotoDishList([{ name: '親子丼', role: 'main' }, { name: '味噌汁', role: 'soup' }], PHOTO_URL);
    const cleared = await buildDishImagePayload({
      previousDishes: photoDishes,
      triggerSource: 'test:PATCH',
      clearCover: true,
      existingCover: PHOTO_URL,
      fallbackMealImageUrl: PHOTO_URL,
    });
    expect(cleared.mealCoverImageUrl).toBeNull();
    expect(cleared.jobs).toEqual([]);
    expect(cleared.dishes.map((dish) => [dish.image_source, dish.image_status, dish.image_url])).toEqual([
      ['meal_photo', 'stale', null],
      ['meal_photo', 'stale', null],
    ]);
  });

  it('料理を送る保存と一緒でも外す (送った料理で 2 品以上か決める)', async () => {
    const single = await reconcileDishImages({ previousDishes: [], nextDishes: [THREE_DISHES[0]], triggerSource: 'test' });
    const cleared = await buildDishImagePayload({
      previousDishes: single.dishes,
      nextDishes: [...single.dishes, THREE_DISHES[1]],
      triggerSource: 'test:PATCH',
      clearCover: true,
      existingCover: USER_COVER,
      fallbackMealImageUrl: USER_COVER,
    });
    expect(cleared.mealCoverImageUrl).toBeNull();
  });

  it('料理が 1 品の献立では、今までどおり何も変えない (手で付けた画像の料理とカバーのまま)', async () => {
    const single = await reconcileDishImages({ previousDishes: [], nextDishes: [THREE_DISHES[0]], triggerSource: 'test' });
    const patched = await buildDishImagePayload({
      previousDishes: single.dishes,
      triggerSource: 'test:PATCH',
      imageUrlOverride: USER_COVER,
      existingCover: null,
    });
    const withClear = await buildDishImagePayload({
      previousDishes: patched.dishes,
      triggerSource: 'test:PATCH',
      clearCover: true,
      existingCover: USER_COVER,
      fallbackMealImageUrl: USER_COVER,
    });
    const withoutClear = await buildDishImagePayload({
      previousDishes: patched.dishes,
      triggerSource: 'test:PATCH',
      existingCover: USER_COVER,
      fallbackMealImageUrl: USER_COVER,
    });
    expect(withClear).toEqual(withoutClear);
    expect(withClear.mealCoverImageUrl).toBe(USER_COVER);
    expect(withClear.dishes[0]).toMatchObject({ image_url: USER_COVER, image_source: 'manual_override', image_status: 'ready' });
    expect(withClear.jobs).toEqual([]);
  });

  it('料理が 1 品の AI の献立 (料理の画像ができあがり、カバーは別の利用者の画像): 今までどおりカバーを残す (AI の料理の画像に戻さない)', async () => {
    // 2 品で利用者がカバーを付けたあと 1 品に減らした献立など。1 品の献立の null はカバーを外さない (MULTI_DISH_MEAL_MIN_DISHES の下限)
    const single = await reconcileDishImages({ previousDishes: [], nextDishes: [THREE_DISHES[0]], triggerSource: 'test' });
    const ready = runWorker(single.dishes, USER_COVER, [0]);
    expect(ready.cover).toBe(USER_COVER);
    expect(ready.dishes[0]).toMatchObject({ image_url: AI_0, image_source: 'generated_ai', image_status: 'ready' });

    const withClear = await buildDishImagePayload({
      previousDishes: ready.dishes,
      triggerSource: 'test:PATCH',
      clearCover: true,
      existingCover: USER_COVER,
      fallbackMealImageUrl: USER_COVER,
    });
    const withoutClear = await buildDishImagePayload({
      previousDishes: ready.dishes,
      triggerSource: 'test:PATCH',
      existingCover: USER_COVER,
      fallbackMealImageUrl: USER_COVER,
    });
    expect(withClear.mealCoverImageUrl).toBe(USER_COVER);
    expect(withClear).toEqual(withoutClear);
    expect(withClear.dishes[0]).toMatchObject({ image_url: AI_0, image_source: 'generated_ai', image_status: 'ready' });
    expect(withClear.jobs).toEqual([]);
  });

  it('clearCover が無ければ、今までどおり利用者のカバーを残す', async () => {
    const ready = runWorker(await pendingAiMeal(), USER_COVER, [0]);
    const resaved = await buildDishImagePayload({
      previousDishes: ready.dishes,
      triggerSource: 'test:PATCH',
      existingCover: USER_COVER,
      fallbackMealImageUrl: USER_COVER,
    });
    expect(resaved.mealCoverImageUrl).toBe(USER_COVER);
  });
});

describe('#1553 AI の作り直し (reconcileDishImages の regeneration) で料理が変わったら、利用者の画像を外す', () => {
  const REGENERATED: MealImageDish[] = [
    { name: '豚の生姜焼き', role: 'main', ingredients: ['豚肉'] },
    { name: 'きんぴら', role: 'side', ingredients: ['ごぼう'] },
  ];

  it('利用者のカバーの AI の献立を、違う料理に作り直す: カバーを空にし、できた AI の画像が付く', async () => {
    const ready = runWorker(await pendingAiMeal(), USER_COVER, [0]);
    const regenerated = await reconcileDishImages({
      previousDishes: ready.dishes,
      nextDishes: REGENERATED,
      triggerSource: 'test:save-meal',
      fallbackMealImageUrl: USER_COVER,
      regeneration: true,
    });
    expect(regenerated.mealCoverImageUrl).toBeNull();
    expect(regenerated.jobs.map((job) => job.dishIndex)).toEqual([0]);
    expect(runWorker(regenerated.dishes, regenerated.mealCoverImageUrl, [0]).cover).toBe(AI_0);
  });

  it('写真の料理 (1 品) を違う料理に作り直す: 写真を料理に写さず、AI の画像のジョブを積み、カバーを空にする', async () => {
    const regenerated = await reconcileDishImages({
      previousDishes: buildPhotoDishList([{ name: '親子丼', role: 'main' }], PHOTO_URL),
      nextDishes: [REGENERATED[0]],
      triggerSource: 'test:save-meal',
      fallbackMealImageUrl: PHOTO_URL,
      regeneration: true,
    });
    expect(regenerated.dishes[0]).toMatchObject({ image_url: null, image_source: 'generated_ai', image_status: 'stale' });
    expect(regenerated.dishes[0].image_subject_hash).toBeTruthy();
    expect(regenerated.jobs.map((job) => job.dishIndex)).toEqual([0]);
    expect(regenerated.mealCoverImageUrl).toBeNull();
  });

  it('料理が同じまま (同じ数・同じ中身) なら外さない (写真もカバーも残し、積まない)', async () => {
    const photo = buildPhotoDishList([{ name: '親子丼', role: 'main' }], PHOTO_URL);
    const regenerated = await reconcileDishImages({
      previousDishes: photo,
      nextDishes: [{ name: '親子丼', role: 'main', ingredients: [], displayOrder: 0 }],
      triggerSource: 'test:save-meal',
      fallbackMealImageUrl: PHOTO_URL,
      regeneration: true,
    });
    expect(regenerated.dishes[0]).toMatchObject({ image_url: PHOTO_URL, image_source: 'meal_photo', image_status: 'ready' });
    expect(regenerated.jobs).toEqual([]);
    expect(regenerated.mealCoverImageUrl).toBe(PHOTO_URL);
  });

  const OYAKODON = { name: '親子丼', role: 'main', ingredients: [], displayOrder: 0 };
  const MISOSHIRU = { name: '味噌汁', role: 'soup', ingredients: [], displayOrder: 1 };
  const photoMeal = () => buildPhotoDishList([{ name: '親子丼', role: 'main' }, { name: '味噌汁', role: 'soup' }], PHOTO_URL);

  /** 写真のカバーに頼っていた料理を、AI の画像の料理 (generated_ai・'pending'・subject_hash 付き) にしたか */
  async function expectReleasedToAi(dish: MealImageDish, source: MealImageDish, index: number): Promise<void> {
    expect(dish).toMatchObject({ image_url: null, image_source: 'generated_ai', image_status: 'pending', image_error: null, image_generated_at: null });
    expect(dish.image_subject_hash).toBe(await buildDishImageSubjectHash(source, index));
  }

  it('料理の数だけが変わっても (残った料理は同じ) 料理が変わったとみなし、カバーを外して、残った写真の料理も AI の画像にする', async () => {
    const regenerated = await reconcileDishImages({
      previousDishes: photoMeal(),
      nextDishes: [OYAKODON],
      triggerSource: 'test:save-meal',
      fallbackMealImageUrl: PHOTO_URL,
      regeneration: true,
    });
    await expectReleasedToAi(regenerated.dishes[0], OYAKODON, 0);
    expect(regenerated.jobs).toEqual([
      expect.objectContaining({ dishIndex: 0, dishName: '親子丼', subjectHash: await buildDishImageSubjectHash(OYAKODON, 0), triggerSource: 'test:save-meal' }),
    ]);
    expect(regenerated.jobs[0].prompt).toBe(regenerated.dishes[0].image_prompt);
    expect(regenerated.mealCoverImageUrl).toBeNull();
    // カバーが空・ジョブが 0 の行き止まりにならない: 画像の処理ができた AI の画像をカバーに付ける
    expect(runWorker(regenerated.dishes, regenerated.mealCoverImageUrl, [0]).cover).toBe(AI_0);
  });

  it('一部の料理だけ変わった作り直し: 同じまま残った写真の主菜は AI の画像の生成に回し、変わった副菜 (きんぴら) は主菜でないので画像の無い状態にする (billing/03 Q-16)', async () => {
    const regenerated = await reconcileDishImages({
      previousDishes: photoMeal(),
      nextDishes: [OYAKODON, { ...REGENERATED[1], displayOrder: 1 }],
      triggerSource: 'test:save-meal',
      fallbackMealImageUrl: PHOTO_URL,
      regeneration: true,
    });
    await expectReleasedToAi(regenerated.dishes[0], OYAKODON, 0);
    expect(regenerated.dishes[1]).toMatchObject({ image_url: null, image_source: null, image_status: null, image_subject_hash: null });
    expect(regenerated.jobs.map((job) => job.dishIndex)).toEqual([0]);
    expect(regenerated.mealCoverImageUrl).toBeNull();
    expect(runWorker(regenerated.dishes, regenerated.mealCoverImageUrl, [0]).cover).toBe(AI_0);
  });

  it('料理を足した作り直し (前の料理は同じ): 同じまま残った写真の主菜は AI の画像の生成に回し、写真の味噌汁と足した料理は主菜でないので画像の無い状態にする (billing/03 Q-16)', async () => {
    const added = { ...REGENERATED[1], displayOrder: 2 };
    const regenerated = await reconcileDishImages({
      previousDishes: photoMeal(),
      nextDishes: [OYAKODON, MISOSHIRU, added],
      triggerSource: 'test:save-meal',
      fallbackMealImageUrl: PHOTO_URL,
      regeneration: true,
    });
    await expectReleasedToAi(regenerated.dishes[0], OYAKODON, 0);
    expect(regenerated.dishes[1]).toMatchObject({ image_url: null, image_source: null, image_status: null, image_subject_hash: null });
    expect(regenerated.dishes[2]).toMatchObject({ image_url: null, image_source: null, image_status: null, image_subject_hash: null });
    expect(regenerated.jobs.map((job) => job.dishIndex)).toEqual([0]);
    expect(regenerated.mealCoverImageUrl).toBeNull();
  });

  it('カバーがすでに空の写真の料理の献立も、料理が変わった作り直しなら写真の料理を AI の画像の生成に回す', async () => {
    const regenerated = await reconcileDishImages({
      previousDishes: photoMeal(),
      nextDishes: [OYAKODON],
      triggerSource: 'test:save-meal',
      fallbackMealImageUrl: null,
      regeneration: true,
    });
    await expectReleasedToAi(regenerated.dishes[0], OYAKODON, 0);
    expect(regenerated.jobs.map((job) => job.dishIndex)).toEqual([0]);
    expect(regenerated.mealCoverImageUrl).toBeNull();
  });

  it('写真の複数の料理を同じ料理 (同じ数・同じ中身) で作り直したときは、写真の料理もカバーも残し、積まない', async () => {
    const regenerated = await reconcileDishImages({
      previousDishes: photoMeal(),
      nextDishes: [OYAKODON, MISOSHIRU],
      triggerSource: 'test:save-meal',
      fallbackMealImageUrl: PHOTO_URL,
      regeneration: true,
    });
    expect(regenerated.dishes.map((dish) => [dish.image_source, dish.image_status, dish.image_url])).toEqual([
      ['meal_photo', 'stale', null],
      ['meal_photo', 'stale', null],
    ]);
    expect(regenerated.jobs).toEqual([]);
    expect(regenerated.mealCoverImageUrl).toBe(PHOTO_URL);
  });

  it('regeneration が無い保存し直しでは、料理の数を減らしても写真の料理を AI の画像に回さない (今までどおり)', async () => {
    const resaved = await reconcileDishImages({
      previousDishes: photoMeal(),
      nextDishes: [OYAKODON],
      triggerSource: 'test:PATCH',
      fallbackMealImageUrl: PHOTO_URL,
    });
    expect(resaved.dishes[0]).toMatchObject({ image_url: null, image_source: 'meal_photo', image_status: 'stale' });
    expect(resaved.jobs).toEqual([]);
    expect(resaved.mealCoverImageUrl).toBe(PHOTO_URL);
  });

  it('自分の写真を持つ料理 (1 品の写真・主菜) は、料理を足した作り直しでも写真のまま残し、足した料理は主菜でないので積まず、カバーはその料理の写真から選び直す (billing/03 Q-16)', async () => {
    // 写真の献立のカバーは外すが、同じまま残った料理が自分の画像 (写真) を持つなら、その料理の画像がカバーの候補になる (deriveMealCoverImage)
    const regenerated = await reconcileDishImages({
      previousDishes: buildPhotoDishList([{ name: '親子丼', role: 'main' }], PHOTO_URL),
      nextDishes: [OYAKODON, { ...REGENERATED[1], displayOrder: 1 }],
      triggerSource: 'test:save-meal',
      fallbackMealImageUrl: PHOTO_URL,
      regeneration: true,
    });
    expect(regenerated.dishes[0]).toMatchObject({ image_url: PHOTO_URL, image_source: 'meal_photo', image_status: 'ready' });
    expect(regenerated.jobs.map((job) => job.dishIndex)).toEqual([]);
    expect(regenerated.dishes[1]).toMatchObject({ image_source: null, image_status: null, image_subject_hash: null });
    expect(regenerated.mealCoverImageUrl).toBe(PHOTO_URL);
  });

  it('商品の献立は、作り直しても外さない (商品の料理・商品の画像のまま)', async () => {
    const regenerated = await reconcileDishImages({
      previousDishes: [{ name: '幕の内弁当', role: 'main' }],
      nextDishes: [REGENERATED[0]],
      triggerSource: 'test:save-meal',
      fallbackMealImageUrl: PRODUCT_URL,
      previousMealIsCatalog: true,
      regeneration: true,
    });
    expect(regenerated.dishes[0]).toMatchObject({ image_source: 'catalog', image_url: null });
    expect(regenerated.jobs).toEqual([]);
    expect(regenerated.mealCoverImageUrl).toBe(PRODUCT_URL);
  });

  it('regeneration が無い保存し直し (PATCH など) は、今までどおり料理を変えても利用者の画像を外さない', async () => {
    const regenerated = await reconcileDishImages({
      previousDishes: buildPhotoDishList([{ name: '親子丼', role: 'main' }], PHOTO_URL),
      nextDishes: [REGENERATED[0]],
      triggerSource: 'test:PATCH',
      fallbackMealImageUrl: PHOTO_URL,
    });
    expect(regenerated.dishes[0]).toMatchObject({ image_url: PHOTO_URL, image_source: 'meal_photo' });
    expect(regenerated.jobs).toEqual([]);
    expect(regenerated.mealCoverImageUrl).toBe(PHOTO_URL);
  });
});

describe('process-meal-image-jobs の書き込み: カバーの二重の守り (writeGeneratedDishImage)', () => {
  interface Call {
    values: Record<string, unknown>;
    filters: Array<[string, string, unknown]>;
  }
  const READ_AT = '2026-10-12T00:00:00.000000+00:00';

  /**
   * planned_meals の update の作り物。rows は各回の update が当たる行数 (足りなければ最後の値)。
   * 競合の振る舞い (条件の評価・読み直し) は tests/process-meal-image-jobs-write-race.test.ts (#1527)
   */
  function makeDb(rows: number[]): { db: PlannedMealWriter; calls: Call[] } {
    const calls: Call[] = [];
    const db: PlannedMealWriter = {
      from: () => ({
        update: (values) => {
          const call: Call = { values, filters: [] };
          const index = calls.length;
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
              const count = rows[Math.min(index, rows.length - 1)];
              return Promise.resolve({ data: Array.from({ length: count }, () => ({ id: 'meal-1' })), error: null });
            },
          };
          return filter;
        },
      }),
    };
    return { db, calls };
  }

  /** 料理 1 品 (dish 0) の、画像を待っている AI の献立の行を読む関数 */
  async function readerOf(cover: string | null, updatedAt: string | null = READ_AT) {
    const result = await reconcileDishImages({ previousDishes: [], nextDishes: [THREE_DISHES[0]], triggerSource: 'test' });
    const dishes = result.dishes;
    return {
      subjectHash: dishes[0].image_subject_hash ?? null,
      read: async () => ({ id: 'meal-1', dishes: structuredClone(dishes), image_url: cover, updated_at: updatedAt }),
    };
  }

  it('カバーを変えないときは、料理だけを書き、image_url に触れない (読んだときの updated_at の行にだけ書く)', async () => {
    const { db, calls } = makeDb([1]);
    const { subjectHash, read } = await readerOf(USER_COVER);
    await writeGeneratedDishImage(db, { mealId: 'meal-1', dishIndex: 0, subjectHash, imageUrl: AI_0, read });
    expect(calls).toHaveLength(1);
    expect(calls[0].values).not.toHaveProperty('image_url');
    expect(calls[0].filters).toEqual([['eq', 'id', 'meal-1'], ['eq', 'updated_at', READ_AT]]);
  });

  it('カバーを変えるときは、読んだときのカバーと updated_at のままの行にだけ書く', async () => {
    const { db, calls } = makeDb([1]);
    const { subjectHash, read } = await readerOf(null);
    await writeGeneratedDishImage(db, { mealId: 'meal-1', dishIndex: 0, subjectHash, imageUrl: AI_0, read });
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toMatchObject({ image_url: AI_0 });
    expect(calls[0].filters).toEqual([['eq', 'id', 'meal-1'], ['eq', 'updated_at', READ_AT], ['is', 'image_url', null]]);

    const aiCover = makeDb([1]);
    const withAiCover = await readerOf(AI_1);
    // AI_1 はこの献立の料理の画像ではない (料理の画像と一致しない) ので、利用者のカバーとして守られる
    await writeGeneratedDishImage(aiCover.db, { mealId: 'meal-1', dishIndex: 0, subjectHash: withAiCover.subjectHash, imageUrl: AI_0, read: withAiCover.read });
    expect(aiCover.calls[0].values).not.toHaveProperty('image_url');

    const nullUpdatedAt = makeDb([1]);
    const withoutUpdatedAt = await readerOf(null, null);
    await writeGeneratedDishImage(nullUpdatedAt.db, { mealId: 'meal-1', dishIndex: 0, subjectHash: withoutUpdatedAt.subjectHash, imageUrl: AI_0, read: withoutUpdatedAt.read });
    expect(nullUpdatedAt.calls[0].filters).toEqual([['eq', 'id', 'meal-1'], ['is', 'updated_at', null], ['is', 'image_url', null]]);
  });

  it('読んでから書くまでに行が変わっていたら (0 行)、古い料理を条件なしで書かずに、読み直して書き直す (#1527)', async () => {
    const { db, calls } = makeDb([0, 1]);
    const { subjectHash, read } = await readerOf(null);
    const outcome = await writeGeneratedDishImage(db, { mealId: 'meal-1', dishIndex: 0, subjectHash, imageUrl: AI_0, read });
    expect(outcome).toEqual({ status: 'written' });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.filters).toContainEqual(['eq', 'updated_at', READ_AT]);
    }
  });

  it('画像の処理 (index.ts) は、料理とカバーを writeGeneratedDishImage で書き (中で applyGeneratedDishImage がカバーを決める)、直に image_url を書かない', () => {
    const source = readFileSync(join(process.cwd(), 'supabase/functions/process-meal-image-jobs/index.ts'), 'utf8');
    const utils = readFileSync(join(process.cwd(), 'supabase/functions/process-meal-image-jobs/utils.ts'), 'utf8');
    expect(source).toContain('writeGeneratedDishImage(supabase');
    expect(source).not.toContain('applyGeneratedDishImage(');
    expect(source).not.toContain('deriveMealCoverImage(');
    expect(source).not.toMatch(/image_url:\s*cover/);
    // 献立の料理を直に書く update は index.ts に無い (料理の書き込みはすべて utils.ts の楽観的な排他を通す。#1527)
    expect(source).not.toMatch(/from\("planned_meals"\)\s*\.update\(/);
    expect(utils).toContain('applyGeneratedDishImage(');
    expect(utils).not.toContain('deriveMealCoverImage(');
  });
});
