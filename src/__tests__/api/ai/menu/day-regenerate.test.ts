/**
 * src/__tests__/api/ai/menu/day-regenerate.test.ts
 *
 * #1042 (F1a-14): day/regenerate が完食済み(is_completed)の食事も上書きし
 * 摂取実績・ストリークが遡って壊れる問題の修正確認。
 *
 * - 完食済みの食事は targetSlots から除外され、上書きされないこと
 * - 明示的に includeCompleted:true を指定した場合のみ上書き対象に含まれること
 * - 全食事が完食済みの場合は Edge Function を呼ばずスキップを返すこと
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();
const mockUserDailyMealsSingle = vi.fn();
const mockPlannedMealsEq = vi.fn();
const mockWeeklyInsertSingle = vi.fn();

const mockFrom = vi.fn((table: string) => {
  if (table === 'user_daily_meals') {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: mockUserDailyMealsSingle,
          }),
        }),
      }),
    };
  }
  if (table === 'planned_meals') {
    return {
      select: () => ({
        eq: mockPlannedMealsEq,
      }),
    };
  }
  if (table === 'weekly_menu_requests') {
    return {
      insert: () => ({
        select: () => ({
          single: mockWeeklyInsertSingle,
        }),
      }),
    };
  }
  throw new Error(`Unexpected table in test: ${table}`);
});

const mockSupabase = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => mockSupabase),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 })),
  rateLimitExceededResponse: vi.fn(),
}));

vi.mock('@/lib/menu-generation-feature-flags', () => ({
  loadFeatureFlags: vi.fn(async () => ({ menu_generation_v5_wrapped: false })),
}));

const mockCallGenerateMenuV4WithRetry = vi.fn(async (..._args: any[]) => ({
  ok: true,
  attempts: 1,
  response: new Response(),
}));
const mockMarkWeeklyMenuRequestFailed = vi.fn(async (..._args: any[]) => {});

vi.mock('@/lib/generate-menu-v4-retry', () => ({
  callGenerateMenuV4WithRetry: mockCallGenerateMenuV4WithRetry,
  markWeeklyMenuRequestFailed: mockMarkWeeklyMenuRequestFailed,
}));

vi.mock('@/lib/generate-menu-v5-retry', () => ({
  callGenerateMenuV5WithRetry: vi.fn(async () => ({ ok: true, attempts: 1, response: new Response() })),
}));

const waitUntilPromises: Promise<unknown>[] = [];
vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    waitUntilPromises.push(p);
  }),
}));

const { POST } = await import('@/app/api/ai/menu/day/regenerate/route');

const user = { id: 'user-1' };
const dailyMealId = 'day-1';
const dayDate = '2026-07-10';

const makeRequest = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/ai/menu/day/regenerate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const flushBackground = async () => {
  await Promise.all(waitUntilPromises);
};

beforeEach(() => {
  vi.clearAllMocks();
  waitUntilPromises.length = 0;
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
  mockUserDailyMealsSingle.mockResolvedValue({ data: { id: dailyMealId, day_date: dayDate }, error: null });
  mockWeeklyInsertSingle.mockResolvedValue({ data: { id: 'request-1' }, error: null });
});

describe('POST /api/ai/menu/day/regenerate', () => {
  it('未完食のみなら3スロット全てが再生成対象になる', async () => {
    mockPlannedMealsEq.mockResolvedValue({
      data: [
        { id: 'meal-b', meal_type: 'breakfast', is_completed: false },
        { id: 'meal-l', meal_type: 'lunch', is_completed: false },
        { id: 'meal-d', meal_type: 'dinner', is_completed: false },
      ],
      error: null,
    });

    const res = await POST(makeRequest({ dailyMealId }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.mealsCount).toBe(3);
    expect(mockCallGenerateMenuV4WithRetry).toHaveBeenCalledTimes(1);
    const payload = mockCallGenerateMenuV4WithRetry.mock.calls[0][0].payload;
    expect(payload.targetSlots.map((s: any) => s.mealType).sort()).toEqual(['breakfast', 'dinner', 'lunch']);
    await flushBackground();
  });

  it('完食済みの朝食は除外され、上書き対象から外れる (includeCompleted未指定)', async () => {
    mockPlannedMealsEq.mockResolvedValue({
      data: [
        { id: 'meal-b', meal_type: 'breakfast', is_completed: true },
        { id: 'meal-l', meal_type: 'lunch', is_completed: false },
        { id: 'meal-d', meal_type: 'dinner', is_completed: false },
      ],
      error: null,
    });

    const res = await POST(makeRequest({ dailyMealId }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.mealsCount).toBe(2);
    const payload = mockCallGenerateMenuV4WithRetry.mock.calls[0][0].payload;
    const mealTypes = payload.targetSlots.map((s: any) => s.mealType);
    expect(mealTypes).not.toContain('breakfast');
    expect(mealTypes.sort()).toEqual(['dinner', 'lunch']);
    await flushBackground();
  });

  it('全食事が完食済みなら Edge Function を呼ばずスキップを返す', async () => {
    mockPlannedMealsEq.mockResolvedValue({
      data: [
        { id: 'meal-b', meal_type: 'breakfast', is_completed: true },
        { id: 'meal-l', meal_type: 'lunch', is_completed: true },
        { id: 'meal-d', meal_type: 'dinner', is_completed: true },
      ],
      error: null,
    });

    const res = await POST(makeRequest({ dailyMealId }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe('skipped');
    expect(json.mealsCount).toBe(0);
    expect(mockCallGenerateMenuV4WithRetry).not.toHaveBeenCalled();
    // weekly_menu_requests への insert も発生しないこと（無駄なリクエスト行を作らない）
    expect(mockWeeklyInsertSingle).not.toHaveBeenCalled();
  });

  it('includeCompleted:true を明示指定すれば完食済みも上書き対象に含まれる', async () => {
    mockPlannedMealsEq.mockResolvedValue({
      data: [
        { id: 'meal-b', meal_type: 'breakfast', is_completed: true },
        { id: 'meal-l', meal_type: 'lunch', is_completed: false },
        { id: 'meal-d', meal_type: 'dinner', is_completed: false },
      ],
      error: null,
    });

    const res = await POST(makeRequest({ dailyMealId, includeCompleted: true }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.mealsCount).toBe(3);
    const payload = mockCallGenerateMenuV4WithRetry.mock.calls[0][0].payload;
    expect(payload.targetSlots.map((s: any) => s.mealType).sort()).toEqual(['breakfast', 'dinner', 'lunch']);
    await flushBackground();
  });
});
