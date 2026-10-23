/**
 * #1365 段 1: 写真から栄養を推定する (POST /api/ai/nutrition の imageUrl) は、写真のバケットの URL を
 * 公開 URL のまま AI 事業者に渡さず、本人の写真に署名した URL を渡す。他人の写真の URL は 403 PHOTO_NOT_READABLE で、
 * AI を呼ばず回数も数えない。imageUrl が文字列でなければ 400。保存する image_url は送られた URL のまま。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCompletion: vi.fn(),
  consumeAiUsage: vi.fn(),
  cancelPendingMealImageJobs: vi.fn(),
  signCalls: [] as Array<{ bucket: string; paths: string[] }>,
  updates: [] as Array<Record<string, unknown>>,
}));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MEAL_ID = '33333333-3333-4333-8333-333333333333';
const BASE = 'https://proj.supabase.co/storage/v1/object';

/** 本人の献立の行 (所有権の確認) と、栄養の保存 (update) だけを受ける利用者の client */
function userClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from: (table: string) => {
      if (table !== 'planned_meals') throw new Error(`unexpected table ${table}`);
      const builder = {
        select: () => builder,
        eq: () => builder,
        single: async () => ({
          data: { id: MEAL_ID, dishes: [], is_simple: false, user_daily_meals: { user_id: USER } },
          error: null,
        }),
        update: (payload: Record<string, unknown>) => {
          mocks.updates.push(payload);
          return { eq: async () => ({ error: null }) };
        },
      };
      return builder;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => userClient(),
  getSupabaseAdmin: () => ({
    from: () => {
      throw new Error('planned_meals should not be read for these paths (generated/ ではない)');
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrls: async (paths: string[]) => {
          mocks.signCalls.push({ bucket, paths });
          return { data: paths.map((path) => ({ path, error: null, signedUrl: `${BASE}/sign/${bucket}/${path}?token=t` })), error: null };
        },
      }),
    },
  }),
}));

vi.mock('@/lib/ai/consent-guard', () => ({ requireAiConsent: async () => null }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ success: true }),
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/plan/entitlements', () => ({
  aiDailyLimitResponse: vi.fn(),
  consumeAiUsage: (...args: unknown[]) => mocks.consumeAiUsage(...args),
}));
vi.mock('@/lib/ai/fast-llm', () => ({
  getFastLLMClient: () => ({ chat: { completions: { create: (...args: unknown[]) => mocks.createCompletion(...args) } } }),
  getFastLLMModel: () => 'test-model',
}));
vi.mock('@/lib/ai/ai-queue-writer', () => ({ getAiQueueWriter: () => ({}) }));
vi.mock('../../../lib/meal-image-jobs', () => ({
  cancelPendingMealImageJobs: (...args: unknown[]) => mocks.cancelPendingMealImageJobs(...args),
}));

import { POST } from '@/app/api/ai/nutrition/route';

function request(body: unknown): Request {
  return new Request('http://localhost/api/ai/nutrition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** OpenAI に渡した image_url.url */
function imageUrlSentToAi(): unknown {
  const [params] = mocks.createCompletion.mock.calls[0] as [
    { messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> },
  ];
  return params.messages[0].content.find((part) => part.type === 'image_url')?.image_url?.url;
}

describe('POST /api/ai/nutrition (写真の URL)', () => {
  beforeEach(() => {
    mocks.createCompletion.mockReset();
    mocks.consumeAiUsage.mockReset();
    mocks.cancelPendingMealImageJobs.mockReset();
    mocks.signCalls.length = 0;
    mocks.updates.length = 0;
    mocks.consumeAiUsage.mockResolvedValue({ allowed: true });
    mocks.cancelPendingMealImageJobs.mockResolvedValue(undefined);
    mocks.createCompletion.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ calories_kcal: 500, dishes: [{ name: 'カレー', role: 'main' }] }) } }],
    });
  });

  it.each(['meal_photos', 'fridge-images'])(
    '本人の写真 (%s) は、署名した URL を AI に渡す (公開 URL は渡さない)。保存する image_url は送られた URL のまま',
    async (bucket) => {
      const own = `${BASE}/public/${bucket}/${USER}/meal.jpg`;
      const res = await POST(request({ plannedMealId: MEAL_ID, imageUrl: own }));
      expect(res.status).toBe(200);
      expect(imageUrlSentToAi()).toBe(`${BASE}/sign/${bucket}/${USER}/meal.jpg?token=t`);
      expect(mocks.signCalls).toEqual([{ bucket, paths: [`${USER}/meal.jpg`] }]);
      expect(mocks.consumeAiUsage).toHaveBeenCalledTimes(1);
      expect(mocks.updates).toHaveLength(1);
      expect(mocks.updates[0].image_url).toBe(own);
    },
  );

  it('他人の写真の URL は 403 PHOTO_NOT_READABLE で、署名しない・AI に渡さない・回数も数えない・保存しない', async () => {
    const others = `${BASE}/public/meal_photos/${OTHER}/meal.jpg`;
    const res = await POST(request({ plannedMealId: MEAL_ID, imageUrl: others }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'PHOTO_NOT_READABLE' });
    expect(mocks.createCompletion).not.toHaveBeenCalled();
    expect(mocks.consumeAiUsage).not.toHaveBeenCalled();
    expect(mocks.signCalls).toEqual([]);
    expect(mocks.updates).toEqual([]);
  });

  it('imageUrl が文字列でなければ 400 で、AI を呼ばず回数も数えない', async () => {
    const res = await POST(request({ plannedMealId: MEAL_ID, imageUrl: 12345 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: '写真の指定が正しくありません。写真を選び直してください' });
    expect(mocks.createCompletion).not.toHaveBeenCalled();
    expect(mocks.consumeAiUsage).not.toHaveBeenCalled();
    expect(mocks.signCalls).toEqual([]);
  });

  it('写真のバケット以外の URL は、署名せずそのまま AI に渡す', async () => {
    const external = 'https://example.com/meal.jpg';
    const res = await POST(request({ plannedMealId: MEAL_ID, imageUrl: external }));
    expect(res.status).toBe(200);
    expect(imageUrlSentToAi()).toBe(external);
    expect(mocks.signCalls).toEqual([]);
    expect(mocks.updates[0].image_url).toBe(external);
  });
});
