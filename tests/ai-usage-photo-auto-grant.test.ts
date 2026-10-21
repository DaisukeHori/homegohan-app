/**
 * #1149 (T40) の是正: 写真の「オート」は、1 回の操作を 1 回と数える (判別 classify-photo → 解析 analyze-*)
 *
 * 写真の「オート」は、1 回押すと判別 (POST /api/ai/classify-photo) と続く解析 (analyze-meal-photo / analyze-fridge /
 * analyze-health-checkup / analyze-weight-scale) の 2 つの API を呼ぶ。以前は両方が 1 回ずつ数え、1 回の操作が 2 回になっていた
 * (実際に使えるのは 5 回)。いまは判別が 1 回数えて「数え済みの印」(aiUsageGrant) を返し、解析はその印を使えたら数えない。
 *
 * ここでは本物の route と本物の判定の部品 (src/lib/plan/entitlements.ts・_shared/ai-usage-core.ts) を動かし、DB の関数
 * (consume_ai_usage / claim_ai_usage_grant) だけを、ai_usage_counters と ai_usage_grant_claims を真似たメモリの表に差し替えて、
 * 表の回数がどう増えるかを確かめる (DB の関数そのものは tests/integration/rls/ai-daily-limit-rpc.test.ts が実 DB で確かめる)。
 *
 *   1. オートの流れ (判別 → 解析) で、ai_usage_counters は 1 だけ増える (解析の 4 種すべて。判別できなかった 422 のあとに種類を選んでも)
 *   2. 印の無い解析は 1 回数える。偽の prefetchedGeminiResult を送っても数える (解析を無料にする抜け道が無い)
 *   3. 期限切れの印・他人の印・偽の印・使用済みの印 (同じ印の 2 回目) は数える
 *   4. 上限に達していれば、印の無い解析は 429 で止まる。印のある解析は (判別で数え済みなので) 止めない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const SERVICE_KEY = 'service-role-key-for-test';
/** テストの 1 日の上限 (DB の既定の値とは独立) */
const LIMIT = 10;
/** 判別の結果の確からしさ (route が判別できたとみなす値より上) */
const CONFIDENT = 0.9;
/** 期限切れの印を作るための、印の有効期限より長い時間 (ミリ秒) */
const LONGER_THAN_GRANT_MS = 11 * 60 * 1000;

const h = vi.hoisted(() => {
  /** ai_usage_counters の真似: `${user}:${feature}` → 回数 (同じ日だけを扱う) */
  const counters = new Map<string, number>();
  /** ai_usage_grant_claims の真似: 使用済みの印の ID */
  const claims = new Set<string>();
  const state = { user: '11111111-1111-4111-8111-111111111111', classifyType: 'meal' as string, classifyConfidence: 0.9 };
  const unmetered = new Set(['nutrition_advice_auto', 'meal_image_auto']);
  const used = (user: string) =>
    [...counters.entries()].filter(([key]) => key.startsWith(`${user}:`) && !unmetered.has(key.split(':')[1])).reduce((sum, [, n]) => sum + n, 0);
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'consume_ai_usage') {
      const user = String(args.p_user_id);
      const feature = String(args.p_feature);
      const before = used(user);
      if (before >= 10) {
        return { data: { allowed: false, metered: true, plan: 'free', limit: 10, used: before, usage_date: '2026-10-11' }, error: null };
      }
      counters.set(`${user}:${feature}`, (counters.get(`${user}:${feature}`) ?? 0) + 1);
      return { data: { allowed: true, metered: true, plan: 'free', limit: 10, used: before + 1, usage_date: '2026-10-11' }, error: null };
    }
    if (name === 'claim_ai_usage_grant') {
      const id = String(args.p_grant_id);
      if (claims.has(id)) return { data: false, error: null };
      claims.add(id);
      return { data: true, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  });
  const generateGeminiJson = vi.fn(async () => ({
    data: {
      type: state.classifyType,
      confidence: state.classifyConfidence,
      dishes: [{ name: 'カレー', role: 'main', visibleIngredients: [] }],
      ingredients: [{ name: '卵', quantity: '2個' }],
      summary: '卵があります',
      suggestions: [],
      // 健康診断の読み取り (1 項目以上読めれば 200)
      weight: 60,
    },
    model: 'test-model',
  }));
  // Edge Function の応答: 食事の解析 (dishes) と体重計の読み取り (values.weight) の両方の形を持つ
  const functionsInvoke = vi.fn(async () => ({ data: { dishes: [{ name: 'カレー' }], values: { weight: 60 }, confidence: 0.9 }, error: null }));
  return { counters, claims, state, rpc, generateGeminiJson, functionsInvoke };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: h.state.user } }, error: null }) },
    functions: { invoke: h.functionsInvoke },
    from: () => {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'ilike', 'or', 'order', 'limit']) query[method] = () => query;
      query.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
      return query;
    },
  }),
  getSupabaseAdmin: () => ({ rpc: h.rpc }),
}));
vi.mock('@/lib/ai/consent-guard', () => ({ requireAiConsent: vi.fn(async () => null) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60_000 })),
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    withUser: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }),
}));
vi.mock('@/lib/ai/gemini-json', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/gemini-json')>()),
  generateGeminiJson: h.generateGeminiJson,
}));
vi.mock('@/lib/catalog-products', () => ({ findCatalogCandidatesForDishes: vi.fn(async () => []) }));

