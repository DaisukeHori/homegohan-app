// @vitest-environment node
/**
 * #1487 料理画像の見送り・積み直し・数え戻しと、安全弁の 429 の文 (部品の単体テスト)
 *
 *   1. markDishImagesSkipped: ジョブを積まないと決まった料理だけを 'failed' + 見送りの理由にする (ほかの料理は変えない)
 *   2. reconcileDishImages: 同じ料理 (subject_hash が同じ) でも、画像が無く待ち・更新待ち・失敗のままなら積み直す。
 *      画像がある・写真・手で付けた画像は積み直さない
 *   3. enqueueMealImageJobs: 行ごとに insert する (冪等キーの一意な索引は部分索引なので、ON CONFLICT (idempotency_key) は使えない)。
 *      重複 (23505) と失敗を数え、1 行も積めなかったら数えた 1 回を戻す。書き込みに失敗した料理は 'failed' + 'enqueue_failed' にする (#1505)
 *   4. 安全弁 (上限に数えない機能) で止めたときの 429 の本文と文: 回数を出さない固定の文 (Web・モバイル共用)
 *   5. (#1487 の整合ゲート) 実データの形 (subject_hash の無い写真・商品の料理、端末から直に保存した料理) を前回にしたとき:
 *      保存し直しても料理の中身を変えても、写真・商品・手で付けた画像を AI の画像で置き換えない。料理を変えない保存し直しでは積まない
 *   6. (#1487 の整合ゲート R1) 商品の献立の古い商品の料理 (画像の項目なし・以前の保存し直しで generated_ai に書き換わったもの) と、
 *      献立のカバーが料理ごとの画像を持たない写真・商品の料理のもの (写真の複数の料理) に料理を足したとき:
 *      画像の処理がジョブを全部書き終えたあとも、献立のカバーが写真・商品の画像のまま
 *
 * 入口 (route 4 本 + AI 相談の update_meal) での組み合わせは tests/meal-image-skip-routes.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  refundAiUsage: vi.fn(async () => undefined),
}));
vi.mock('@/lib/plan/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan/entitlements')>()),
  refundAiUsage: m.refundAiUsage,
}));
vi.mock('@/lib/db-logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AUTO_IMAGE_DISH_ROLES,
  AUTO_IMAGE_FALLBACK_DISH_INDEX,
  CATALOG_PRODUCT_MEAL_SOURCE_TYPE,
  MEAL_IMAGE_ENQUEUE_FAILED_ERROR,
  MEAL_IMAGE_SKIPPED_ERRORS,
  autoImageDishHandoverIndexOf,
  autoImageDishIndexOf,
  isMealImagePlanSkippedError,
  mealCoverRepresentsDish,
  mealImageJobPlanDecision,
  mealImageSkipReasonOf,
  asCatalogMealDish,
  buildDishImageSubjectHash,
  applyGeneratedDishImage,
  isCatalogProductMeal,
  buildMealImageIdempotencyKey,
  isMealImageSkippedError,
  markDishImagesSkipped,
  isAiImagePipelineDish,
  isPreservedDishImage,
  needsImageRetry,
  reconcileDishImages,
  buildPhotoDishList,
  type MealImageDish,
  type MealImageJobSeed,
} from '../supabase/functions/_shared/meal-image';
import { enqueueMealImageJobs } from '../lib/meal-image-jobs';
import {
  AI_AUTO_SAFETY_CAP_MESSAGE,
  AI_DAILY_LIMIT_CODE,
  aiDailyLimitMessage,
  aiDailyLimitMessageOfBody,
  aiDailyLimitPayload,
  parseConsumeAiUsageResult,
} from '../supabase/functions/_shared/ai-daily-limit';
import { AI_USAGE_ALLOWED, AI_USAGE_DENIED, TEST_AI_USAGE_DATE } from './helpers/ai-usage-mock';

const CURRY = { name: 'カレー', role: 'main', ingredients: ['じゃがいも', 'にんじん'] };
const SALAD = { name: 'サラダ', role: 'side', ingredients: ['レタス'] };

function seed(dishIndex: number): MealImageJobSeed {
  return {
    dishIndex,
    dishName: `dish-${dishIndex}`,
    subjectHash: `hash-${dishIndex}`,
    prompt: 'prompt',
    model: 'model',
    triggerSource: 'test',
    referenceImageUrls: [],
  };
}

describe('markDishImagesSkipped (#1487)', () => {
  it('ジョブの料理だけを failed + 見送りの理由にし、ほかの料理と元の配列は変えない', () => {
    const dishes: MealImageDish[] = [
      { name: 'カレー', image_status: 'pending', image_url: null, image_generated_at: null },
      { name: 'ご飯', image_status: 'ready', image_url: 'https://example.com/rice.png' },
    ];
    const marked = markDishImagesSkipped(dishes, [seed(0)], 'ai_limit');

    expect(marked[0]).toMatchObject({ name: 'カレー', image_status: 'failed', image_error: 'skipped_ai_limit', image_url: null });
    expect(marked[1]).toBe(dishes[1]);
    expect(dishes[0].image_status).toBe('pending');
    expect(markDishImagesSkipped(dishes, [seed(0)], 'rate_limit')[0].image_error).toBe('skipped_rate_limit');
  });

  it('見送りの理由の文字列は見送りとして判別でき、ほかの失敗の理由は見送りではない', () => {
    expect(Object.values(MEAL_IMAGE_SKIPPED_ERRORS).every(isMealImageSkippedError)).toBe(true);
    expect(isMealImageSkippedError('AI_CONSENT_REQUIRED')).toBe(false);
    expect(isMealImageSkippedError('storage upload failed')).toBe(false);
    expect(isMealImageSkippedError(null)).toBe(false);
  });
});

describe('reconcileDishImages: 同じ料理の積み直し (#1487)', () => {
  async function previousOf(overrides: Partial<MealImageDish>): Promise<MealImageDish[]> {
    return [{ ...CURRY, image_subject_hash: await buildDishImageSubjectHash(CURRY, 0), image_source: 'generated_ai', image_url: null, ...overrides }];
  }

  it.each([
    ['待ち (pending)', { image_status: 'pending' as const }],
    ['更新待ち (stale)', { image_status: 'stale' as const }],
    ['失敗 (failed)', { image_status: 'failed' as const, image_error: 'storage upload failed' }],
    ['見送り (failed + skipped_ai_limit)', { image_status: 'failed' as const, image_error: 'skipped_ai_limit' }],
    ['状態が未設定', { image_status: null }],
  ])('前回が %s で画像が無ければ、ジョブを積み直し、pending にして理由を消す', async (_label, overrides) => {
    const result = await reconcileDishImages({ previousDishes: await previousOf(overrides), nextDishes: [CURRY], triggerSource: 'manual-edit' });

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({ dishIndex: 0, subjectHash: await buildDishImageSubjectHash(CURRY, 0) });
    expect(result.dishes[0]).toMatchObject({ image_status: 'pending', image_error: null, image_url: null, image_source: 'generated_ai' });
  });

  it.each([
    ['画像がある (ready)', { image_status: 'ready' as const, image_url: 'https://example.com/curry.png' }],
    ['写真の料理 (meal_photo・stale)', { image_status: 'stale' as const, image_source: 'meal_photo' as const }],
    ['商品 (catalog)', { image_status: 'pending' as const, image_source: 'catalog' as const }],
    ['手で付けた画像 (manual_override)', { image_status: 'stale' as const, image_source: 'manual_override' as const, image_url: 'https://example.com/m.png' }],
  ])('前回が %s なら積み直さず、前回の状態をそのまま写す', async (_label, overrides) => {
    const previous = await previousOf(overrides);
    const result = await reconcileDishImages({ previousDishes: previous, nextDishes: [CURRY], triggerSource: 'manual-edit' });

    expect(result.jobs).toHaveLength(0);
    expect(result.dishes[0].image_status).toBe(previous[0].image_status);
    expect(result.dishes[0].image_source).toBe(previous[0].image_source);
  });

  it('needsImageRetry: 画像が無い AI の画像の、待ち・更新待ち・失敗だけ', () => {
    expect(needsImageRetry({ image_status: 'failed', image_source: 'generated_ai' })).toBe(true);
    expect(needsImageRetry({ image_status: 'pending' })).toBe(true);
    expect(needsImageRetry({ image_status: 'ready', image_source: 'generated_ai' })).toBe(false);
    expect(needsImageRetry({ image_status: 'failed', image_url: 'https://example.com/x.png' })).toBe(false);
    expect(needsImageRetry({ image_status: 'stale', image_source: 'meal_photo' })).toBe(false);
  });
});

/**
 * meal_image_jobs への insert の作り物。行ごとに返す結果を決める。
 * planned_meals は、積めなかった料理を 'failed' にする読み書き (#1505) のために、保存済みの料理 (dishes) を返し、書いた料理を記録する
 */
