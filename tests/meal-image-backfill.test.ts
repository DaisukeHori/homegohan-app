/**
 * #1505 料理画像を待ったままの料理に、ジョブを積み直す道具 (scripts/lib/meal-image-backfill.ts) の判定と引数
 *
 *   1. planDishImageJobs: 画像が無い AI の画像の、待ち・更新待ち (pending / stale) で、image_subject_hash がある料理だけを積む。
 *      プロンプト・モデルは料理に書いたもの (無ければ今の作り方・既定のモデル)。
 *      保存し直し (reconcileDishImages) が積まない料理は積まない (#1514 と同じ共通の判定): 商品の献立の古い商品の料理 (asCatalogMealDish)、
 *      献立のカバーが料理ごとの画像を持たない写真・商品・手の画像の料理のもの (isMealCoverHeldByImagelessPreservedDish) の献立の料理
 *   2. parseMealImageBackfillArgs: 既定は dry-run・50 献立・処理を起こす。上限を超える数・分からない引数は止める
 *   3. resolveMealImageBackfillIntervalMs: 環境変数で待ちを上書きできる
 *   4. (billing/03 Q-16) 積み直すのは献立の主菜 (自動の料理画像を作る 1 品。autoImageDishIndexOf) の待ちの料理だけ。ほかは not_auto_image_dish
 * 実 DB に対しての数え方・積み直しは tests/integration/rls/meal-image-backfill.test.ts
 */
import { describe, expect, it } from 'vitest';

import {
  MEAL_IMAGE_BACKFILL_DEFAULT_INTERVAL_MS,
  MEAL_IMAGE_BACKFILL_DEFAULT_MAX_MEALS,
  MEAL_IMAGE_BACKFILL_MAX_MEALS_LIMIT,
  MEAL_IMAGE_BACKFILL_TRIGGER_SOURCE,
  parseMealImageBackfillArgs,
  planDishImageJobs,
  resolveMealImageBackfillIntervalMs,
} from '../scripts/lib/meal-image-backfill';
import { DEFAULT_MEAL_IMAGE_MODEL, buildDishImagePrompt } from '../supabase/functions/_shared/meal-image';

describe('planDishImageJobs', () => {
  it('画像が無い AI の画像の、待ち・更新待ちで subject_hash がある料理だけを積む。理由ごとに数える (積むのは献立の主菜の 1 品だけ。主菜の無い献立は先頭の料理。billing/03 Q-16)', () => {
    const dishes = [
      { name: 'カレー', image_status: 'pending', image_url: null, image_source: 'generated_ai', image_subject_hash: 'h0', image_prompt: 'p0', image_model: 'm0' },
      { name: 'サラダ', image_status: 'stale', image_url: null, image_subject_hash: 'h1' },
      { name: '味噌汁', image_status: 'ready', image_url: 'https://example.com/x.png', image_subject_hash: 'h2' },
      { name: '写真', image_status: 'stale', image_source: 'meal_photo', image_subject_hash: 'h3' },
      { name: '画像あり', image_status: 'pending', image_url: 'https://example.com/y.png', image_subject_hash: 'h4' },
      { name: '印なし', image_status: 'pending', image_url: null },
      { name: '失敗', image_status: 'failed', image_url: null, image_subject_hash: 'h6' },
      'not-an-object',
    ];
    const plan = planDishImageJobs(dishes);

    expect(plan.seeds).toEqual([
      { dishIndex: 0, dishName: 'カレー', subjectHash: 'h0', prompt: 'p0', model: 'm0', triggerSource: MEAL_IMAGE_BACKFILL_TRIGGER_SOURCE, referenceImageUrls: [] },
    ]);
    expect(plan.skipped).toEqual({
      not_waiting: 2,
      has_image: 1,
      not_ai_image: 1,
      no_subject_hash: 1,
      not_object: 1,
      catalog_meal_dish: 0,
      meal_cover_preserved: 0,
      not_auto_image_dish: 1,
    });
    // 更新待ち・source なしの料理も積む対象 (その料理だけの献立なら、先頭の料理として積む)
    expect(planDishImageJobs([dishes[1]]).seeds).toEqual([{ dishIndex: 0, dishName: 'サラダ', subjectHash: 'h1', prompt: buildDishImagePrompt(dishes[1] as { name: string }), model: DEFAULT_MEAL_IMAGE_MODEL, triggerSource: MEAL_IMAGE_BACKFILL_TRIGGER_SOURCE, referenceImageUrls: [] }]);
  });

  it('商品の献立 (catalog_product_id / source_type) の、画像の項目の無い古い商品の料理 (先頭) は積まない (#1514 の asCatalogMealDish)', () => {
    const dishes = [{ name: '商品', image_status: 'pending', image_url: null, image_source: 'generated_ai', image_subject_hash: 'h0' }];
    for (const meal of [{ catalog_product_id: 'product-1' }, { source_type: 'catalog_product' }]) {
      const plan = planDishImageJobs(dishes, meal);
      expect(plan.seeds).toEqual([]);
      expect(plan.skipped.catalog_meal_dish).toBe(1);
    }
    // 商品の献立でなければ、同じ料理を積む
    expect(planDishImageJobs(dishes, {}).seeds.map((seed) => seed.dishIndex)).toEqual([0]);
  });

  it('献立のカバーが、料理ごとの画像を持たない写真・商品・手の画像の料理のものなら、その献立の料理はどれも積まない (#1514)', () => {
    const photoMealDishes = [
      { name: '写真の料理', image_status: 'stale', image_url: null, image_source: 'meal_photo' },
      { name: '足した料理', role: 'main', image_status: 'pending', image_url: null, image_source: 'generated_ai', image_subject_hash: 'h1' },
    ];
    const held = planDishImageJobs(photoMealDishes, { image_url: 'https://example.com/photo.jpg' });
    expect(held.seeds).toEqual([]);
    expect(held.skipped).toMatchObject({ not_ai_image: 1, meal_cover_preserved: 1 });

    // 商品の献立の古い商品の料理 (商品の料理として読む) がカバーを持つときも、ほかの料理を積まない
    const catalogMealDishes = [
      { name: '商品', image_status: 'pending', image_url: null, image_subject_hash: 'h0' },
      { name: '足した料理', image_status: 'pending', image_url: null, image_source: 'generated_ai', image_subject_hash: 'h1' },
    ];
    const catalogHeld = planDishImageJobs(catalogMealDishes, { image_url: 'https://example.com/product.jpg', catalog_product_id: 'product-1' });
    expect(catalogHeld.seeds).toEqual([]);
    expect(catalogHeld.skipped).toMatchObject({ catalog_meal_dish: 1, meal_cover_preserved: 1 });

    // カバーが無ければ、写真の料理以外の AI の料理は積む (reconcileDishImages と同じ)
    expect(planDishImageJobs(photoMealDishes, { image_url: null }).seeds.map((seed) => seed.dishIndex)).toEqual([1]);
  });

  it('planDishImageJobs skips waiting dishes other than the auto image dish as not_auto_image_dish and still plans the waiting main dish (billing/03 Q-16)', () => {
    const waiting = (name: string, role: string, hash: string) => ({ name, role, image_status: 'pending', image_url: null, image_source: 'generated_ai', image_subject_hash: hash });
    // 段 B の前に積まれた献立: どの料理も画像を待っている。積み直すのは主菜 (位置 1) だけ
    const plan = planDishImageJobs([waiting('ご飯', 'rice', 'h0'), waiting('鮭の塩焼き', 'main', 'h1'), waiting('味噌汁', 'soup', 'h2')]);
    expect(plan.seeds.map((seed) => [seed.dishIndex, seed.dishName])).toEqual([[1, '鮭の塩焼き']]);
    expect(plan.skipped.not_auto_image_dish).toBe(2);
    // 日本語の役割「主菜」も主菜。料理でない値は役割の無い料理として位置を数える
    const japanese = planDishImageJobs(['not-an-object', waiting('焼き魚', '主菜', 'h1'), waiting('サラダ', 'side', 'h2')]);
    expect(japanese.seeds.map((seed) => seed.dishIndex)).toEqual([1]);
    expect(japanese.skipped).toMatchObject({ not_object: 1, not_auto_image_dish: 1 });
    // 主菜が画像を持つ (ready) なら、ほかの待ちの料理は積まない
    const mainReady = planDishImageJobs([{ ...waiting('鮭の塩焼き', 'main', 'h0'), image_status: 'ready', image_url: 'https://example.com/a.png' }, waiting('味噌汁', 'soup', 'h1')]);
    expect(mainReady.seeds).toEqual([]);
    expect(mainReady.skipped).toMatchObject({ not_waiting: 1, not_auto_image_dish: 1 });
  });

  it('料理が配列でなければ何も積まない', () => {
    expect(planDishImageJobs(null).seeds).toEqual([]);
    expect(planDishImageJobs({}).seeds).toEqual([]);
  });
});

