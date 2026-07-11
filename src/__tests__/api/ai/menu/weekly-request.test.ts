/**
 * src/__tests__/api/ai/menu/weekly-request.test.ts
 *
 * #1042 (F1a-03): weekly/request が生成前に既存献立を物理削除しロールバックなし
 * だった問題の修正確認（失敗注入テスト）。
 *
 * - 既存献立の削除前にスナップショットを取得し weekly_menu_requests.generated_data に退避すること
 * - Edge Function 呼び出しが失敗した場合、スナップショットからのロールバック復元
 *   (restorePlannedMealsSnapshot) が実行されること
 * - Edge Function が成功した場合はロールバックを実行しないこと
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetUser = vi.fn();

// user_daily_meals.select('id').eq().eq().maybeSingle() のキュー（日毎に1回ずつ呼ばれる）
const userDailyMealsQueue: Array<{ data: any; error: any }> = [];
const mockUserDailyMealsMaybeSingle = vi.fn(() =>
  Promise.resolve(userDailyMealsQueue.shift() ?? { data: null, error: null }),
);

// planned_meals.select('*').eq('daily_meal_id', ...) のキュー（スナップショット取得）
const plannedMealsSelectQueue: Array<{ data: any; error: any }> = [];
const mockPlannedMealsSelectEq = vi.fn(() =>
  Promise.resolve(plannedMealsSelectQueue.shift() ?? { data: [], error: null }),
);

const mockPlannedMealsDeleteEq = vi.fn(() => Promise.resolve({ data: null, error: null }));

const mockWeeklyInsertSingle = vi.fn();
const mockWeeklyInsertCall = vi.fn((..._args: any[]) => ({
  select: () => ({ single: mockWeeklyInsertSingle }),
}));
const mockWeeklyUpdateEq = vi.fn(() => Promise.resolve({ data: null, error: null }));

const mockFrom = vi.fn((table: string) => {
  if (table === 'user_daily_meals') {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: mockUserDailyMealsMaybeSingle,
          }),
        }),
      }),
    };
  }
  if (table === 'planned_meals') {
    return {
      select: () => ({
        eq: mockPlannedMealsSelectEq,
      }),
      delete: () => ({
        eq: mockPlannedMealsDeleteEq,
      }),
    };
  }
  if (table === 'weekly_menu_requests') {
    return {
      insert: mockWeeklyInsertCall,
      update: () => ({
        eq: mockWeeklyUpdateEq,
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

vi.mock('@/lib/meal-image-jobs', () => ({
  cancelPendingMealImageJobs: vi.fn(async () => {}),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    withUser: vi.fn().mockReturnThis(),
    error: vi.fn(),
  })),
}));

const mockCallGenerateMenuV4WithRetry = vi.fn(async (..._args: any[]): Promise<
  { ok: true; attempts: number; response: Response } | { ok: false; attempts: number; errorMessage: string }
> => ({
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

const mockRestorePlannedMealsSnapshot = vi.fn(async (..._args: any[]) => ({ restored: 0, skipped: 0, failed: 0 }));
vi.mock('@/lib/planned-meals-snapshot', () => ({
  restorePlannedMealsSnapshot: mockRestorePlannedMealsSnapshot,
}));

const { POST } = await import('@/app/api/ai/menu/weekly/request/route');

const user = { id: 'user-1' };
const startDate = '2026-07-06'; // 固定した「今日」= fake timer で使用

const makeRequest = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/ai/menu/weekly/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const flushBackground = async () => {
  await Promise.all(waitUntilPromises);
};

const existingBreakfast = {
  id: 'meal-breakfast-1',
  daily_meal_id: 'day-1',
  meal_type: 'breakfast',
  dish_name: '元の朝食',
};
const existingLunch = {
  id: 'meal-lunch-1',
  daily_meal_id: 'day-1',
  meal_type: 'lunch',
  dish_name: '元の昼食',
};

beforeEach(() => {
  vi.clearAllMocks();
  waitUntilPromises.length = 0;
  userDailyMealsQueue.length = 0;
  plannedMealsSelectQueue.length = 0;

  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-06T09:00:00+09:00'));

  mockGetUser.mockResolvedValue({ data: { user }, error: null });
  mockWeeklyInsertSingle.mockResolvedValue({ data: { id: 'request-1' }, error: null });

  // day0(startDate): 既存の献立あり（削除→スナップショット対象）
  userDailyMealsQueue.push({ data: { id: 'day-1' }, error: null });
  plannedMealsSelectQueue.push({ data: [existingBreakfast, existingLunch], error: null });
  // day1〜day6: 既存の献立なし
  for (let i = 0; i < 6; i++) {
    userDailyMealsQueue.push({ data: null, error: null });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('POST /api/ai/menu/weekly/request', () => {
  it('Edge Function 失敗時、削除前スナップショットからロールバック復元する', async () => {
    mockCallGenerateMenuV4WithRetry.mockResolvedValue({
      ok: false,
      attempts: 3,
      errorMessage: 'generate-menu-v4 failed after 3/3 attempts',
    });
    mockRestorePlannedMealsSnapshot.mockResolvedValue({ restored: 2, skipped: 0, failed: 0 });

    const res = await POST(makeRequest({ startDate }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe('processing');

    // weekly_menu_requests insert に削除前スナップショットが退避されていること
    const insertPayload = mockWeeklyInsertCall.mock.calls[0][0];
    expect(insertPayload.generated_data).toEqual({ snapshot: [existingBreakfast, existingLunch] });

    await flushBackground();

    // Edge Function 失敗 → ロールバック復元が呼ばれること
    expect(mockRestorePlannedMealsSnapshot).toHaveBeenCalledTimes(1);
    expect(mockRestorePlannedMealsSnapshot).toHaveBeenCalledWith(
      mockSupabase,
      [existingBreakfast, existingLunch],
    );

    // markWeeklyMenuRequestFailed にロールバック結果が反映されたエラーメッセージが渡ること
    expect(mockMarkWeeklyMenuRequestFailed).toHaveBeenCalledTimes(1);
    const failedArgs = mockMarkWeeklyMenuRequestFailed.mock.calls[0][0];
    expect(failedArgs.requestId).toBe('request-1');
    expect(failedArgs.errorMessage).toContain('rollback: restored=2, skipped=0, failed=0');
  });

  it('Edge Function 成功時はロールバックを実行しない', async () => {
    mockCallGenerateMenuV4WithRetry.mockResolvedValue({ ok: true, attempts: 1, response: new Response() });

    const res = await POST(makeRequest({ startDate }));
    expect(res.status).toBe(200);

    await flushBackground();

    expect(mockRestorePlannedMealsSnapshot).not.toHaveBeenCalled();
    expect(mockMarkWeeklyMenuRequestFailed).not.toHaveBeenCalled();
  });

  it('削除対象の既存献立がない週は generated_data.snapshot を null にする', async () => {
    userDailyMealsQueue.length = 0;
    plannedMealsSelectQueue.length = 0;
    for (let i = 0; i < 7; i++) {
      userDailyMealsQueue.push({ data: null, error: null });
    }
    mockCallGenerateMenuV4WithRetry.mockResolvedValue({ ok: true, attempts: 1, response: new Response() });

    const res = await POST(makeRequest({ startDate }));
    expect(res.status).toBe(200);

    const insertPayload = mockWeeklyInsertCall.mock.calls[0][0];
    expect(insertPayload.generated_data).toBeNull();

    await flushBackground();
    expect(mockRestorePlannedMealsSnapshot).not.toHaveBeenCalled();
  });

  it('#1035: TZ=UTC ランタイムで JST 早朝でも「昨日」の献立を削除しない（今日以降のみ処理）', async () => {
    // Vercel Node ランタイムを模して TZ=UTC を強制する
    vi.stubEnv('TZ', 'UTC');
    // JST 2026-07-06 00:30 = UTC 2026-07-05 15:30（UTC 基準だと「今日」は 07-05 に誤判定されうる境界）
    vi.setSystemTime(new Date('2026-07-05T15:30:00Z'));

    const localStartDate = '2026-06-30'; // 週の開始（過去日）
    // addDays(startDate, 6) = 2026-07-06（JSTの「今日」）のみ既存献立ありとする
    userDailyMealsQueue.length = 0;
    plannedMealsSelectQueue.length = 0;
    userDailyMealsQueue.push({ data: { id: 'day-today' }, error: null });
    plannedMealsSelectQueue.push({ data: [existingBreakfast], error: null });

    mockCallGenerateMenuV4WithRetry.mockResolvedValue({ ok: true, attempts: 1, response: new Response() });

    const res = await POST(makeRequest({ startDate: localStartDate }));
    expect(res.status).toBe(200);

    // 「今日以降」と判定された日だけ user_daily_meals に問い合わせる。
    // UTC ベースの旧実装（todayStr='2026-07-05'）だと 07-05（昨日）・07-06（今日）の
    // 2日分が対象になってしまうが、修正後は 07-06 の1日のみ。
    expect(mockUserDailyMealsMaybeSingle).toHaveBeenCalledTimes(1);

    // 削除（スナップショット退避）されるのは今日分のみで、昨日の献立・完食記録は保持される
    const insertPayload = mockWeeklyInsertCall.mock.calls[0][0];
    expect(insertPayload.generated_data).toEqual({ snapshot: [existingBreakfast] });
  });
});