function makeQueueDb(
  outcomeOf: (row: Record<string, unknown>, index: number) => { code: string; message: string } | null | 'throw',
  storedDishes: MealImageDish[] = [],
) {
  const inserted: Array<Record<string, unknown>> = [];
  const upsert = vi.fn();
  const mealUpdates: Array<{ id: unknown; dishes: MealImageDish[] }> = [];
  let calls = 0;
  const from = vi.fn((table: string) => {
    if (table === 'planned_meals') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { dishes: storedDishes }, error: null }) }) }),
        update: (values: { dishes: MealImageDish[] }) => ({
          eq: async (_column: string, id: unknown) => {
            mealUpdates.push({ id, dishes: values.dishes });
            return { data: null, error: null };
          },
        }),
      };
    }
    if (table !== 'meal_image_jobs') throw new Error(`unexpected table ${table}`);
    return {
      upsert,
      insert: vi.fn(async (row: Record<string, unknown>) => {
        const outcome = outcomeOf(row, calls++);
        if (outcome === 'throw') throw new Error('network down');
        if (!outcome) inserted.push(row);
        return { data: null, error: outcome };
      }),
    };
  });
  return { db: { from } as unknown as SupabaseClient, inserted, upsert, from, mealUpdates };
}

/** 保存済みの、画像を待っている料理 (seed(dishIndex) と同じ subject_hash) */
function storedPendingDish(dishIndex: number): MealImageDish {
  return { name: `dish-${dishIndex}`, image_url: null, image_source: 'generated_ai', image_status: 'pending', image_subject_hash: `hash-${dishIndex}` };
}

const UNIQUE_VIOLATION = { code: '23505', message: 'duplicate key value violates unique constraint "meal_image_jobs_idempotency_pending_idx"' };
const PERMISSION_DENIED = { code: '42501', message: 'permission denied for table meal_image_jobs' };

describe('enqueueMealImageJobs: 行ごとに積み、積めなかったら数え戻す (#1487)', () => {
  beforeEach(() => {
    m.refundAiUsage.mockClear();
  });

  const base = { plannedMealId: 'meal-1', userId: 'user-1', triggerSource: 'test', requestId: null };

  it('行ごとに insert し (ON CONFLICT を使わない)、積めた行を数える。積めたら数え戻さない', async () => {
    const queue = makeQueueDb(() => null);
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobSeeds: [seed(0), seed(1)], usage: AI_USAGE_ALLOWED });

    expect(result).toEqual({ inserted: 2, duplicates: 0, duplicatesProcessing: 0, failed: 0 });
    expect(queue.upsert).not.toHaveBeenCalled();
    expect(queue.inserted.map((row) => row.dish_index)).toEqual([0, 1]);
    expect(queue.inserted[0]).toMatchObject({
      planned_meal_id: 'meal-1',
      user_id: 'user-1',
      status: 'pending',
      idempotency_key: await buildMealImageIdempotencyKey({ plannedMealId: 'meal-1', dishIndex: 0, subjectHash: 'hash-0' }),
    });
    expect(m.refundAiUsage).not.toHaveBeenCalled();
  });

  it('書き込みに失敗して 1 行も積めなかったら、数えた 1 回を戻し、料理を failed + enqueue_failed にする (#1505)', async () => {
    const queue = makeQueueDb(() => PERMISSION_DENIED, [storedPendingDish(0)]);
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobSeeds: [seed(0)], usage: AI_USAGE_ALLOWED });

    expect(result).toEqual({ inserted: 0, duplicates: 0, duplicatesProcessing: 0, failed: 1 });
    expect(queue.mealUpdates).toHaveLength(1);
    expect(queue.mealUpdates[0].id).toBe('meal-1');
    expect(queue.mealUpdates[0].dishes[0]).toMatchObject({ image_status: 'failed', image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR, image_url: null });
    expect(m.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(m.refundAiUsage).toHaveBeenCalledWith('user-1', 'meal_image_auto', AI_USAGE_ALLOWED);
  });

  it('insert が例外を投げても、例外を投げずに失敗として数え、数え戻す', async () => {
    const queue = makeQueueDb(() => 'throw');
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobSeeds: [seed(0)], usage: AI_USAGE_ALLOWED });

    expect(result).toEqual({ inserted: 0, duplicates: 0, duplicatesProcessing: 0, failed: 1 });
    expect(m.refundAiUsage).toHaveBeenCalledWith('user-1', 'meal_image_auto', AI_USAGE_ALLOWED);
  });

  it('すべて重複 (同じ料理の待ち・処理中のジョブがある) で 0 件なら、数えた 1 回を戻す', async () => {
    const queue = makeQueueDb(() => UNIQUE_VIOLATION);
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobSeeds: [seed(0), seed(1)], usage: AI_USAGE_ALLOWED });

    expect(result).toEqual({ inserted: 0, duplicates: 2, duplicatesProcessing: 0, failed: 0 });
    expect(m.refundAiUsage).toHaveBeenCalledTimes(1);
    // 重複の料理は待ちのまま (待ち・処理中のジョブが画像を作る)。献立は書かない
    expect(queue.mealUpdates).toEqual([]);
  });

  it('一部の行だけ失敗したら、失敗した料理だけを failed にする。積めた料理は待ちのまま (#1505)', async () => {
    const queue = makeQueueDb((_row, index) => (index === 1 ? PERMISSION_DENIED : null), [storedPendingDish(0), storedPendingDish(1)]);
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobSeeds: [seed(0), seed(1)], usage: AI_USAGE_ALLOWED });

    expect(result).toEqual({ inserted: 1, duplicates: 0, duplicatesProcessing: 0, failed: 1 });
    expect(m.refundAiUsage).not.toHaveBeenCalled();
    expect(queue.mealUpdates[0].dishes.map((dish) => [dish.image_status, dish.image_error ?? null])).toEqual([
      ['pending', null],
      ['failed', MEAL_IMAGE_ENQUEUE_FAILED_ERROR],
    ]);
  });

  it('一部でも積めたら (AI へ送るので) 数え戻さない', async () => {
    const queue = makeQueueDb((_row, index) => (index === 0 ? UNIQUE_VIOLATION : null));
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobSeeds: [seed(0), seed(1)], usage: AI_USAGE_ALLOWED });

    expect(result).toEqual({ inserted: 1, duplicates: 1, duplicatesProcessing: 0, failed: 0 });
    expect(m.refundAiUsage).not.toHaveBeenCalled();
  });

  it('数えていない (usage なし・止めた結果) なら、積めなくても戻さない', async () => {
    const queue = makeQueueDb(() => PERMISSION_DENIED);
    await enqueueMealImageJobs({ ...base, supabase: queue.db, jobSeeds: [seed(0)] });
    await enqueueMealImageJobs({ ...base, supabase: queue.db, jobSeeds: [seed(0)], usage: null });
    await enqueueMealImageJobs({ ...base, supabase: queue.db, jobSeeds: [seed(0)], usage: AI_USAGE_DENIED });

    expect(m.refundAiUsage).not.toHaveBeenCalled();
  });
});

