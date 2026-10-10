// @vitest-environment node
/**
 * src/__tests__/api/ai/menu/engine-feature-flags.test.ts
 *
 * #1148: 献立生成の API が、エンジン (v4 / v5) の切り替えを feature_flags (isFeatureEnabled) で決めること。
 *   - meal/generate・meal/regenerate (1 食)・weekly/request・day/regenerate は menu_generation_v5_wrapped
 *   - v4/generate (汎用) は menu_generation_v5_direct
 * weekly/request と day/regenerate のエンジンの切り替えは、それぞれ weekly-request.test.ts と day-regenerate.test.ts で確かめる。
 * ここでは、残りの 3 本 (meal/generate・meal/regenerate・v4/generate) を、ON / OFF と、別のフラグの影響を受けないことで確かめる。
 *
 * 以前は system_settings を、ログイン中のユーザー自身の権限で読んでいたため、admin / super_admin 以外は
 * 値が読めず、いつも v5 だった。今は feature_flags をサーバー側 (isFeatureEnabled) で読むので、全ユーザーに効く。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isFeatureEnabled: vi.fn(),
  generateV4: vi.fn(),
  generateV5: vi.fn(),
  getUser: vi.fn(),
  results: {} as Record<string, unknown>,
  writes: [] as Array<{ table: string; op: string; payload: any; client: 'user' | 'service' }>,
  waitUntil: [] as Promise<unknown>[],
}));

/**
 * どのメソッドを呼んでも自分自身を返し、await すると表ごとの結果になる。insert / update の中身は記録する。
 * client は、利用者のクライアント (user) か、AI のキューへ書く service role のクライアント (service。#1465) か
 */
function fakeFrom(table: string, client: 'user' | 'service' = 'user') {
  const result = h.results[table] ?? { data: [], error: null };
  const proxy: any = new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      if (prop === 'insert' || prop === 'update') {
        return (payload: unknown) => {
          h.writes.push({ table, op: String(prop), payload, client });
          return proxy;
        };
      }
      return () => proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}

// 同意の判定 (T15 / #1154) は「同意済み」に差し替える。同意が無いときに AI へ送らないことは tests/ai-consent-enforcement-routes.test.ts が見る
vi.mock('@/lib/ai/consent-guard', () => import('../../../../../tests/helpers/ai-consent-guard-allowed'));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: h.getUser },
    from: (table: string) => fakeFrom(table),
  })),
  // AI のキューへの書き込みは service role のクライアント (getAiQueueWriter → getSupabaseAdmin) で行う (#1465)
  getSupabaseAdmin: vi.fn(() => ({ from: (table: string) => fakeFrom(table, 'service') })),
}));

vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: (key: string, userId?: string) => h.isFeatureEnabled(key, userId),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60_000 })),
  rateLimitExceededResponse: vi.fn(),
}));

vi.mock('@/lib/generate-menu-v4-retry', () => ({
  callGenerateMenuV4WithRetry: (...args: unknown[]) => h.generateV4(...args),
  markWeeklyMenuRequestFailed: vi.fn(async () => undefined),
}));

vi.mock('@/lib/generate-menu-v5-retry', () => ({
  callGenerateMenuV5WithRetry: (...args: unknown[]) => h.generateV5(...args),
}));

vi.mock('@/lib/v4-target-slots', () => ({
  resolveExistingTargetSlots: vi.fn(async ({ targetSlots }: { targetSlots: unknown[] }) => targetSlots),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  })),
  generateRequestId: vi.fn(() => 'req-test'),
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    h.waitUntil.push(promise);
  }),
}));

const USER = { id: 'user-1' };
const MEAL_ID = '11111111-1111-4111-8111-111111111111';
const DAY = '2026-10-09';

const DEFAULT_RESULTS: Record<string, unknown> = {
  user_daily_meals: { data: { id: 'day-1', day_date: DAY }, error: null },
  planned_meals: {
    data: { id: MEAL_ID, meal_type: 'lunch', user_daily_meals: { day_date: DAY, user_id: USER.id } },
    error: null,
  },
  weekly_menu_requests: { data: { id: 'request-1' }, error: null },
  pantry_items: { data: [], error: null },
  user_profiles: { data: { family_size: 2 }, error: null },
};

interface RouteCase {
  name: string;
  load: () => Promise<{ POST: (request: Request) => Promise<Response> }>;
  url: string;
  body: Record<string, unknown>;
  /** この API が見るフラグ */
  flag: 'menu_generation_v5_wrapped' | 'menu_generation_v5_direct';
  /** この API が見ないフラグ (ON でも結果を変えないこと) */
  otherFlag: 'menu_generation_v5_wrapped' | 'menu_generation_v5_direct';
  /** weekly_menu_requests.mode をどこに書くか (insert か update) */
  modeWrittenBy: 'insert' | 'update';
  /** この API の流れに合わせて差し替える、表ごとの読み出し結果 */
  results?: Record<string, unknown>;
}