const { POST: classifyPhoto } = await import('../src/app/api/ai/classify-photo/route');
const { POST: analyzeMealPhoto } = await import('../src/app/api/ai/analyze-meal-photo/route');
const { POST: analyzeFridge } = await import('../src/app/api/ai/analyze-fridge/route');
const { POST: analyzeHealthCheckup } = await import('../src/app/api/ai/analyze-health-checkup/route');
const { POST: analyzeWeightScale } = await import('../src/app/api/ai/analyze-weight-scale/route');

/** 判別の route が「小さすぎる画像」として AI に送らずに返す大きさより大きい画像 */
const IMAGE = 'A'.repeat(4000);

function post(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/ai/x', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
}

/** 解析の route と、その本文 (画面が送る形) */
const ANALYZERS = {
  meal: (grant?: unknown, extra: Record<string, unknown> = {}) =>
    analyzeMealPhoto(post({ images: [{ base64: IMAGE, mimeType: 'image/jpeg' }], mealType: 'lunch', aiUsageGrant: grant, ...extra })),
  fridge: (grant?: unknown) => analyzeFridge(post({ imageBase64: IMAGE, mimeType: 'image/jpeg', aiUsageGrant: grant })),
  health_checkup: (grant?: unknown) => analyzeHealthCheckup(post({ imageBase64: IMAGE, mimeType: 'image/jpeg', aiUsageGrant: grant })),
  weight_scale: (grant?: unknown) => analyzeWeightScale(post({ image: IMAGE, mimeType: 'image/jpeg', aiUsageGrant: grant })),
} as const;