describe('安全弁で止めたときの 429 (#1487)', () => {
  const AUTO_CAP = 30;
  const NOW = Date.UTC(2026, 9, 11, 3, 0, 0);

  it('DB が metered: false で止めたら (安全弁)、safetyCap を付けて読む。明示の上限の止めには付けない', () => {
    expect(
      parseConsumeAiUsageResult({ allowed: false, metered: false, plan: null, limit: AUTO_CAP, used: AUTO_CAP, usage_date: TEST_AI_USAGE_DATE }),
    ).toEqual({ allowed: false, limit: AUTO_CAP, used: AUTO_CAP, usageDate: TEST_AI_USAGE_DATE, safetyCap: true });
    expect(
      parseConsumeAiUsageResult({ allowed: false, metered: true, plan: 'free', limit: 10, used: 10, usage_date: TEST_AI_USAGE_DATE }),
    ).toEqual({ allowed: false, limit: 10, used: 10, usageDate: TEST_AI_USAGE_DATE });
  });

  it('安全弁の本文は回数を出さない固定の文で、limit を入れない。画面の文 (Web・モバイル共用) も同じ', () => {
    const { status, body } = aiDailyLimitPayload({ limit: AUTO_CAP, safetyCap: true }, NOW);

    expect(status).toBe(429);
    expect(body).toEqual({ error: AI_AUTO_SAFETY_CAP_MESSAGE, code: AI_DAILY_LIMIT_CODE, safetyCap: true, retryAfter: body.retryAfter });
    expect(body.error).not.toContain(String(AUTO_CAP));
    expect(aiDailyLimitMessageOfBody(body)).toBe(AI_AUTO_SAFETY_CAP_MESSAGE);
    // 入れ子の形 ({ error: { code, safetyCap } }) も同じ文
    expect(aiDailyLimitMessageOfBody({ error: { code: AI_DAILY_LIMIT_CODE, safetyCap: true, limit: AUTO_CAP } })).toBe(AI_AUTO_SAFETY_CAP_MESSAGE);
  });

  it('明示の上限の本文は今までどおり (回数を出す)', () => {
    const { body } = aiDailyLimitPayload({ limit: 10 }, NOW);

    expect(body).toMatchObject({ error: aiDailyLimitMessage(10), code: AI_DAILY_LIMIT_CODE, limit: 10 });
    expect(body).not.toHaveProperty('safetyCap');
    expect(aiDailyLimitMessageOfBody(body)).toBe(aiDailyLimitMessage(10));
  });
});

describe('#1487 の回帰の前提: 2 つ目の料理だけに積むとき、1 つ目の料理は変えない', () => {
  it('reconcile の結果のジョブの料理だけを見送りにする', async () => {
    const readyHash = await buildDishImageSubjectHash(SALAD, 0);
    const result = await reconcileDishImages({
      previousDishes: [{ ...SALAD, image_subject_hash: readyHash, image_status: 'ready', image_url: 'https://example.com/s.png', image_source: 'generated_ai' }],
      nextDishes: [SALAD, CURRY],
      triggerSource: 'manual-edit',
    });
    expect(result.jobs.map((job) => job.dishIndex)).toEqual([1]);

    const marked = markDishImagesSkipped(result.dishes, result.jobs, 'ai_limit');
    expect(marked[0]).toMatchObject({ image_status: 'ready', image_url: 'https://example.com/s.png' });
    expect(marked[1]).toMatchObject({ image_status: 'failed', image_error: 'skipped_ai_limit' });
  });
});

