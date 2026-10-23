// @vitest-environment node
/**
 * #1793 POST /api/ai/menu/v4/generate・v5/generate: 本文の targetSlots[].plannedMealId を、DB で見つかった id の集合
 * (foundIds / byId。DB の id は小文字) と JS で比べていたため、正しい本人が大文字・混在の UUID で送ると
 * 「見つからない」扱いになり、plannedMealId が黙って外されていた (既存の 1 食を作り直すはずが、新しい枠として生成に回る)。
 * 受け取った直後に normalizeUuid でそろえ、照合・DB・キューの行・Edge Function への payload にはそろえた値だけを使うことを固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  generateV4: vi.fn(),
  generateV5: vi.fn(),
  results: {} as Record<string, unknown>,
  inCalls: [] as Array<{ table: string; column: string; values: unknown }>,
  writes: [] as Array<{ table: string; op: string; payload: any }>,
  waitUntil: [] as Promise<unknown>[],
}));

/** どのメソッドを呼んでも自分自身を返し、await すると表ごとの結果になる。in と insert / update の引数は記録する */
function fakeFrom(table: string) {
  const result = h.results[table] ?? { data: [], error: null };
  const proxy: any = new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      if (prop === 'in') {
        return (column: string, values: unknown) => {
          h.inCalls.push({ table, column, values });
          return proxy;
        };
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
// 16 進の英字を含む id (DB の id は小文字)
const MEAL_ID = 'abcdef12-3456-4abc-8def-0123456789ab';
const DAY = '2026-10-09';

/** 英字を 1 文字おきに大文字にする (大文字・小文字の混在) */
const mixedCase = (id: string) => id.replace(/[a-f]/g, (c, i: number) => (i % 2 === 0 ? c.toUpperCase() : c));

function storedMeal(mealType: string) {
  return {
    data: [{ id: MEAL_ID, meal_type: mealType, daily_meal_id: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', user_daily_meals: { day_date: DAY, user_id: USER.id } }],
    error: null,
  };
}

const CASES = [
  {
    name: 'POST /api/ai/menu/v4/generate',
    post: postV4Generate,
    okStatus: 200,
    generator: () => h.generateV4,
  },
  {
    name: 'POST /api/ai/menu/v5/generate',
    post: postV5Generate,
    okStatus: 202,
    generator: null,
  },
] as const;

function post(body: unknown): Request {
  return new Request('http://localhost/api/ai/menu/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function queueInsert(): any {
  return h.writes.find((w) => w.table === 'weekly_menu_requests' && w.op === 'insert')?.payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  // route は Supabase の URL・サービスロールのキーが無いと汎用の 500 で止まる (#1182)。DB はモックなので値はダミー
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-test');
  h.inCalls.length = 0;
  h.writes.length = 0;
  h.waitUntil.length = 0;
  h.getUser.mockResolvedValue({ data: { user: USER }, error: null });
  h.generateV4.mockResolvedValue({ ok: true, attempts: 1, response: new Response() });
  h.generateV5.mockResolvedValue({ ok: true, attempts: 1, response: new Response() });
  h.results = {
    planned_meals: storedMeal('lunch'),
    user_daily_meals: { data: [], error: null },
    pantry_items: { data: [], error: null },
    user_profiles: { data: { family_size: 2 }, error: null },
    weekly_menu_requests: { data: { id: 'request-1' }, error: null },
  };
});

describe.each(CASES)('$name: 大文字・混在の plannedMealId (#1793)', (testCase) => {
  it.each([
    ['大文字', MEAL_ID.toUpperCase()],
    ['大文字・小文字の混在', mixedCase(MEAL_ID)],
  ])('本人の食事の id を%sで送っても外されず、DB の照合・キューの行には小文字の id を渡す', async (_label, sentId) => {
    expect(sentId).not.toBe(MEAL_ID);
    const POST = testCase.post;

    const res = await POST(post({ targetSlots: [{ date: DAY, mealType: 'lunch', plannedMealId: sentId }] }));
    expect(res.status).toBe(testCase.okStatus);
    await Promise.all(h.waitUntil);

    expect(h.inCalls).toEqual([{ table: 'planned_meals', column: 'id', values: [MEAL_ID] }]);
    const insert = queueInsert();
    expect(insert).toBeDefined();
    expect(JSON.stringify(insert.target_slots)).toContain(MEAL_ID);
    expect(JSON.stringify(insert.target_slots)).not.toContain(sentId);
    if (testCase.generator) {
      const generator = testCase.generator();
      expect(generator).toHaveBeenCalledTimes(1);
      expect(generator.mock.calls[0][0].payload.targetSlots).toEqual([{ date: DAY, mealType: 'lunch', plannedMealId: MEAL_ID }]);
    } else {
      expect(insert.generated_data.targetSlots).toEqual([{ date: DAY, mealType: 'lunch', plannedMealId: MEAL_ID }]);
    }
  });

  it('大文字で送った id が DB の行に当たるので、食事の区分の食い違いは 400 (外されて素通りしない)', async () => {
    h.results.planned_meals = storedMeal('dinner');
    const POST = testCase.post;

    const res = await POST(post({ targetSlots: [{ date: DAY, mealType: 'lunch', plannedMealId: MEAL_ID.toUpperCase() }] }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '指定した献立の食事の区分が、選んだ枠と一致しません' });
    expect(queueInsert()).toBeUndefined();
  });

  it('大文字と小文字の同じ id を 2 つの枠に入れると、重複として 400 (DB にも認証にも触れない)', async () => {
    const POST = testCase.post;

    const res = await POST(
      post({
        targetSlots: [
          { date: DAY, mealType: 'lunch', plannedMealId: MEAL_ID },
          { date: DAY, mealType: 'lunch', plannedMealId: MEAL_ID.toUpperCase() },
        ],
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `同じ枠 (${DAY} の lunch) が 2 回指定されています` });
    expect(h.getUser).not.toHaveBeenCalled();
    expect(h.inCalls).toEqual([]);
  });
});
