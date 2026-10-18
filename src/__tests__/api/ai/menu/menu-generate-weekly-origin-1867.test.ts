// @vitest-environment node
/**
 * #1867 「計画上手」(planner) は、AI で週の献立を初めて作ったときにも付く。利用者が実際に週の献立を作る経路
 * (Web の「AI献立アシスタント」(V4GenerateModal)・AI のチャット・モバイル) は POST /api/ai/menu/v4/generate (と v5/generate) なので、
 * この 2 つも、生成の対象の枠が 1 週間 (異なる日付が WEEKLY_MENU_GENERATION_MIN_DAYS 日以上) を覆うときは、
 * 行を作るときに generated_data へ週の献立の生成の印 (weeklyRequest: true) を書く。完了したら状態の確認・バッジの一覧がこの印で付ける。
 *
 * 確かめること:
 *   - 7 日 × 3 食・7 日の夕食だけ: 印を書く (究極モードの印 ultimateMode はそのまま残る)
 *   - 6 日 × 3 食・1 日 3 食・1 食: 印を書かない (キー自体が無い)
 *   - v5 は行を作ったあとに requestId を埋め込むため generated_data を丸ごと書き直すので、その更新にも同じ印がある (更新で消えない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addDaysToDate } from '@/lib/date-utils';
import { WEEKLY_MENU_GENERATION_MIN_DAYS } from '@/lib/ai/weekly-menu-request-origin';

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  generateV4: vi.fn(),
  generateV5: vi.fn(),
  results: {} as Record<string, unknown>,
  writes: [] as Array<{ table: string; op: string; payload: any }>,
  waitUntil: [] as Promise<unknown>[],
}));

/** どのメソッドを呼んでも自分自身を返し、await すると表ごとの結果になる。insert / update の引数は記録する */
function fakeFrom(table: string) {
  const result = h.results[table] ?? { data: [], error: null };
  const proxy: any = new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      if (prop === 'insert' || prop === 'update') {
        return (payload: unknown) => {
          h.writes.push({ table, op: String(prop), payload });
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

vi.mock('@/lib/ai/consent-guard', () => import('../../../../../tests/helpers/ai-consent-guard-allowed'));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: h.getUser },
    from: (table: string) => fakeFrom(table),
  })),
  getSupabaseAdmin: vi.fn(() => ({ from: (table: string) => fakeFrom(table) })),
}));
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60_000 })),
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/plan/entitlements', () => ({
  consumeAiUsage: vi.fn(async () => ({ allowed: true })),
  refundAiUsage: vi.fn(async () => undefined),
  aiDailyLimitResponse: vi.fn(),
}));
vi.mock('@/lib/generate-menu-v4-retry', () => ({
  callGenerateMenuV4WithRetry: (...args: unknown[]) => h.generateV4(...args),
  markWeeklyMenuRequestFailed: vi.fn(async () => undefined),
}));
vi.mock('@/lib/generate-menu-v5-retry', () => ({
  callGenerateMenuV5WithRetry: (...args: unknown[]) => h.generateV5(...args),
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

// route はファイルの一番外側で読む (収集のときに読むので、テストの時間切れに入らない。tests/heavy-unit-test-timeout.test.ts)
const { POST: postV4Generate } = await import('@/app/api/ai/menu/v4/generate/route');
const { POST: postV5Generate } = await import('@/app/api/ai/menu/v5/generate/route');

const USER = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' };
/** 生成の対象の最初の日 */
const FIRST_DAY = '2026-10-19';
const MAIN_MEALS = ['breakfast', 'lunch', 'dinner'] as const;

/** FIRST_DAY から days 日、mealTypes の枠 */
function slots(days: number, mealTypes: readonly string[] = MAIN_MEALS) {
  const out: Array<{ date: string; mealType: string }> = [];
  for (let i = 0; i < days; i++) {
    for (const mealType of mealTypes) out.push({ date: addDaysToDate(FIRST_DAY, i), mealType });
  }
  return out;
}

function post(body: unknown): Request {
  return new Request('http://localhost/api/ai/menu/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function queueWrite(op: 'insert' | 'update'): any {
  return h.writes.find((w) => w.table === 'weekly_menu_requests' && w.op === op)?.payload;
}

const CASES = [
  { name: 'POST /api/ai/menu/v4/generate', post: postV4Generate, okStatus: 200, rewritesGeneratedData: false },
  { name: 'POST /api/ai/menu/v5/generate', post: postV5Generate, okStatus: 202, rewritesGeneratedData: true },
] as const;

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
  h.results = {
    planned_meals: { data: [], error: null },
    user_daily_meals: { data: [], error: null },
    pantry_items: { data: [], error: null },
    user_profiles: { data: { family_size: 2 }, error: null },
    weekly_menu_requests: { data: { id: 'request-1' }, error: null },
  };
});

describe.each(CASES)('$name: 1 週間を覆う生成の行に週の献立の生成の印を書く (#1867)', (testCase) => {
  /** 行を作るとき (と、v5 は requestId を埋め込む更新) の generated_data */
  async function generatedDataOf(body: Record<string, unknown>) {
    const res = await testCase.post(post(body));
    expect(res.status).toBe(testCase.okStatus);
    await Promise.all(h.waitUntil);
    const inserted = queueWrite('insert')?.generated_data;
    expect(inserted).toBeDefined();
    const updated = queueWrite('update')?.generated_data;
    if (testCase.rewritesGeneratedData) expect(updated).toBeDefined();
    return { inserted, updated };
  }

  it.each([
    ['7 日 × 朝昼夕 (21 枠)', slots(WEEKLY_MENU_GENERATION_MIN_DAYS)],
    ['7 日の夕食だけ (7 枠)', slots(WEEKLY_MENU_GENERATION_MIN_DAYS, ['dinner'])],
  ])('%s: 印 (weeklyRequest: true) を書く', async (_label, targetSlots) => {
    const { inserted, updated } = await generatedDataOf({ targetSlots });

    expect(inserted.weeklyRequest).toBe(true);
    expect(inserted.ultimateMode).toBe(false);
    if (testCase.rewritesGeneratedData) {
      // requestId を埋め込む更新で generated_data を丸ごと書き直しても、印は残る
      expect(updated.weeklyRequest).toBe(true);
      expect(updated.requestId).toBe('request-1');
    }
  });

  it('究極モードで 1 週間を作るときも印を書き、究極モードの印もそのまま書く', async () => {
    const { inserted, updated } = await generatedDataOf({ targetSlots: slots(WEEKLY_MENU_GENERATION_MIN_DAYS), ultimateMode: true });

    expect(inserted.weeklyRequest).toBe(true);
    expect(inserted.ultimateMode).toBe(true);
    if (testCase.rewritesGeneratedData) expect(updated.weeklyRequest).toBe(true);
  });

  it.each([
    ['6 日 × 朝昼夕 (1 週間に 1 日足りない)', slots(WEEKLY_MENU_GENERATION_MIN_DAYS - 1)],
    ['1 日の朝昼夕', slots(1)],
    ['1 食', slots(1, ['dinner'])],
  ])('%s: 印を書かない (キーも無い)', async (_label, targetSlots) => {
    const { inserted, updated } = await generatedDataOf({ targetSlots });

    expect(inserted).not.toHaveProperty('weeklyRequest');
    expect(inserted.ultimateMode).toBe(false);
    if (testCase.rewritesGeneratedData) expect(updated).not.toHaveProperty('weeklyRequest');
  });
});

describe('POST /api/ai/menu/v4/generate: 印のほかの generated_data は今までどおり (#1867)', () => {
  it('1 週間の生成の行の generated_data は、究極モードの印と週の献立の生成の印の 2 つだけ', async () => {
    const res = await postV4Generate(post({ targetSlots: slots(WEEKLY_MENU_GENERATION_MIN_DAYS) }));
    expect(res.status).toBe(200);
    expect(queueWrite('insert')?.generated_data).toEqual({ ultimateMode: false, weeklyRequest: true });
  });

  it('1 日の生成の行の generated_data は、究極モードの印だけ (今までと同じ)', async () => {
    const res = await postV4Generate(post({ targetSlots: slots(1) }));
    expect(res.status).toBe(200);
    expect(queueWrite('insert')?.generated_data).toEqual({ ultimateMode: false });
  });
});