describe('reconcileDishImages: 実データの形 (subject_hash の無い料理) を前回にしたとき (#1487 の整合ゲート)', () => {
  const PHOTO_URL = 'https://example.com/storage/meal-photos/user-1/photo.jpg';
  const PRODUCT_URL = 'https://example.com/catalog/bento.jpg';
  const OYAKODON = { name: '親子丼', role: 'main', ingredient: '鶏肉、卵' };
  const MISO = { name: '味噌汁', role: 'soup', ingredient: '豆腐' };
  const PRODUCT = {
    id: 'catalog-1',
    sourceId: 'source-1',
    sourceCode: 'store',
    brandName: 'ブランド',
    name: '幕の内弁当',
    categoryCode: null,
    description: null,
    imageUrl: PRODUCT_URL,
    canonicalUrl: 'https://example.com/catalog/bento',
    priceYen: 500,
    caloriesKcal: 650,
    proteinG: 20,
    fatG: 18,
    carbsG: 90,
    sodiumG: 2.5,
    fiberG: 3,
    sugarG: 5,
    availabilityStatus: 'available',
  };

  /** 料理以外だけを変える保存 (完了の切り替え): 入口は送られた料理が無いので、前回の料理を写して渡す (buildDishImagePayload の ensureNextDishes) */
  const unchanged = (dishes: MealImageDish[]): MealImageDish[] => dishes.map((dish) => ({ ...dish }));

  it('前提: 写真の料理・商品の料理は subject_hash を持たない', async () => {
    const { buildPhotoDishList } = await import('../lib/meal-image');
    const { buildCatalogMealFields } = await import('../lib/catalog-products');
    expect(buildPhotoDishList([OYAKODON], PHOTO_URL)[0].image_subject_hash).toBeUndefined();
    expect(buildCatalogMealFields(PRODUCT).dishes[0]).not.toHaveProperty('image_subject_hash');
  });

  it.each([
    ['写真の料理 (1 つ・画像あり)', async () => (await import('../lib/meal-image')).buildPhotoDishList([OYAKODON], PHOTO_URL)],
    ['写真の料理 (複数・料理ごとの画像なし)', async () => (await import('../lib/meal-image')).buildPhotoDishList([OYAKODON, MISO], PHOTO_URL)],
    ['商品の料理 (画像あり)', async () => (await import('../lib/catalog-products')).buildCatalogMealFields(PRODUCT).dishes as MealImageDish[]],
    ['商品の料理 (商品の画像なし)', async () => (await import('../lib/catalog-products')).buildCatalogMealFields({ ...PRODUCT, imageUrl: null }).dishes as MealImageDish[]],
  ])('%s: 料理を変えずに保存し直してもジョブを積まず、画像と状態をそのまま写す', async (_label, build) => {
    const previous = await build();
    const result = await reconcileDishImages({ previousDishes: previous, nextDishes: unchanged(previous), triggerSource: 'toggle' });

    expect(result.jobs).toEqual([]);
    previous.forEach((dish, index) => {
      expect(result.dishes[index]).toMatchObject({
        image_url: dish.image_url ?? null,
        image_source: dish.image_source,
        image_status: dish.image_status ?? null,
        image_subject_hash: null,
      });
    });
  });

  it.each([
    ['写真の料理 (1 つ)', async () => (await import('../lib/meal-image')).buildPhotoDishList([OYAKODON], PHOTO_URL)],
    ['写真の料理 (複数)', async () => (await import('../lib/meal-image')).buildPhotoDishList([OYAKODON, MISO], PHOTO_URL)],
    ['商品の料理', async () => (await import('../lib/catalog-products')).buildCatalogMealFields(PRODUCT).dishes as MealImageDish[]],
  ])('%s: 料理の中身を変えても (名前・材料)、AI の画像で置き換えない', async (_label, build) => {
    const previous = await build();
    // 画面が前回の料理を編集して送る形と、AI が画像の項目の無い料理を送る形の両方
    const edited = previous.map((dish) => ({ ...dish, name: `${String(dish.name)}(大盛り)`, ingredient: '変更後の材料' }));
    const bare = previous.map((_dish, index) => ({ name: `別の料理${index}`, role: 'main' }));
    for (const next of [edited, bare]) {
      const result = await reconcileDishImages({ previousDishes: previous, nextDishes: next, triggerSource: 'edit' });
      expect(result.jobs).toEqual([]);
      previous.forEach((dish, index) => {
        expect(result.dishes[index]).toMatchObject({ image_url: dish.image_url ?? null, image_source: dish.image_source, image_status: dish.image_status ?? null });
        expect(result.dishes[index].name).toBe(next[index].name);
      });
    }
  });

  it('写真の料理 (1 つ) の献立のカバーは写真のまま', async () => {
    const { buildPhotoDishList } = await import('../lib/meal-image');
    const previous = buildPhotoDishList([OYAKODON], PHOTO_URL);
    const result = await reconcileDishImages({ previousDishes: previous, nextDishes: unchanged(previous), triggerSource: 'toggle', fallbackMealImageUrl: PHOTO_URL });
    expect(result.mealCoverImageUrl).toBe(PHOTO_URL);
  });

  it('写真の料理が subject_hash を持っていても (古い行・どこかで付いた)、置き換えず、hash を外す', async () => {
    const { buildPhotoDishList } = await import('../lib/meal-image');
    const previous = buildPhotoDishList([OYAKODON], PHOTO_URL).map((dish) => ({ ...dish, image_subject_hash: 'stray-hash' }));
    const result = await reconcileDishImages({ previousDishes: previous, nextDishes: [{ name: 'カツ丼', role: 'main' }], triggerSource: 'edit' });
    expect(result.jobs).toEqual([]);
    expect(result.dishes[0]).toMatchObject({ image_url: PHOTO_URL, image_source: 'meal_photo', image_status: 'ready', image_subject_hash: null });
  });

  it('手で付けた画像 (manual_override): 料理を変えると今までどおり stale にし、積まない。変えなければ状態をそのまま写す', async () => {
    const previous: MealImageDish[] = [{ ...OYAKODON, image_url: 'https://example.com/m.png', image_source: 'manual_override', image_status: 'ready' }];
    const changed = await reconcileDishImages({ previousDishes: previous, nextDishes: [{ name: 'カツ丼', role: 'main' }], triggerSource: 'edit' });
    expect(changed.jobs).toEqual([]);
    expect(changed.dishes[0]).toMatchObject({ image_url: 'https://example.com/m.png', image_source: 'manual_override', image_status: 'stale', image_subject_hash: null });

    const same = await reconcileDishImages({ previousDishes: previous, nextDishes: unchanged(previous), triggerSource: 'toggle' });
    expect(same.jobs).toEqual([]);
    expect(same.dishes[0]).toMatchObject({ image_status: 'ready', image_url: 'https://example.com/m.png' });
  });

  it('source が無く画像がある料理 (この仕組みの外で付いた画像) は、料理を変えても置き換えない', async () => {
    const previous: MealImageDish[] = [{ ...OYAKODON, image_url: PHOTO_URL }];
    const result = await reconcileDishImages({ previousDishes: previous, nextDishes: [{ name: 'カツ丼', role: 'main' }], triggerSource: 'edit' });
    expect(result.jobs).toEqual([]);
    expect(result.dishes[0]).toMatchObject({ image_url: PHOTO_URL, image_source: null });
  });

  it('subject_hash も source も無い料理 (端末から直に保存した料理): 変えずに保存し直しても積まず、状態を pending にしない', async () => {
    const previous: MealImageDish[] = [{ name: 'カレー', role: 'main', calories_kcal: 600 }];
    const result = await reconcileDishImages({ previousDishes: previous, nextDishes: unchanged(previous), triggerSource: 'toggle' });
    expect(result.jobs).toEqual([]);
    expect(result.dishes[0]).toMatchObject({ image_url: null, image_source: null, image_status: null, image_subject_hash: null });
  });

  it('商品の献立でない、subject_hash も source も無い料理 (端末から直に保存した手入力の料理) は、料理の中身を変えたら AI の画像のジョブを積む (今までどおり)', async () => {
    const previous: MealImageDish[] = [{ name: 'カレー', role: 'main' }];
    const result = await reconcileDishImages({ previousDishes: previous, nextDishes: [{ name: 'ハヤシライス', role: 'main' }], triggerSource: 'edit' });
    expect(result.jobs).toHaveLength(1);
    expect(result.dishes[0]).toMatchObject({ image_source: 'generated_ai', image_status: 'stale', image_url: null });
  });

  it('AI の画像の料理 (generated_ai) が subject_hash を持たなくても、変えずに保存し直したら hash を前回の中身から求めて同じ料理とみなす', async () => {
    const ready: MealImageDish[] = [{ ...CURRY, image_source: 'generated_ai', image_status: 'ready', image_url: 'https://example.com/ai.png' }];
    const kept = await reconcileDishImages({ previousDishes: ready, nextDishes: unchanged(ready), triggerSource: 'toggle' });
    expect(kept.jobs).toEqual([]);
    expect(kept.dishes[0]).toMatchObject({ image_url: 'https://example.com/ai.png', image_status: 'ready' });

    // 積み直しが要る AI の画像の料理は needsImageRetry どおり積み直す
    const failed: MealImageDish[] = [{ ...CURRY, image_source: 'generated_ai', image_status: 'failed', image_url: null }];
    const retried = await reconcileDishImages({ previousDishes: failed, nextDishes: unchanged(failed), triggerSource: 'toggle' });
    expect(retried.jobs).toHaveLength(1);
    expect(retried.dishes[0]).toMatchObject({ image_status: 'pending', image_source: 'generated_ai' });
  });

  it('isPreservedDishImage / isAiImagePipelineDish の境界', () => {
    expect(isPreservedDishImage({ image_source: 'meal_photo' })).toBe(true);
    expect(isPreservedDishImage({ image_source: 'catalog' })).toBe(true);
    expect(isPreservedDishImage({ image_source: 'manual_override' })).toBe(true);
    expect(isPreservedDishImage({ image_source: 'none' })).toBe(true);
    expect(isPreservedDishImage({ image_url: 'https://example.com/x.jpg' })).toBe(true);
    expect(isPreservedDishImage({ image_source: 'generated_ai', image_url: 'https://example.com/x.jpg' })).toBe(false);
    expect(isPreservedDishImage({})).toBe(false);

    expect(isAiImagePipelineDish({ image_subject_hash: 'h' })).toBe(true);
    expect(isAiImagePipelineDish({ image_source: 'generated_ai' })).toBe(true);
    expect(isAiImagePipelineDish({ image_status: 'pending' })).toBe(false);
  });
});

/**
 * 画像の処理 (process-meal-image-jobs) が、積んだジョブを全部書き終えたあとの献立のカバー。
 * 画像の処理は、ジョブごとに applyGeneratedDishImage (料理を generated_ai・ready・AI の画像にし、カバーの持ち主の決まりでカバーを決める) を使う
 */
function coverAfterWorker(result: { dishes: MealImageDish[]; jobs: MealImageJobSeed[]; mealCoverImageUrl: string | null }): string | null {
  let dishes = result.dishes;
  let cover = result.mealCoverImageUrl;
  for (const job of result.jobs) {
    const applied = applyGeneratedDishImage({
      dishes,
      dishIndex: job.dishIndex,
      imageUrl: `https://example.com/ai-${job.dishIndex}.png`,
      generatedAt: '2026-10-12T00:00:00.000Z',
      currentCoverImageUrl: cover,
    });
    dishes = applied.dishes;
    cover = applied.coverImageUrl;
  }
  return cover;
}