const CASES: RouteCase[] = [
  {
    name: 'meal/generate (1 食の新規生成)',
    load: () => import('@/app/api/ai/menu/meal/generate/route'),
    url: 'http://localhost/api/ai/menu/meal/generate',
    body: { dayDate: DAY, mealType: 'lunch' },
    flag: 'menu_generation_v5_wrapped',
    otherFlag: 'menu_generation_v5_direct',
    modeWrittenBy: 'update',
  },
  {
    name: 'meal/regenerate (1 食の作り直し)',
    load: () => import('@/app/api/ai/menu/meal/regenerate/route'),
    url: 'http://localhost/api/ai/menu/meal/regenerate',
    body: { mealId: MEAL_ID },
    flag: 'menu_generation_v5_wrapped',
    otherFlag: 'menu_generation_v5_direct',
    modeWrittenBy: 'update',
  },
  {
    name: 'v4/generate (汎用の献立生成)',
    load: () => import('@/app/api/ai/menu/v4/generate/route'),
    url: 'http://localhost/api/ai/menu/v4/generate',
    body: { targetSlots: [{ date: DAY, mealType: 'lunch' }] },
    flag: 'menu_generation_v5_direct',
    otherFlag: 'menu_generation_v5_wrapped',
    modeWrittenBy: 'insert',
    // 既存の献立の一覧 (配列) として読まれる
    results: { user_daily_meals: { data: [], error: null } },
  },
];

/** テストごとの読み出し結果にする (既定 + この API 用の差し替え) */
function useResults(testCase: RouteCase) {
  h.results = { ...DEFAULT_RESULTS, ...testCase.results };
}

function post(testCase: RouteCase, body = testCase.body): Request {
  return new Request(testCase.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** isFeatureEnabled が、指定したフラグだけ ON を返すようにする */
function enableOnly(...keys: string[]) {
  h.isFeatureEnabled.mockImplementation(async (key: string) => keys.includes(key));
}

function writtenMode(testCase: RouteCase): unknown {
  const write = h.writes.find(
    (w) => w.table === 'weekly_menu_requests' && w.op === testCase.modeWrittenBy && w.payload && 'mode' in w.payload,
  );
  return write?.payload.mode;
}

beforeEach(() => {
  vi.clearAllMocks();
  // route は Supabase の URL・サービスロールのキーが無いと汎用の 500 で止まる (#1182)。DB はモックなので値はダミー
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-test');
  h.writes.length = 0;
  h.waitUntil.length = 0;
  h.getUser.mockResolvedValue({ data: { user: USER }, error: null });
  h.generateV4.mockResolvedValue({ ok: true, attempts: 1, response: new Response() });
  h.generateV5.mockResolvedValue({ ok: true, attempts: 1, response: new Response() });
  h.results = { ...DEFAULT_RESULTS };
  enableOnly();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe.each(CASES)('$name のエンジン切り替え (#1148)', (testCase) => {
  it('フラグが ON なら v5 の Edge Function を呼び、リクエスト行の mode も v5 になる', async () => {
    useResults(testCase);
    enableOnly(testCase.flag);
    const { POST } = await testCase.load();

    const res = await POST(post(testCase));
    expect(res.status).toBe(200);
    await Promise.all(h.waitUntil);

    expect(h.isFeatureEnabled).toHaveBeenCalledWith(testCase.flag, USER.id);
    expect(h.generateV5).toHaveBeenCalledTimes(1);
    expect(h.generateV4).not.toHaveBeenCalled();
    expect(writtenMode(testCase)).toBe('v5');
    // weekly_menu_requests へは service role のクライアントだけが書く (#1465)
    const queueWrites = h.writes.filter((w) => w.table === 'weekly_menu_requests');
    expect(queueWrites.length).toBeGreaterThan(0);
    expect(queueWrites.every((w) => w.client === 'service')).toBe(true);
  });

  it('フラグが OFF なら v4 の Edge Function を呼び、リクエスト行の mode も v4 になる', async () => {
    useResults(testCase);
    enableOnly();
    const { POST } = await testCase.load();

    const res = await POST(post(testCase));
    expect(res.status).toBe(200);
    await Promise.all(h.waitUntil);

    expect(h.isFeatureEnabled).toHaveBeenCalledWith(testCase.flag, USER.id);
    expect(h.generateV4).toHaveBeenCalledTimes(1);
    expect(h.generateV5).not.toHaveBeenCalled();
    expect(writtenMode(testCase)).toBe('v4');
  });

  it('別のフラグ (menu_generation_v5_* のもう一方) だけが ON でも、この API は v4 のまま', async () => {
    useResults(testCase);
    enableOnly(testCase.otherFlag);
    const { POST } = await testCase.load();

    const res = await POST(post(testCase));
    expect(res.status).toBe(200);
    await Promise.all(h.waitUntil);

    expect(h.generateV4).toHaveBeenCalledTimes(1);
    expect(h.generateV5).not.toHaveBeenCalled();
  });

  it('system_settings (旧の置き場) は読まない', async () => {
    useResults(testCase);
    enableOnly(testCase.flag);
    const tablesRead: string[] = [];
    const server = await import('@/lib/supabase/server');
    vi.mocked(server.createClient).mockImplementationOnce(
      (async () => ({
        auth: { getUser: h.getUser },
        from: (table: string) => {
          tablesRead.push(table);
          return fakeFrom(table);
        },
      })) as unknown as typeof server.createClient,
    );
    const { POST } = await testCase.load();

    const res = await POST(post(testCase));
    expect(res.status).toBe(200);
    await Promise.all(h.waitUntil);

    expect(tablesRead.length).toBeGreaterThan(0);
    expect(tablesRead).not.toContain('system_settings');
    expect(tablesRead).not.toContain('feature_flags'); // フラグは isFeatureEnabled の中でだけ読む
  });
});
