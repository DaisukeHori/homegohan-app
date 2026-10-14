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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  // weekly_menu_requests は利用者のクライアントでは書かない (#1465)。service role のクライアント (mockAdminFrom) で書く
  throw new Error(`Unexpected table in test: ${table}`);
});

const mockSupabase = {
  auth: { getUser: mockGetUser },
  from: mockFrom,
};

const mockWeeklyInsert = vi.fn((..._args: any[]) => ({
  select: () => ({
    single: mockWeeklyInsertSingle,
  }),
}));
const mockAdminFrom = vi.fn((table: string) => {
  if (table === 'weekly_menu_requests') {
    return { insert: mockWeeklyInsert };
  }
  throw new Error(`Unexpected table in test (admin): ${table}`);
});

// 同意の判定 (T15 / #1154) は「同意済み」に差し替える。同意が無いときに AI へ送らないことは tests/ai-consent-enforcement-routes.test.ts が実際の route を呼んで確かめる
vi.mock('@/lib/ai/consent-guard', () => import('../../../../../tests/helpers/ai-consent-guard-allowed'));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => mockSupabase),
  // AI のキューへの書き込みは service role のクライアント (getAiQueueWriter → getSupabaseAdmin) で行う (#1465)
  getSupabaseAdmin: vi.fn(() => ({ from: mockAdminFrom })),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 })),
  rateLimitExceededResponse: vi.fn(),
}));

// #1148: エンジンの切り替えは feature_flags (isFeatureEnabled)。既定は v4 (OFF) で、v5 を確かめるテストだけ ON にする
const mockIsFeatureEnabled = vi.fn(async (_key: string, _userId?: string) => false);
vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: (key: string, userId?: string) => mockIsFeatureEnabled(key, userId),
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

const mockCallGenerateMenuV5WithRetry = vi.fn(async (..._args: any[]) => ({
  ok: true,
  attempts: 1,
  response: new Response(),
}));
vi.mock('@/lib/generate-menu-v5-retry', () => ({
  callGenerateMenuV5WithRetry: mockCallGenerateMenuV5WithRetry,
}));

const waitUntilPromises: Promise<unknown>[] = [];
// internalError() が使う構造化ログ。変数名がここに渡ることを見る (#1182)。app_logs には書かせない
const mockLoggerError = vi.fn();
vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    withUser: vi.fn().mockReturnThis(),
    error: mockLoggerError,
  })),
  generateRequestId: vi.fn(() => 'req-test'),
}));

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

// 必須の環境変数 (#1182)。Edge Function の呼び出しはモックなので、値はダミー
const TEST_SUPABASE_URL = 'https://example.supabase.co';
const TEST_SERVICE_ROLE_KEY = 'service-role-key-for-test';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsFeatureEnabled.mockImplementation(async () => false);
  waitUntilPromises.length = 0;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', TEST_SUPABASE_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', TEST_SERVICE_ROLE_KEY);
  mockGetUser.mockResolvedValue({ data: { user }, error: null });
  mockUserDailyMealsSingle.mockResolvedValue({ data: { id: dailyMealId, day_date: dayDate }, error: null });
  mockWeeklyInsertSingle.mockResolvedValue({ data: { id: 'request-1' }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    // リクエストの行は service role のクライアントで、本人の user_id で積む (#1465)
    expect(mockAdminFrom).toHaveBeenCalledWith('weekly_menu_requests');
    expect(mockWeeklyInsert.mock.calls[0][0]).toMatchObject({ user_id: user.id });
    expect(mockCallGenerateMenuV4WithRetry).toHaveBeenCalledTimes(1);
    const payload = mockCallGenerateMenuV4WithRetry.mock.calls[0][0].payload;
    expect(payload.targetSlots.map((s: any) => s.mealType).sort()).toEqual(['breakfast', 'dinner', 'lunch']);
    await flushBackground();
  });

  it('#1148: menu_generation_v5_wrapped が OFF なら v4、ON なら v5 の Edge Function を呼ぶ', async () => {
    mockPlannedMealsEq.mockResolvedValue({
      data: [{ id: 'meal-b', meal_type: 'breakfast', is_completed: false }],
      error: null,
    });

    // OFF: v4
    const offRes = await POST(makeRequest({ dailyMealId }));
    expect(offRes.status).toBe(200);
    await flushBackground();
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('menu_generation_v5_wrapped', 'user-1');
    expect(mockCallGenerateMenuV4WithRetry).toHaveBeenCalledTimes(1);
    expect(mockCallGenerateMenuV5WithRetry).not.toHaveBeenCalled();

    // ON: v5
    vi.clearAllMocks();
    waitUntilPromises.length = 0;
    mockGetUser.mockResolvedValue({ data: { user }, error: null });
    mockUserDailyMealsSingle.mockResolvedValue({ data: { id: dailyMealId, day_date: dayDate }, error: null });
    mockPlannedMealsEq.mockResolvedValue({
      data: [{ id: 'meal-b', meal_type: 'breakfast', is_completed: false }],
      error: null,
    });
    mockWeeklyInsertSingle.mockResolvedValue({ data: { id: 'request-2' }, error: null });
    mockIsFeatureEnabled.mockImplementation(async (key: string) => key === 'menu_generation_v5_wrapped');

    const onRes = await POST(makeRequest({ dailyMealId }));
    expect(onRes.status).toBe(200);
    await flushBackground();
    expect(mockCallGenerateMenuV5WithRetry).toHaveBeenCalledTimes(1);
    expect(mockCallGenerateMenuV4WithRetry).not.toHaveBeenCalled();
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

// #1182: 必須の環境変数が欠けているとき、weekly_menu_requests を作る「前」に、汎用の 500 で止める。
// 本文には変数名を出さず (#1172)、変数名は構造化ログ (db-logger) にだけ渡す。
// 以前は `process.env.X!` を行を作った「後」に読んでいたため、欠けていると undefined の URL を呼びに行っていた。
describe('POST /api/ai/menu/day/regenerate — 必須の環境変数 (#1182)', () => {
  beforeEach(() => {
    mockPlannedMealsEq.mockResolvedValue({
      data: [{ id: 'meal-b', meal_type: 'breakfast', is_completed: false }],
      error: null,
    });
  });

  it('設定されていれば、その値をそのまま Edge Function の呼び出しに渡す', async () => {
    const res = await POST(makeRequest({ dailyMealId }));
    expect(res.status).toBe(200);
    await flushBackground();

    expect(mockCallGenerateMenuV4WithRetry).toHaveBeenCalledTimes(1);
    expect(mockCallGenerateMenuV4WithRetry.mock.calls[0][0]).toMatchObject({
      supabaseUrl: TEST_SUPABASE_URL,
      serviceRoleKey: TEST_SERVICE_ROLE_KEY,
    });
  });

  it.each(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])(
    '%s が未設定なら、リクエストを作る前に、汎用の 500 で止める (本文に変数名なし・ログに変数名あり)',
    async (name) => {
      vi.stubEnv(name, undefined);

      const res = await POST(makeRequest({ dailyMealId }));
      const text = await res.text();

      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
      expect(text).not.toContain(name);
      expect(mockLoggerError).toHaveBeenCalledTimes(1);
      expect(mockLoggerError.mock.calls[0][1]).toMatchObject({ name: 'MissingEnvError', envName: name });
      expect(mockWeeklyInsertSingle).not.toHaveBeenCalled();
      expect(mockCallGenerateMenuV4WithRetry).not.toHaveBeenCalled();
    },
  );
});