describe('#1487 の整合ゲート R1: 商品の献立の古い商品の料理・写真の複数の料理の献立のカバーを、AI の画像で置き換えない', () => {
  const PHOTO_URL = 'https://example.com/storage/meal-photos/user-1/photo.jpg';
  const PRODUCT_URL = 'https://example.com/catalog/bento.jpg';
  const PRODUCT = {
    id: 'catalog-1',
    sourceId: 'source-1',
    sourceCode: 'store',
    brandName: 'ブランド',
    name: '幕の内弁当',
    categoryCode: null,
    description: null,
    imageUrl: PRODUCT_URL,
    canonicalUrl: 'https://example.com/catalog/bento',
    priceYen: 500,
    caloriesKcal: 650,
    proteinG: 20,
    fatG: 18,
    carbsG: 90,
    sodiumG: 2.5,
    fiberG: 3,
    sugarG: 5,
    availabilityStatus: 'available',
  };
  /** origin/main の buildCatalogMealFields・端末の保存が作った商品の料理 (画像の項目なし。画像は献立のカバーだけ) */
  const LEGACY_CATALOG_DISH: MealImageDish = { name: '幕の内弁当', role: 'main', calories_kcal: 650, protein_g: 20 };

  /** 以前の reconcileDishImages が、古い商品の料理を「料理が変わった」とみなして書き換えた形 (ジョブは積めず、AI の画像はできていない) */
  async function rewrittenLegacyCatalogDish(): Promise<MealImageDish> {
    return {
      ...LEGACY_CATALOG_DISH,
      image_subject_hash: await buildDishImageSubjectHash(LEGACY_CATALOG_DISH, 0),
      image_source: 'generated_ai',
      image_status: 'stale',
      image_url: null,
      image_generated_at: null,
      image_error: null,
    };
  }

  const unchanged = (dishes: MealImageDish[]): MealImageDish[] => dishes.map((dish) => ({ ...dish }));

  it.each([
    ['画像の項目の無い古い商品の料理', async () => [LEGACY_CATALOG_DISH]],
    ['以前の保存し直しで generated_ai・画像なしに書き換わった商品の料理', async () => [await rewrittenLegacyCatalogDish()]],
  ])('商品の献立の%s: 変えない・名前を変える・AI が別の料理を送るのどれでも積まず、商品の料理として保存し、カバーは商品の画像のまま', async (_label, build) => {
    const previous = await build();
    for (const next of [unchanged(previous), [{ ...previous[0], name: '幕の内弁当(大盛り)' }], [{ name: 'のり弁当', role: 'main' }]]) {
      const result = await reconcileDishImages({
        previousDishes: previous,
        nextDishes: next,
        triggerSource: 'edit',
        fallbackMealImageUrl: PRODUCT_URL,
        previousMealIsCatalog: true,
      });
      expect(result.jobs).toEqual([]);
      expect(result.dishes[0]).toMatchObject({
        name: next[0].name,
        image_url: null,
        image_source: 'catalog',
        image_status: null,
        image_subject_hash: null,
      });
      expect(result.mealCoverImageUrl).toBe(PRODUCT_URL);
      expect(coverAfterWorker(result)).toBe(PRODUCT_URL);
    }
  });

  it('商品の献立の古い商品の料理に料理を足しても、足した料理に積まず (状態なし)、カバーは商品の画像のまま', async () => {
    const result = await reconcileDishImages({
      previousDishes: [LEGACY_CATALOG_DISH],
      nextDishes: [{ ...LEGACY_CATALOG_DISH }, { name: '味噌汁', role: 'soup' }],
      triggerSource: 'edit',
      fallbackMealImageUrl: PRODUCT_URL,
      previousMealIsCatalog: true,
    });
    expect(result.jobs).toEqual([]);
    expect(result.dishes[1]).toMatchObject({ name: '味噌汁', image_url: null, image_source: null, image_status: null, image_subject_hash: null });
    expect(coverAfterWorker(result)).toBe(PRODUCT_URL);
  });

  it('前提との対比: 商品の献立と分からなければ (previousMealIsCatalog なし)、同じ料理の名前を変えると積む。それでもカバーは商品の画像のまま (カバーの持ち主の決まり)', async () => {
    const result = await reconcileDishImages({
      previousDishes: [LEGACY_CATALOG_DISH],
      nextDishes: [{ ...LEGACY_CATALOG_DISH, name: '幕の内弁当(大盛り)' }],
      triggerSource: 'edit',
      fallbackMealImageUrl: PRODUCT_URL,
    });
    expect(result.jobs).toHaveLength(1);
    // 以前は画像の処理のあとカバーが AI の画像 (ai-0) になっていた。商品の画像はどの AI の料理の画像とも一致しないので、置き換えない
    expect(coverAfterWorker(result)).toBe(PRODUCT_URL);
  });

  it.each([
    ['写真の料理 (複数) に料理を 1 品足す', () => {
      const previous = buildPhotoDishList([{ name: '親子丼', role: 'main' }, { name: '味噌汁', role: 'soup' }], PHOTO_URL);
      return { previous, next: [...unchanged(previous), { name: 'お新香', role: 'side' }], cover: PHOTO_URL, addedIndexes: [2] };
    }],
    ['写真の料理 (複数) に料理を 2 品足す', () => {
      const previous = buildPhotoDishList([{ name: '親子丼', role: 'main' }, { name: '味噌汁', role: 'soup' }], PHOTO_URL);
      return { previous, next: [...unchanged(previous), { name: 'お新香', role: 'side' }, { name: 'みかん', role: 'dessert' }], cover: PHOTO_URL, addedIndexes: [2, 3] };
    }],
    ['画像の無い商品の料理 (catalog・画像なし) の献立に料理を足す (献立のカバーは手で付けた画像)', () => {
      const previous: MealImageDish[] = [{ name: '幕の内弁当', role: 'main', image_source: 'catalog', image_url: null, image_status: null }];
      return { previous, next: [...unchanged(previous), { name: '味噌汁', role: 'soup' }], cover: 'https://example.com/manual-cover.jpg', addedIndexes: [1] };
    }],
  ])('%s: 足した料理に積まず (状態なし・hash なし)、写真の料理はそのまま、画像の処理のあともカバーが変わらない', async (_label, build) => {
    const { previous, next, cover, addedIndexes } = build();
    const result = await reconcileDishImages({ previousDishes: previous, nextDishes: next, triggerSource: 'edit', fallbackMealImageUrl: cover });

    expect(result.jobs).toEqual([]);
    previous.forEach((dish, index) => {
      expect(result.dishes[index]).toMatchObject({ image_url: dish.image_url ?? null, image_source: dish.image_source, image_status: dish.image_status ?? null });
    });
    for (const index of addedIndexes) {
      expect(result.dishes[index]).toMatchObject({ image_url: null, image_source: null, image_status: null, image_subject_hash: null, image_error: null });
    }
    expect(result.mealCoverImageUrl).toBe(cover);
    expect(coverAfterWorker(result)).toBe(cover);

    // 足した料理を変えずにもう一度保存し直しても (完了の切り替え)、積まない
    const again = await reconcileDishImages({ previousDishes: result.dishes, nextDishes: unchanged(result.dishes), triggerSource: 'toggle', fallbackMealImageUrl: cover });
    expect(again.jobs).toEqual([]);
    expect(coverAfterWorker(again)).toBe(cover);
  });

  it('写真の料理 (複数) の献立の、前回 AI の画像の積み直し待ちの料理 (generated_ai・failed) を変えずに保存し直しても、積まず前回の状態を写す', async () => {
    const photos = buildPhotoDishList([{ name: '親子丼', role: 'main' }, { name: '味噌汁', role: 'soup' }], PHOTO_URL);
    const waiting: MealImageDish = {
      ...SALAD,
      image_subject_hash: await buildDishImageSubjectHash(SALAD, 2),
      image_source: 'generated_ai',
      image_status: 'failed',
      image_error: 'skipped_ai_limit',
      image_url: null,
    };
    const previous = [...photos, waiting];
    const result = await reconcileDishImages({ previousDishes: previous, nextDishes: unchanged(previous), triggerSource: 'toggle', fallbackMealImageUrl: PHOTO_URL });
    expect(result.jobs).toEqual([]);
    expect(result.dishes[2]).toMatchObject({
      image_subject_hash: waiting.image_subject_hash,
      image_source: 'generated_ai',
      image_status: 'failed',
      image_error: 'skipped_ai_limit',
      image_url: null,
    });
    expect(coverAfterWorker(result)).toBe(PHOTO_URL);
  });

  it('写真の料理 (1 つ・料理に写真あり・主菜) に料理を足したときは、足した料理は主菜でないので積まず、画像の無い状態にする (billing/03 Q-16。画像の処理のあともカバーは写真の料理の写真)', async () => {
    const previous = buildPhotoDishList([{ name: '親子丼', role: 'main' }], PHOTO_URL);
    const result = await reconcileDishImages({ previousDishes: previous, nextDishes: [...unchanged(previous), { name: '味噌汁', role: 'soup' }], triggerSource: 'edit', fallbackMealImageUrl: PHOTO_URL });
    expect(result.jobs).toEqual([]);
    expect(result.dishes[1]).toMatchObject({ image_url: null, image_source: null, image_status: null, image_subject_hash: null });
    expect(coverAfterWorker(result)).toBe(PHOTO_URL);
  });

  it('商品の料理 (catalog・商品の画像あり・主菜) に料理を足したときは、足した料理は主菜でないので積まず、画像の無い状態にする (billing/03 Q-16。カバーは商品の料理の画像)', async () => {
    const { buildCatalogMealFields } = await import('../lib/catalog-products');
    const fields = buildCatalogMealFields(PRODUCT);
    const previous = fields.dishes as MealImageDish[];
    const result = await reconcileDishImages({
      previousDishes: previous,
      nextDishes: [...unchanged(previous), { name: '味噌汁', role: 'soup' }],
      triggerSource: 'edit',
      fallbackMealImageUrl: fields.image_url,
      previousMealIsCatalog: isCatalogProductMeal(fields),
    });
    expect(result.jobs).toEqual([]);
    expect(result.dishes[1]).toMatchObject({ image_url: null, image_source: null, image_status: null, image_subject_hash: null });
    expect(coverAfterWorker(result)).toBe(PRODUCT_URL);
  });

  it('AI の画像の献立 (写真・商品の料理なし) は、カバーがあっても、料理を変えれば今までどおり積む (画像の処理のあと新しい AI の画像がカバー)', async () => {
    const previous: MealImageDish[] = [
      { ...CURRY, image_subject_hash: await buildDishImageSubjectHash(CURRY, 0), image_source: 'generated_ai', image_status: 'ready', image_url: 'https://example.com/old-ai.png' },
    ];
    const result = await reconcileDishImages({ previousDishes: previous, nextDishes: [{ name: 'ハヤシライス', role: 'main' }], triggerSource: 'edit', fallbackMealImageUrl: 'https://example.com/old-ai.png' });
    expect(result.jobs).toHaveLength(1);
    expect(coverAfterWorker(result)).toBe('https://example.com/ai-0.png');
  });

  it('isCatalogProductMeal: catalog_product_id か source_type (buildCatalogMealFields が書く値) で商品の献立と分かる', async () => {
    const { buildCatalogMealFields } = await import('../lib/catalog-products');
    expect(buildCatalogMealFields(PRODUCT).source_type).toBe(CATALOG_PRODUCT_MEAL_SOURCE_TYPE);
    expect(isCatalogProductMeal(buildCatalogMealFields(PRODUCT))).toBe(true);
    expect(isCatalogProductMeal({ catalog_product_id: 'catalog-1', source_type: 'manual' })).toBe(true);
    expect(isCatalogProductMeal({ catalog_product_id: null, source_type: 'catalog_product' })).toBe(true);
    expect(isCatalogProductMeal({ catalog_product_id: null, source_type: 'manual' })).toBe(false);
    expect(isCatalogProductMeal(null)).toBe(false);
  });

  it('asCatalogMealDish: 商品の献立の先頭の、自分の画像が無く source が未設定か generated_ai の料理だけを商品の料理として読む', async () => {
    const asCatalog = { image_source: 'catalog', image_status: null, image_subject_hash: null, image_error: null, image_generated_at: null };
    expect(asCatalogMealDish(LEGACY_CATALOG_DISH, 0, true)).toMatchObject(asCatalog);
    expect(asCatalogMealDish(await rewrittenLegacyCatalogDish(), 0, true)).toMatchObject(asCatalog);
    // 商品の献立でない・先頭でない・自分の画像がある・写真・手の画像の料理は変えない
    expect(asCatalogMealDish(LEGACY_CATALOG_DISH, 0, false)).toBe(LEGACY_CATALOG_DISH);
    expect(asCatalogMealDish(LEGACY_CATALOG_DISH, 1, true)).toBe(LEGACY_CATALOG_DISH);
    const withImage: MealImageDish = { ...LEGACY_CATALOG_DISH, image_source: 'generated_ai', image_url: 'https://example.com/ai.png' };
    expect(asCatalogMealDish(withImage, 0, true)).toBe(withImage);
    const photo: MealImageDish = { ...LEGACY_CATALOG_DISH, image_source: 'meal_photo', image_status: 'stale' };
    expect(asCatalogMealDish(photo, 0, true)).toBe(photo);
  });
});