/** 写真の「オート」の判別。応答の本文を返す */
async function classify(type: string, confidence = CONFIDENT): Promise<{ status: number; body: Record<string, unknown> }> {
  h.state.classifyType = type;
  h.state.classifyConfidence = confidence;
  const res = await classifyPhoto(post({ images: [{ base64: IMAGE, mimeType: 'image/jpeg' }], includeMealAnalysis: true, mealType: 'lunch' }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** その利用者の、その日の photo_analysis の回数 (ai_usage_counters の真似) */
const photoCount = (user: string = USER) => h.counters.get(`${user}:photo_analysis`) ?? 0;

beforeEach(() => {
  h.counters.clear();
  h.claims.clear();
  h.state.user = USER;
  h.rpc.mockClear();
  h.generateGeminiJson.mockClear();
  h.functionsInvoke.mockClear();
  vi.stubEnv('SERVICE_ROLE_JWT', '');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('1. オートの流れ (判別 → 解析) は 1 回だけ数える', () => {
  it.each(Object.keys(ANALYZERS) as Array<keyof typeof ANALYZERS>)('判別 → %s の解析: ai_usage_counters は 1 だけ増え、解析は AI へ送る', async (type) => {
    const classified = await classify(type);
    expect(classified.status).toBe(200);
    expect(classified.body.aiUsageGrant).toEqual(expect.any(String));
    expect(photoCount()).toBe(1);

    const aiCallsBefore = h.generateGeminiJson.mock.calls.length + h.functionsInvoke.mock.calls.length;
    const res = await ANALYZERS[type](classified.body.aiUsageGrant);
    expect(res.status).toBe(200);

    // 判別の 1 回だけ (解析は数えない)
    expect(photoCount()).toBe(1);
    // 解析は実際に AI (Gemini / Edge Function) へ送っている (数えずに済ませただけで、処理は止めていない)
    expect(h.generateGeminiJson.mock.calls.length + h.functionsInvoke.mock.calls.length).toBeGreaterThan(aiCallsBefore);
    // 印は DB で使用済みにした
    expect(h.rpc.mock.calls.filter(([name]) => name === 'claim_ai_usage_grant')).toHaveLength(1);
  });

  it('食事の解析: 判別が返した解析の結果 (prefetchedGeminiResult) を一緒に送っても、1 回だけ', async () => {
    const classified = await classify('meal');
    await ANALYZERS.meal(classified.body.aiUsageGrant, { prefetchedGeminiResult: classified.body.mealAnalysis });
    expect(photoCount()).toBe(1);
  });

  it('判別できなかった (422) ときも印を返し、種類を手で選んだ解析は数えない (判別の続きとして 1 回)', async () => {
    const classified = await classify('unknown', 0);
    expect(classified.status).toBe(422);
    expect(classified.body.aiUsageGrant).toEqual(expect.any(String));
    expect(photoCount()).toBe(1);

    await ANALYZERS.fridge(classified.body.aiUsageGrant);
    expect(photoCount()).toBe(1);
  });

  it('オートを 10 回 (判別 → 解析を 10 組) 使える。11 回目の判別は上限で止まる (以前は 5 回で止まっていた)', async () => {
    for (let i = 0; i < LIMIT; i++) {
      const classified = await classify('meal');
      expect(classified.status, `${i + 1} 回目の判別`).toBe(200);
      const res = await ANALYZERS.meal(classified.body.aiUsageGrant);
      expect(res.status, `${i + 1} 回目の解析`).toBe(200);
    }
    expect(photoCount()).toBe(LIMIT);
    const eleventh = await classify('meal');
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.code).toBe('AI_DAILY_LIMIT');
    expect(eleventh.body.aiUsageGrant).toBeUndefined();
  });
});

describe('2. 印の無い解析は数える (抜け道が無い)', () => {
  it.each(Object.keys(ANALYZERS) as Array<keyof typeof ANALYZERS>)('%s: 印が無ければ 1 回数える', async (type) => {
    await ANALYZERS[type]();
    expect(photoCount()).toBe(1);
    expect(h.rpc.mock.calls.filter(([name]) => name === 'claim_ai_usage_grant')).toHaveLength(0);
  });

  it('偽の prefetchedGeminiResult を送っても、印が無ければ数える (解析が無料にならない)', async () => {
    const fake = { dishes: [{ name: 'ステーキ', role: 'main', visibleIngredients: [{ name: '牛肉', amount_g: 200 }] }] };
    await ANALYZERS.meal(undefined, { prefetchedGeminiResult: fake });
    await ANALYZERS.meal('not-a-grant', { prefetchedGeminiResult: fake });
    expect(photoCount()).toBe(2);
  });

  it('上限に達していれば、印の無い解析は 429 で止め、AI へ送らない', async () => {
    h.counters.set(`${USER}:consultation`, LIMIT);
    const aiCallsBefore = h.functionsInvoke.mock.calls.length;
    const res = await ANALYZERS.meal();
    expect(res.status).toBe(429);
    expect(h.functionsInvoke.mock.calls.length).toBe(aiCallsBefore);
  });

  it('判別で数えたあとに上限に達しても、その判別の印のある解析は止めない (判別の 1 回に含まれる)', async () => {
    h.counters.set(`${USER}:consultation`, LIMIT - 1);
    const classified = await classify('meal');
    expect(classified.status).toBe(200);
    const res = await ANALYZERS.meal(classified.body.aiUsageGrant);
    expect(res.status).toBe(200);
    expect(photoCount()).toBe(1);
  });
});

describe('3. 使えない印は数える', () => {
  it('同じ印の 2 回目 (使用済み) は数える', async () => {
    const classified = await classify('meal');
    await ANALYZERS.meal(classified.body.aiUsageGrant);
    expect(photoCount()).toBe(1);
    await ANALYZERS.meal(classified.body.aiUsageGrant);
    await ANALYZERS.fridge(classified.body.aiUsageGrant);
    expect(photoCount()).toBe(3);
  });

  it('期限切れの印は数える', async () => {
    const classified = await classify('meal');
    const later = Date.now() + LONGER_THAN_GRANT_MS;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await ANALYZERS.meal(classified.body.aiUsageGrant);
    expect(photoCount()).toBe(2);
  });

  it('他人の印は数える (印は判別した利用者にだけ効く)', async () => {
    const classified = await classify('meal');
    h.state.user = OTHER_USER;
    await ANALYZERS.meal(classified.body.aiUsageGrant);
    expect(photoCount(OTHER_USER)).toBe(1);
    expect(photoCount(USER)).toBe(1);
    // 他人が送っても、印は使用済みにならない (本人はまだ使える)
    h.state.user = USER;
    await ANALYZERS.meal(classified.body.aiUsageGrant);
    expect(photoCount(USER)).toBe(1);
  });

  it('書き換えた印・形の違う値は数える', async () => {
    const classified = await classify('meal');
    const grant = String(classified.body.aiUsageGrant);
    const tampered = grant.slice(0, -1) + (grant.endsWith('0') ? '1' : '0');
    for (const value of [tampered, 42, { grant }, [grant]]) await ANALYZERS.meal(value);
    expect(photoCount()).toBe(5);
  });

  it('DB の claim_ai_usage_grant が失敗したら、数える側に倒す', async () => {
    const classified = await classify('meal');
    h.rpc.mockImplementationOnce(async () => ({ data: null, error: { message: 'function claim_ai_usage_grant does not exist' } }));
    await ANALYZERS.meal(classified.body.aiUsageGrant);
    expect(photoCount()).toBe(2);
  });
});
