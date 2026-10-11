// @vitest-environment node
/**
 * #1487 料理画像の見送り・積み直し・数え戻しと、安全弁の 429 の文 (部品の単体テスト)
 *
 *   1. markDishImagesSkipped: ジョブを積まないと決まった料理だけを 'failed' + 見送りの理由にする (ほかの料理は変えない)
 *   2. reconcileDishImages: 同じ料理 (subject_hash が同じ) でも、画像が無く待ち・更新待ち・失敗のままなら積み直す。
 *      画像がある・写真・手で付けた画像は積み直さない
 *   3. enqueueMealImageJobs: 行ごとに insert する (冪等キーの一意な索引は部分索引なので、ON CONFLICT (idempotency_key) は使えない)。
 *      重複 (23505) と失敗を数え、1 行も積めなかったら数えた 1 回を戻す
 *   4. 安全弁 (上限に数えない機能) で止めたときの 429 の本文と文: 回数を出さない固定の文 (Web・モバイル共用)
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
  MEAL_IMAGE_SKIPPED_ERRORS,
  buildDishImageSubjectHash,
  buildMealImageIdempotencyKey,
  isMealImageSkippedError,
  markDishImagesSkipped,
  needsImageRetry,
  reconcileDishImages,
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

/** meal_image_jobs への insert の作り物。行ごとに返す結果を決める */
function makeQueueDb(outcomeOf: (row: Record<string, unknown>, index: number) => { code: string; message: string } | null | 'throw') {
  const inserted: Array<Record<string, unknown>> = [];
  const upsert = vi.fn();
  let calls = 0;
  const from = vi.fn((table: string) => {
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
  return { db: { from } as unknown as SupabaseClient, inserted, upsert, from };
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

    expect(result).toEqual({ inserted: 2, duplicates: 0, failed: 0 });
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

  it('書き込みに失敗して 1 行も積めなかったら、数えた 1 回を戻す', async () => {
    const queue = makeQueueDb(() => PERMISSION_DENIED);
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobSeeds: [seed(0)], usage: AI_USAGE_ALLOWED });

    expect(result).toEqual({ inserted: 0, duplicates: 0, failed: 1 });
    expect(m.refundAiUsage).toHaveBeenCalledTimes(1);
    expect(m.refundAiUsage).toHaveBeenCalledWith('user-1', 'meal_image_auto', AI_USAGE_ALLOWED);
  });

  it('insert が例外を投げても、例外を投げずに失敗として数え、数え戻す', async () => {
    const queue = makeQueueDb(() => 'throw');
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobSeeds: [seed(0)], usage: AI_USAGE_ALLOWED });

    expect(result).toEqual({ inserted: 0, duplicates: 0, failed: 1 });
    expect(m.refundAiUsage).toHaveBeenCalledWith('user-1', 'meal_image_auto', AI_USAGE_ALLOWED);
  });

  it('すべて重複 (同じ料理の待ち・処理中のジョブがある) で 0 件なら、数えた 1 回を戻す', async () => {
    const queue = makeQueueDb(() => UNIQUE_VIOLATION);
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobSeeds: [seed(0), seed(1)], usage: AI_USAGE_ALLOWED });

    expect(result).toEqual({ inserted: 0, duplicates: 2, failed: 0 });
    expect(m.refundAiUsage).toHaveBeenCalledTimes(1);
  });

  it('一部でも積めたら (AI へ送るので) 数え戻さない', async () => {
    const queue = makeQueueDb((_row, index) => (index === 0 ? UNIQUE_VIOLATION : null));
    const result = await enqueueMealImageJobs({ ...base, supabase: queue.db, jobSeeds: [seed(0), seed(1)], usage: AI_USAGE_ALLOWED });

    expect(result).toEqual({ inserted: 1, duplicates: 1, failed: 0 });
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
