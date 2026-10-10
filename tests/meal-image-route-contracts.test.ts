import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock('../src/lib/meal-image-jobs', () => ({
  buildDishImagePayload: vi.fn(),
  enqueueMealImageJobs: vi.fn(),
  triggerMealImageJobProcessing: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

// #1022: 画像生成ジョブの同期トリガーには image カテゴリのレート制限が挿入されているが、
// このテストはジョブ生成・reconcile ロジックの検証が目的のためレート制限自体は常に許可する
// （具体的な mockResolvedValue は resetAllMocks 後の beforeEach で設定する）。
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  rateLimitExceededResponse: vi.fn(),
}));

// #1177: AI 利用回数の記録と、その前の同意の判定 (T15 / #1154) は、DB を呼ぶ境目なので差し替える
// (具体的な戻り値は resetAllMocks 後の beforeEach で設定する)
vi.mock('@/lib/ai/consent-guard', () => ({
  checkUserAiConsent: vi.fn(),
}));
vi.mock('@/lib/plan/entitlements', () => ({
  consumeAiQuota: vi.fn(),
}));

import {
  buildDishImagePayload,
  enqueueMealImageJobs,
  triggerMealImageJobProcessing,
} from '../src/lib/meal-image-jobs';
import { checkRateLimit } from '@/lib/rate-limit';
import { checkUserAiConsent } from '@/lib/ai/consent-guard';
import { consumeAiQuota } from '@/lib/plan/entitlements';
import { PATCH as mealPlansPatch } from '../src/app/api/meal-plans/meals/[id]/route';
import { POST as mealPlansPost } from '../src/app/api/meal-plans/meals/route';

const dishPayloadStub = () => ({
  dishes: [{ name: 'reconciled' }],
  jobs: [
    {
      dishIndex: 0,
      dishName: 'reconciled',
      subjectHash: 'hash-1',
      prompt: 'prompt',
      model: 'gemini',
      triggerSource: 'trigger',
      referenceImageUrls: [],
    },
  ],
  mealCoverImageUrl: 'https://examples.com/dish-cover.png',
});

describe('meal image route contracts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    // #1022: 画像生成ジョブの同期トリガーは image カテゴリのレート制限対象だが、
    // このテストは reconcile ロジックの検証が目的のため常に許可する
    vi.mocked(checkRateLimit).mockResolvedValue({
      success: true,
      limit: 1,
      remaining: 0,
      reset: Date.now() + 60_000,
    });
    vi.mocked(checkUserAiConsent).mockResolvedValue({ allowed: true });
    vi.mocked(consumeAiQuota).mockResolvedValue({ allowed: true, remaining: null });
  });

  it('meal-plans PATCH reconciles dishes and enqueues jobs', async () => {
    const payload = dishPayloadStub();
    vi.mocked(buildDishImagePayload).mockResolvedValueOnce(payload);

    const existingMeal = {
      id: 'meal-1',
      dishes: [{ name: 'existing' }],
      image_url: 'https://examples.com/old-cover.png',
      catalog_product_id: null,
      generation_metadata: null,
      user_daily_meals: { user_id: 'user-1' },
    };
    const selectChain: any = {
      select: vi.fn(() => selectChain),
      eq: vi.fn(() => selectChain),
      single: vi.fn().mockResolvedValue({ data: existingMeal, error: null }),
    };
    const updateSelectSingle = vi.fn().mockResolvedValue({ data: { id: 'meal-1' }, error: null });
    const updateChain: any = {
      eq: vi.fn(() => updateChain),
      select: vi.fn(() => ({ single: updateSelectSingle })),
    };
    const update = vi.fn(() => updateChain);

    mockFrom.mockImplementation((table: string) => {
      if (table === 'planned_meals') {
        return { select: selectChain.select, update };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const response = await mealPlansPatch(
      new Request('http://localhost/api/meal-plans/meals/meal-1', {
        method: 'PATCH',
        headers: { 'x-request-id': 'req-1' },
        body: JSON.stringify({ dishes: [{ name: 'new' }], imageUrl: 'manual-cover' }),
      }),
      { params: { id: 'meal-1' } }
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(buildDishImagePayload)).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerSource: 'nextjs:meal-plans/meals/meal-1:PATCH',
        imageUrlOverride: 'manual-cover',
      })
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        dishes: payload.dishes,
        image_url: payload.mealCoverImageUrl,
      })
    );
    expect(vi.mocked(enqueueMealImageJobs)).toHaveBeenCalledWith(
      expect.objectContaining({
        plannedMealId: 'meal-1',
        jobSeeds: payload.jobs,
        requestId: 'req-1',
      })
    );
    expect(vi.mocked(triggerMealImageJobProcessing)).toHaveBeenCalledWith({
      plannedMealId: 'meal-1',
      limit: payload.jobs.length,
    });
  });

  it('meal-plans POST saves reconciled dishes/cover and enqueues jobs', async () => {
    const payload = dishPayloadStub();
    vi.mocked(buildDishImagePayload).mockResolvedValueOnce(payload);

    const existingSelectChain: any = {
      select: vi.fn(() => existingSelectChain),
      eq: vi.fn(() => existingSelectChain),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const insertSelectSingle = vi.fn().mockResolvedValue({ data: { id: 'meal-2' }, error: null });
    const insert = vi.fn(() => ({
      select: vi.fn(() => ({ single: insertSelectSingle })),
    }));
    let userDailyMealsCalls = 0;

    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_daily_meals') {
        userDailyMealsCalls += 1;
        return userDailyMealsCalls === 1 ? existingSelectChain : { insert };
      }
      if (table === 'planned_meals') return { insert };
      throw new Error(`Unexpected table: ${table}`);
    });

    const response = await mealPlansPost(
      new Request('http://localhost/api/meal-plans/meals', {
        method: 'POST',
        headers: { 'x-request-id': 'req-2' },
        body: JSON.stringify({
          dayDate: '2026-03-18',
          mealType: 'lunch',
          mode: 'cook',
          dishName: '手入力',
          dishes: [{ name: 'new' }],
          imageUrl: 'manual-cover',
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        dishes: payload.dishes,
        image_url: payload.mealCoverImageUrl,
      })
    );
    expect(vi.mocked(enqueueMealImageJobs)).toHaveBeenCalledWith(
      expect.objectContaining({
        plannedMealId: 'meal-2',
        jobSeeds: payload.jobs,
        requestId: 'req-2',
      })
    );
    expect(vi.mocked(triggerMealImageJobProcessing)).toHaveBeenCalledWith({
      plannedMealId: 'meal-2',
      limit: payload.jobs.length,
    });
  });
});