describe('parseMealImageBackfillArgs', () => {
  it('既定は dry-run・既定の献立数・処理を起こす', () => {
    expect(parseMealImageBackfillArgs([])).toEqual({
      apply: false,
      maxMeals: MEAL_IMAGE_BACKFILL_DEFAULT_MAX_MEALS,
      since: null,
      userId: null,
      trigger: true,
    });
  });

  it('--apply・--max-meals・--since・--user-id・--no-trigger を読む', () => {
    const userId = '11111111-2222-3333-4444-555555555555';
    expect(parseMealImageBackfillArgs(['--apply', '--max-meals=3', '--since=2026-10-01', `--user-id=${userId}`, '--no-trigger'])).toEqual({
      apply: true,
      maxMeals: 3,
      since: '2026-10-01',
      userId,
      trigger: false,
    });
  });

  it.each([
    [`--max-meals=${MEAL_IMAGE_BACKFILL_MAX_MEALS_LIMIT + 1}`],
    ['--max-meals=0'],
    ['--max-meals=1.5'],
    ['--since=2026/10/01'],
    ['--user-id=abc'],
    ['--force'],
  ])('%s は止める (何もしない)', (arg) => {
    expect(() => parseMealImageBackfillArgs([arg])).toThrow();
  });

  it('上限ちょうどは受け付ける', () => {
    expect(parseMealImageBackfillArgs([`--max-meals=${MEAL_IMAGE_BACKFILL_MAX_MEALS_LIMIT}`]).maxMeals).toBe(MEAL_IMAGE_BACKFILL_MAX_MEALS_LIMIT);
  });
});

describe('resolveMealImageBackfillIntervalMs', () => {
  it('未設定・空なら既定、整数なら上書き、それ以外は止める', () => {
    expect(resolveMealImageBackfillIntervalMs(undefined)).toBe(MEAL_IMAGE_BACKFILL_DEFAULT_INTERVAL_MS);
    expect(resolveMealImageBackfillIntervalMs(' ')).toBe(MEAL_IMAGE_BACKFILL_DEFAULT_INTERVAL_MS);
    expect(resolveMealImageBackfillIntervalMs('2500')).toBe(2500);
    expect(() => resolveMealImageBackfillIntervalMs('-1')).toThrow();
    expect(() => resolveMealImageBackfillIntervalMs('fast')).toThrow();
  });
});