describe('billing/03 §8.8: 料理画像のプランの見送り (skipped_plan) とプランの門', () => {
  it('mealImageSkipReasonOf returns plan for planLocked denials, ai_limit for other denials and rate_limit for null / allowed; MEAL_IMAGE_SKIPPED_ERRORS.plan is skipped_plan and isMealImagePlanSkippedError matches only it', () => {
    expect(mealImageSkipReasonOf({ ...AI_USAGE_DENIED, cappedFeature: 'meal_image_auto', planLocked: true })).toBe('plan');
    expect(mealImageSkipReasonOf(AI_USAGE_DENIED)).toBe('ai_limit');
    expect(mealImageSkipReasonOf({ ...AI_USAGE_DENIED, safetyCap: true })).toBe('ai_limit');
    expect(mealImageSkipReasonOf(null)).toBe('rate_limit');
    expect(mealImageSkipReasonOf(AI_USAGE_ALLOWED)).toBe('rate_limit');
    expect(MEAL_IMAGE_SKIPPED_ERRORS).toEqual({ ai_limit: 'skipped_ai_limit', rate_limit: 'skipped_rate_limit', plan: 'skipped_plan' });
    expect(isMealImagePlanSkippedError('skipped_plan')).toBe(true);
    for (const other of ['skipped_ai_limit', 'skipped_rate_limit', 'enqueue_failed', 'AI_CONSENT_REQUIRED', null, undefined, 0]) {
      expect(isMealImagePlanSkippedError(other), String(other)).toBe(false);
    }
    // 見送り (3 つの理由) はどれも isMealImageSkippedError
    expect(Object.values(MEAL_IMAGE_SKIPPED_ERRORS).every((value) => isMealImageSkippedError(value))).toBe(true);
    // markDishImagesSkipped は plan の理由を skipped_plan で書く
    const [dish] = markDishImagesSkipped([{ ...CURRY, image_source: 'generated_ai', image_status: 'pending' }], [seed(0)], 'plan');
    expect(dish).toMatchObject({ image_status: 'failed', image_error: 'skipped_plan' });
  });

  it('mealImageJobPlanDecision returns locked only for a cap of 0 and allowed for null, a positive cap or an unreadable value', () => {
    expect(mealImageJobPlanDecision(0)).toBe('locked');
    for (const cap of [null, undefined, 1, 20, '0', -1, Number.NaN, {}, 'x']) {
      expect(mealImageJobPlanDecision(cap), String(cap)).toBe('allowed');
    }
  });
});