describe('料理画像の生成の AI 利用回数の記録 (#1177): 同意の判定 → 記録 → AI への送信', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    vi.mocked(checkRateLimit).mockResolvedValue({ success: true, limit: 1, remaining: 0, reset: Date.now() + 60_000 });
    vi.mocked(consumeAiQuota).mockResolvedValue({ allowed: true, remaining: null });
    vi.mocked(buildDishImagePayload).mockResolvedValue(dishPayloadStub());
    const existingSelectChain: any = {
      select: vi.fn(() => existingSelectChain),
      eq: vi.fn(() => existingSelectChain),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const insert = vi.fn(() => ({
      select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: { id: 'meal-3' }, error: null }) })),
    }));
    let userDailyMealsCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_daily_meals') {
        userDailyMealsCalls += 1;
        return userDailyMealsCalls === 1 ? existingSelectChain : { insert };
      }
      if (table === 'planned_meals') return { insert };
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  const post = () =>
    mealPlansPost(
      new Request('http://localhost/api/meal-plans/meals', {
        method: 'POST',
        body: JSON.stringify({ dayDate: '2026-03-18', mealType: 'lunch', mode: 'cook', dishName: '手入力', dishes: [{ name: 'new' }] }),
      }),
    );

  it('同意済みなら、同意を判定したあとで image_generation を 1 回数え、ジョブを積む', async () => {
    vi.mocked(checkUserAiConsent).mockResolvedValue({ allowed: true });
    const response = await post();
    expect(response.status).toBe(200);
    expect(vi.mocked(consumeAiQuota)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(consumeAiQuota)).toHaveBeenCalledWith('user-1', 'image_generation');
    expect(vi.mocked(checkUserAiConsent).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(consumeAiQuota).mock.invocationCallOrder[0]);
    expect(vi.mocked(consumeAiQuota).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(enqueueMealImageJobs).mock.invocationCallOrder[0]);
    expect(vi.mocked(enqueueMealImageJobs)).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['未同意', { allowed: false as const, reason: 'not_consented' as const }],
    ['同意の判定に失敗', { allowed: false as const, reason: 'check_failed' as const }],
  ])('%s なら数えない (AI へ送らずに止めるのはジョブを処理する Edge Function)。ジョブを積むかどうかは変えない', async (_label, decision) => {
    vi.mocked(checkUserAiConsent).mockResolvedValue(decision);
    const response = await post();
    expect(response.status).toBe(200);
    expect(vi.mocked(consumeAiQuota)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueMealImageJobs)).toHaveBeenCalledTimes(1);
  });

  it('上限を超えていたら (いまは全プラン無制限なので起きない)、画像の生成だけを見送る', async () => {
    vi.mocked(checkUserAiConsent).mockResolvedValue({ allowed: true });
    vi.mocked(consumeAiQuota).mockResolvedValue({ allowed: false, remaining: 0, limitKind: 'daily', limit: 10 });
    const response = await post();
    expect(response.status).toBe(200);
    expect(vi.mocked(enqueueMealImageJobs)).not.toHaveBeenCalled();
    expect((await response.json()).imageGenerationThrottled).toBe(true);
  });
});
