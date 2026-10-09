// @vitest-environment node
/**
 * 献立を作る系の API 5 本が、Supabase の接続情報 (必須の環境変数) を取り出す順序のテスト (#1182)
 *
 *   対象: day/regenerate・meal/generate・meal/regenerate・v4/generate・weekly/request
 *
 * 必須の環境変数 (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) が欠けているとき:
 *   1. 未ログインの呼び出しには、設定の不足を教えず、これまでどおり 401 を返す
 *      (以前は取り出しが認証より前にあり、未ログインでも 500 になり、本文に変数名が出ていた)
 *   2. レート制限を超えた呼び出しは、これまでどおり 429 を返す
 *   3. ログイン済みで制限内なら、DB に何も書く前 (どのテーブルにも触れる前) に、汎用の 500 で止める。
 *      本文には変数名を出さず (#1172)、変数名は構造化ログ (db-logger) にだけ渡す
 *   4. 設定が揃っていれば、DB の処理に進む (3 が「そもそも DB に進まない route」で成り立っているのではないことの確認)
 *
 * 個々の route の動き (生成の中身) は、day-regenerate.test.ts・weekly-request.test.ts などが見る。
 * ここでは DB を「触れたら記録して失敗する」モックにして、順序だけを確かめる。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUser = vi.fn();
const mockFrom = vi.fn((_table: string): never => {
  throw new Error('DB_TOUCHED');
});
const mockCheckRateLimit = vi.fn();
const mockCallGenerateMenuV4WithRetry = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser }, from: mockFrom })),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  rateLimitExceededResponse: vi.fn(() => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })),
}));

vi.mock('@/lib/menu-generation-feature-flags', () => ({
  loadFeatureFlags: vi.fn(async () => ({ menu_generation_v5_wrapped: false })),
}));

vi.mock('@/lib/meal-image-jobs', () => ({
  cancelPendingMealImageJobs: vi.fn(async () => {}),
}));

vi.mock('@/lib/planned-meals-snapshot', () => ({
  restorePlannedMealsSnapshot: vi.fn(async () => ({ restored: 0, skipped: 0, failed: 0 })),
}));

// internalError() が使う構造化ログ。変数名がここに渡ることを見る (#1182)
const mockLoggerError = vi.fn();
vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    withUser: vi.fn().mockReturnThis(),
    error: mockLoggerError,
    warn: vi.fn(),
  })),
  generateRequestId: vi.fn(() => 'req-test'),
}));

vi.mock('@/lib/generate-menu-v4-retry', () => ({
  callGenerateMenuV4WithRetry: (...args: unknown[]) => mockCallGenerateMenuV4WithRetry(...args),
  markWeeklyMenuRequestFailed: vi.fn(async () => {}),
}));

vi.mock('@/lib/generate-menu-v5-retry', () => ({
  callGenerateMenuV5WithRetry: vi.fn(async () => ({ ok: true, attempts: 1, response: new Response() })),
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

type RouteModule = { POST: (request: Request) => Promise<Response> };

interface RouteCase {
  name: string;
  load: () => Promise<RouteModule>;
  /** 自分の user_daily_meals / planned_meals などに触れる、最初の DB の呼び出しまで進む本文 */
  body: Record<string, unknown>;
}

const FUTURE_DATE = '2099-01-01';

const ROUTES: RouteCase[] = [
  {
    name: 'day/regenerate',
    load: () => import('@/app/api/ai/menu/day/regenerate/route'),
    body: { dayDate: FUTURE_DATE },
  },
  {
    name: 'meal/generate',
    load: () => import('@/app/api/ai/menu/meal/generate/route'),
    body: { dayDate: FUTURE_DATE, mealType: 'dinner' },
  },
  {
    name: 'meal/regenerate',
    load: () => import('@/app/api/ai/menu/meal/regenerate/route'),
    body: { mealId: '0c6a3b7e-1111-4222-8333-944455556666' },
  },
  {
    name: 'v4/generate',
    load: () => import('@/app/api/ai/menu/v4/generate/route'),
    body: { targetSlots: [{ date: FUTURE_DATE, mealType: 'dinner' }] },
  },
  {
    name: 'weekly/request',
    load: () => import('@/app/api/ai/menu/weekly/request/route'),
    body: { startDate: FUTURE_DATE },
  },
];

const REQUIRED_NAMES = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

const makeRequest = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/ai/menu/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-test');
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mockCheckRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(ROUTES.map((route) => [route.name, route] as const))('POST /api/ai/menu/%s — 必須の環境変数を取り出す順序 (#1182)', (_name, route) => {
  it.each(REQUIRED_NAMES)('%s が未設定でも、未ログインなら 401 を返す (設定の不足を教えず、DB にも触れない)', async (name) => {
    vi.stubEnv(name, undefined);
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const { POST } = await route.load();

    const response = await POST(makeRequest(route.body));
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(JSON.stringify(json)).not.toContain(name);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('必須の環境変数が未設定でも、レート制限を超えていれば 429 を返す', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);
    mockCheckRateLimit.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: Date.now() + 60_000 });
    const { POST } = await route.load();

    const response = await POST(makeRequest(route.body));

    expect(response.status).toBe(429);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it.each(REQUIRED_NAMES)('%s が未設定なら、ログイン・レート制限のあと、DB に触れる前に、汎用の 500 で止める (本文に変数名なし・ログに変数名あり)', async (name) => {
    vi.stubEnv(name, undefined);
    const { POST } = await route.load();

    const response = await POST(makeRequest(route.body));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(text).not.toContain(name);
    expect(JSON.stringify([...response.headers.entries()])).not.toContain(name);
    // 変数名は構造化ログに渡す
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][1]).toMatchObject({ name: 'MissingEnvError', envName: name });
    expect(mockCheckRateLimit).toHaveBeenCalledWith('user-1', 'generation');
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockCallGenerateMenuV4WithRetry).not.toHaveBeenCalled();
  });

  it('設定が揃っていれば、DB の処理に進む (環境変数の不足の 500 にはならない)', async () => {
    const { POST } = await route.load();

    const response = await POST(makeRequest(route.body));
    const json = await response.json();

    // DB は「触れたら失敗する」モック。ここまで進んだこと (DB に触れたこと) だけを見る
    expect(mockFrom).toHaveBeenCalled();
    expect(response.status).toBe(500);
    expect(JSON.stringify(json)).not.toMatch(/NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY/);
    // ログに渡ったのは DB のエラー (MissingEnvError ではない)
    expect(mockLoggerError.mock.calls[0][1]).not.toMatchObject({ name: 'MissingEnvError' });
  });
});