describe('billing/03 Q-16: 自動の料理画像は献立の主菜の 1 品だけ', () => {
  const MAIN = { name: '鮭の塩焼き', role: 'main', ingredients: ['鮭'] };
  const SIDE = { name: 'おひたし', role: 'side', ingredients: ['ほうれん草'] };
  const SOUP = { name: '味噌汁', role: 'soup', ingredients: ['豆腐'] };
  const RICE = { name: 'ご飯', role: 'rice', ingredients: ['米'] };
  const NO_IMAGE_STATE = { image_url: null, image_source: null, image_status: null, image_subject_hash: null, image_generated_at: null, image_error: null };
  const ready = async (dish: MealImageDish, index: number): Promise<MealImageDish> => ({
    ...dish,
    image_subject_hash: await buildDishImageSubjectHash(dish, index),
    image_source: 'generated_ai',
    image_status: 'ready',
    image_url: `https://example.com/ready-${index}.png`,
  });
  const waiting = async (dish: MealImageDish, index: number, status: 'pending' | 'stale' | 'failed'): Promise<MealImageDish> => ({
    ...dish,
    image_subject_hash: await buildDishImageSubjectHash(dish, index),
    image_source: 'generated_ai',
    image_status: status,
    image_url: null,
  });

  it('autoImageDishIndexOf returns the first dish whose role is main or 主菜 (ignoring surrounding spaces and letter case), AUTO_IMAGE_FALLBACK_DISH_INDEX when no dish is a main dish (rice + soup, other only, no role), and null for no dishes', () => {
    expect([...AUTO_IMAGE_DISH_ROLES]).toEqual(['main', '主菜']);
    expect(AUTO_IMAGE_FALLBACK_DISH_INDEX).toBe(0);
    expect(autoImageDishIndexOf([RICE, SOUP, MAIN, SIDE])).toBe(2);
    expect(autoImageDishIndexOf([SOUP, { role: '主菜' }, MAIN])).toBe(1);
    expect(autoImageDishIndexOf([SOUP, { role: '  MAIN ' }])).toBe(1);
    expect(autoImageDishIndexOf([RICE, SOUP])).toBe(AUTO_IMAGE_FALLBACK_DISH_INDEX);
    expect(autoImageDishIndexOf([{ role: 'other' }, { role: 'other' }])).toBe(AUTO_IMAGE_FALLBACK_DISH_INDEX);
    expect(autoImageDishIndexOf([{ name: 'A' }, { name: 'B', role: null }])).toBe(AUTO_IMAGE_FALLBACK_DISH_INDEX);
    // 主食 (ご飯の役割) は主菜にしない
    expect(autoImageDishIndexOf([{ role: '主食' }, { role: '主菜' }])).toBe(1);
    expect(autoImageDishIndexOf([])).toBeNull();
  });

  it('reconcileDishImages enqueues only the main dish of a new main + side + soup + rice meal and leaves the other dishes with no image state (image_source, image_status, image_subject_hash, image_url, image_generated_at and image_error null), keeping image_prompt and image_model', async () => {
    const result = await reconcileDishImages({ previousDishes: [], nextDishes: [MAIN, SIDE, SOUP, RICE], triggerSource: 'generate' });
    expect(result.jobs.map((job) => job.dishIndex)).toEqual([0]);
    expect(result.dishes[0]).toMatchObject({ image_source: 'generated_ai', image_status: 'pending', image_url: null });
    expect(result.dishes[0].image_subject_hash).toBe(await buildDishImageSubjectHash(MAIN, 0));
    for (const index of [1, 2, 3]) {
      expect(result.dishes[index], String(index)).toMatchObject(NO_IMAGE_STATE);
      expect(typeof result.dishes[index].image_prompt, String(index)).toBe('string');
      expect(result.dishes[index].image_prompt, String(index)).not.toBe('');
      expect(typeof result.dishes[index].image_model, String(index)).toBe('string');
    }
  });

  it('reconcileDishImages enqueues the first dish when no dish is a main dish and the main dish at a later position (side, main), and only the first of two main dishes', async () => {
    const noMain = await reconcileDishImages({ previousDishes: [], nextDishes: [RICE, SOUP], triggerSource: 'generate' });
    expect(noMain.jobs.map((job) => job.dishIndex)).toEqual([0]);
    expect(noMain.dishes[1]).toMatchObject(NO_IMAGE_STATE);
    const laterMain = await reconcileDishImages({ previousDishes: [], nextDishes: [SIDE, MAIN], triggerSource: 'generate' });
    expect(laterMain.jobs.map((job) => job.dishIndex)).toEqual([1]);
    expect(laterMain.dishes[0]).toMatchObject(NO_IMAGE_STATE);
    const twoMains = await reconcileDishImages({ previousDishes: [], nextDishes: [MAIN, { ...CURRY }], triggerSource: 'edit' });
    expect(twoMains.jobs.map((job) => job.dishIndex)).toEqual([0]);
    expect(twoMains.dishes[1]).toMatchObject(NO_IMAGE_STATE);
  });

  it('reconcileDishImages keeps the ready AI image of an unchanged non-main dish without a job, and turns a changed non-main dish into no image state without a job', async () => {
    // 段 B の前に作られた献立: 主菜と副菜の両方が AI の画像を持つ
    const previous = [await ready(MAIN, 0), await ready(SIDE, 1)];
    const same = await reconcileDishImages({ previousDishes: previous, nextDishes: previous.map((dish) => ({ ...dish })), triggerSource: 'toggle' });
    expect(same.jobs).toEqual([]);
    expect(same.dishes[1]).toMatchObject({ image_source: 'generated_ai', image_status: 'ready', image_url: 'https://example.com/ready-1.png' });
    const changed = await reconcileDishImages({
      previousDishes: previous,
      nextDishes: [{ ...previous[0] }, { name: '白和え', role: 'side', ingredients: ['豆腐'] }],
      triggerSource: 'edit',
    });
    expect(changed.jobs).toEqual([]);
    expect(changed.dishes[1]).toMatchObject(NO_IMAGE_STATE);
    expect(changed.dishes[0]).toMatchObject({ image_status: 'ready', image_url: 'https://example.com/ready-0.png' });
  });

  it('reconcileDishImages turns a waiting (pending / stale / failed) non-main dish saved unchanged into no image state without a job, and a second unchanged save keeps it without a job; a non-main-only change of a meal whose main dish is ready yields no job', async () => {
    for (const status of ['pending', 'stale', 'failed'] as const) {
      const previous = [await ready(MAIN, 0), await waiting(SOUP, 1, status)];
      const first = await reconcileDishImages({ previousDishes: previous, nextDishes: previous.map((dish) => ({ ...dish })), triggerSource: 'toggle' });
      expect(first.jobs, status).toEqual([]);
      expect(first.dishes[1], status).toMatchObject(NO_IMAGE_STATE);
      const second = await reconcileDishImages({ previousDishes: first.dishes, nextDishes: first.dishes.map((dish) => ({ ...dish })), triggerSource: 'toggle' });
      expect(second.jobs, status).toEqual([]);
      expect(second.dishes[1], status).toMatchObject(NO_IMAGE_STATE);
    }
    const previous = [await ready(MAIN, 0), await ready(SOUP, 1)];
    const soupOnly = await reconcileDishImages({
      previousDishes: previous,
      nextDishes: [{ ...previous[0] }, { name: 'すまし汁', role: 'soup', ingredients: ['三つ葉'] }],
      triggerSource: 'edit',
    });
    expect(soupOnly.jobs).toEqual([]);
  });

  it('mealCoverRepresentsDish is true for a single-dish meal, the auto image dish and meal_photo / catalog / manual_override dishes, and false for other dishes of a multi-dish meal and for an index without a dish', () => {
    expect(mealCoverRepresentsDish([SOUP], 0)).toBe(true);
    const dishes: MealImageDish[] = [RICE, MAIN, SOUP, { ...SIDE, image_source: 'meal_photo' }, { name: '弁当', image_source: 'catalog' }, { name: 'X', image_source: 'manual_override' }];
    expect(mealCoverRepresentsDish(dishes, 1)).toBe(true);
    expect(mealCoverRepresentsDish(dishes, 3)).toBe(true);
    expect(mealCoverRepresentsDish(dishes, 4)).toBe(true);
    expect(mealCoverRepresentsDish(dishes, 5)).toBe(true);
    expect(mealCoverRepresentsDish(dishes, 0)).toBe(false);
    expect(mealCoverRepresentsDish(dishes, 2)).toBe(false);
    expect(mealCoverRepresentsDish(dishes, 6)).toBe(false);
    // 主菜の無い献立は先頭の料理
    expect(mealCoverRepresentsDish([RICE, SOUP], 0)).toBe(true);
    expect(mealCoverRepresentsDish([RICE, SOUP], 1)).toBe(false);
    expect(mealCoverRepresentsDish([], 0)).toBe(false);
  });

  it('autoImageDishHandoverIndexOf returns the new auto image dish index only when it differs from the previous one, the dish there has no job and no image state (no image_url, image_source or image_subject_hash), and returns null for no previous dishes, an unchanged role order, a seeded index, a ready / pending / meal_photo / catalog / manual_override dish, and treats a non-object previous dish as a dish without a role', async () => {
    // [ご飯 (N), 主菜] → [ご飯 (N)]: 位置 1 → 0
    expect(autoImageDishHandoverIndexOf({ previousDishes: [RICE, MAIN], dishes: [{ ...RICE }], seededDishIndexes: [] })).toBe(0);
    // 前回の料理が無い・位置が移っていない・種がある
    expect(autoImageDishHandoverIndexOf({ previousDishes: [], dishes: [{ ...RICE }], seededDishIndexes: [] })).toBeNull();
    expect(autoImageDishHandoverIndexOf({ previousDishes: [RICE, SOUP], dishes: [{ ...RICE }, { ...SOUP }], seededDishIndexes: [] })).toBeNull();
    expect(autoImageDishHandoverIndexOf({ previousDishes: [RICE, MAIN], dishes: [{ ...RICE }], seededDishIndexes: [0] })).toBeNull();
    // 移った先が画像を持つ・待ち・写真・商品・手の画像
    for (const dish of [
      await ready(RICE, 0),
      await waiting(RICE, 0, 'pending'),
      { ...RICE, image_source: 'meal_photo' as const, image_status: 'stale' as const },
      { ...RICE, image_source: 'catalog' as const, image_url: 'https://example.com/c.png' },
      { ...RICE, image_source: 'manual_override' as const, image_url: 'https://example.com/m.png' },
      { ...RICE, image_subject_hash: 'h' },
    ]) {
      expect(autoImageDishHandoverIndexOf({ previousDishes: [RICE, MAIN], dishes: [dish], seededDishIndexes: [] }), JSON.stringify(dish)).toBeNull();
    }
    // 料理でない前回の値は役割の無い料理として位置を数える ([null, 主菜] → 主菜の位置 1。いまの [ご飯, 汁物] は先頭 0)
    expect(autoImageDishHandoverIndexOf({ previousDishes: [null, MAIN], dishes: [{ ...RICE }, { ...SOUP }], seededDishIndexes: [] })).toBe(0);
    expect(autoImageDishHandoverIndexOf({ previousDishes: [undefined, SOUP], dishes: [{ ...RICE }, { ...SOUP }], seededDishIndexes: [] })).toBeNull();
  });

  it('reconcileDishImages hands the auto image over to an unchanged no-image dish: deleting the ready main of [rice, main] enqueues one pending job for the rice (dish 0), changing the first of two main dishes to side enqueues only the second main (dish 2) and clears the first, and an unchanged re-save of a meal with no-image dishes enqueues nothing', async () => {
    // (1) [ご飯 (画像の無い状態), 主菜 (ready)] から主菜を消す
    const riceMain = [{ ...RICE }, await ready(MAIN, 1)];
    const deleted = await reconcileDishImages({ previousDishes: riceMain, nextDishes: [{ ...RICE }], triggerSource: 'edit', fallbackMealImageUrl: 'https://example.com/ready-1.png' });
    expect(deleted.jobs.map((job) => [job.dishIndex, job.subjectHash])).toEqual([[0, await buildDishImageSubjectHash(RICE, 0)]]);
    expect(deleted.dishes[0]).toMatchObject({ image_source: 'generated_ai', image_status: 'pending', image_url: null });
    // (2) [副菜 (N), 主菜 1 (ready), 主菜 2 (N)] で主菜 1 の役割を副菜にする
    const SECOND_MAIN = { name: 'ハンバーグ', role: 'main', ingredients: ['ひき肉'] };
    const twoMains = [{ ...SIDE }, await ready(MAIN, 1), { ...SECOND_MAIN }];
    const demoted = await reconcileDishImages({
      previousDishes: twoMains,
      nextDishes: [{ ...SIDE }, { ...MAIN, role: 'side', image_subject_hash: twoMains[1].image_subject_hash, image_source: 'generated_ai', image_status: 'ready', image_url: twoMains[1].image_url }, { ...SECOND_MAIN }],
      triggerSource: 'edit',
    });
    expect(demoted.jobs.map((job) => job.dishIndex)).toEqual([2]);
    expect(demoted.dishes[2]).toMatchObject({ image_source: 'generated_ai', image_status: 'pending', image_url: null });
    expect(demoted.dishes[1]).toMatchObject(NO_IMAGE_STATE);
    // (3) 画像の無い料理だけの献立を変えずに保存し直しても積まない
    const noImage = [{ ...RICE }, { ...SOUP }];
    const resaved = await reconcileDishImages({ previousDishes: noImage, nextDishes: noImage.map((dish) => ({ ...dish })), triggerSource: 'toggle' });
    expect(resaved.jobs).toEqual([]);
    expect(resaved.dishes).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'ご飯', image_source: null })]));
    // (4) 献立のカバーが写真の料理のもの (料理ごとの画像の無い写真の料理がある) なら、引き継いだ料理も画像の無い状態に戻して積まない
    const PHOTO_COVER = 'https://example.com/storage/meal-photos/user-1/photo.jpg';
    const withPhoto = [{ ...RICE }, await ready(MAIN, 1), { ...SOUP, image_source: 'meal_photo' as const, image_status: 'stale' as const, image_url: null }];
    const covered = await reconcileDishImages({
      previousDishes: withPhoto,
      nextDishes: [{ ...RICE }, { ...withPhoto[1], role: 'side' }, { ...withPhoto[2] }],
      triggerSource: 'edit',
      fallbackMealImageUrl: PHOTO_COVER,
    });
    expect(covered.jobs).toEqual([]);
    expect(covered.dishes[0]).toMatchObject(NO_IMAGE_STATE);
  });
});
