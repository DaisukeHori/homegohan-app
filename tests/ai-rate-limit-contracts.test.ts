/**
 * #1022 AIエンドポイントのユーザー単位レートリミット contract テスト
 *
 * 1. src/lib/rate-limit.ts のユニットテスト（in-memory フォールバック / Upstash モック）
 * 2. 代表的な AI route（analysis / image / generation 各カテゴリ）が
 *    実際に 429 を返すことを確認する contract テスト
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function resetUpstashEnv() {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

// ─────────────────────────────────────────────
// 1. src/lib/rate-limit.ts ユニットテスト
// ─────────────────────────────────────────────
describe('src/lib/rate-limit.ts (#1022)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    resetUpstashEnv();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.useRealTimers();
  });

  it('in-memory フォールバック: generation カテゴリは 5 req/min まで許可し、6回目は失敗する', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit');
    const userId = `user-gen-${Date.now()}`;

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await checkRateLimit(userId, 'generation'));
    }

    expect(results.slice(0, 5).map((r) => r.success)).toEqual([true, true, true, true, true]);
    expect(results[5].success).toBe(false);
  });

  it('in-memory フォールバック: analysis カテゴリは 10 req/min まで許可し、11回目は失敗する', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit');
    const userId = `user-ana-${Date.now()}`;

    const results = [];
    for (let i = 0; i < 11; i++) {
      results.push(await checkRateLimit(userId, 'analysis'));
    }

    expect(results.slice(0, 10).every((r) => r.success)).toBe(true);
    expect(results[10].success).toBe(false);
  });

  it('in-memory フォールバック: image カテゴリは 1 req/min のみ許可し、2回目は失敗する', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit');
    const userId = `user-img-${Date.now()}`;

    const first = await checkRateLimit(userId, 'image');
    const second = await checkRateLimit(userId, 'image');

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
  });

  it('in-memory フォールバック: image カテゴリは分あたり制限とは別に日次20件クォータを課す', async () => {
    vi.useFakeTimers();
    const { checkRateLimit } = await import('@/lib/rate-limit');
    const userId = `user-img-daily-${Date.now()}`;

    const results: boolean[] = [];
    for (let i = 0; i < 21; i++) {
      const result = await checkRateLimit(userId, 'image');
      results.push(result.success);
      // 分あたり制限だけをリセットし、日次クォータの判定を分離して検証する
      vi.advanceTimersByTime(61_000);
    }

    expect(results.slice(0, 20).every((success) => success)).toBe(true);
    expect(results[20]).toBe(false);
  });

  it('ユーザーごとにカウンタが独立している', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit');
    const userA = `user-a-${Date.now()}`;
    const userB = `user-b-${Date.now()}`;

    for (let i = 0; i < 5; i++) {
      expect((await checkRateLimit(userA, 'generation')).success).toBe(true);
    }
    expect((await checkRateLimit(userA, 'generation')).success).toBe(false);
    // userB は userA の上限に影響されない
    expect((await checkRateLimit(userB, 'generation')).success).toBe(true);
  });

  it('rateLimitExceededResponse は 429 と Retry-After ヘッダーを返す', async () => {
    const { checkRateLimit, rateLimitExceededResponse } = await import('@/lib/rate-limit');
    const userId = `user-429-${Date.now()}`;
    await checkRateLimit(userId, 'image');
    const exceeded = await checkRateLimit(userId, 'image');

    const res = rateLimitExceededResponse(exceeded);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('Upstash env 未設定時は db-logger 経由で warn ログを出す', async () => {
    const warnSpy = vi.fn();
    vi.doMock('@/lib/db-logger', () => ({
      createLogger: () => ({ warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));

    await import('@/lib/rate-limit');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('UPSTASH_REDIS_REST_URL'));
  });

  it('Upstash env 設定時はモック Redis 経由の Ratelimit クライアントを使用する', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

    const limitMock = vi
      .fn()
      .mockResolvedValueOnce({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60_000 })
      .mockResolvedValueOnce({ success: false, limit: 5, remaining: 0, reset: Date.now() + 60_000 });

    vi.doMock('@upstash/redis', () => ({
      Redis: class {
        constructor(_opts: unknown) {}
      },
    }));
    vi.doMock('@upstash/ratelimit', () => ({
      Ratelimit: Object.assign(
        class {
          limit = limitMock;
        },
        { slidingWindow: vi.fn(() => ({})) },
      ),
    }));

    const { checkRateLimit } = await import('@/lib/rate-limit');
    const userId = 'user-upstash-1';

    const first = await checkRateLimit(userId, 'generation');
    const second = await checkRateLimit(userId, 'generation');

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(limitMock).toHaveBeenCalledTimes(2);
  });

  it('fail-close: Upstash Redis が例外を throw した場合、success:true に握りつぶさず例外を伝播する', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

    vi.doMock('@upstash/redis', () => ({
      Redis: class {
        constructor(_opts: unknown) {}
      },
    }));
    vi.doMock('@upstash/ratelimit', () => ({
      Ratelimit: Object.assign(
        class {
          limit = vi.fn().mockRejectedValue(new Error('ECONNREFUSED: upstash unreachable'));
        },
        { slidingWindow: vi.fn(() => ({})) },
      ),
    }));

    const { checkRateLimit } = await import('@/lib/rate-limit');

    // fail-open（例外時に success:true を返す）になっていないことを確認する
    await expect(checkRateLimit('user-fail-close-1', 'generation')).rejects.toThrow(
      'ECONNREFUSED',
    );
  });
});

// ─────────────────────────────────────────────
// 2. 実 route の contract テスト（モック Redis = env 未設定で in-memory フォールバック経由）
// ─────────────────────────────────────────────
const mockGetUser = vi.fn();
const mockInvoke = vi.fn();
const mockFrom = vi.fn();
const mockGenerateContent = vi.fn();
const mockUpload = vi.fn();
const mockGetPublicUrl = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    functions: { invoke: mockInvoke },
    from: mockFrom,
    storage: {
      from: vi.fn(() => ({
        upload: mockUpload,
        getPublicUrl: mockGetPublicUrl,
      })),
    },
  })),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: mockGenerateContent,
    };
  },
  createUserContent: vi.fn((parts) => parts),
}));

// health/checkups, health/blood-tests, nutrition-analysis で共有する fast-llm モック
const mockChatCompletionsCreate = vi.fn();

vi.mock('@/lib/ai/fast-llm', () => ({
  getFastLLMClient: () => ({
    chat: { completions: { create: mockChatCompletionsCreate } },
  }),
  getFastLLMModel: () => 'grok-test-model',
}));

// meals / meal-plans/meals の画像生成ジョブトリガーを直接制御するためのモック
const mockBuildDishImagePayload = vi.fn();
const mockEnqueueMealImageJobs = vi.fn();
const mockTriggerMealImageJobProcessing = vi.fn();
const mockCancelPendingMealImageJobs = vi.fn();

vi.mock('@/lib/meal-image-jobs', () => ({
  buildDishImagePayload: (...args: unknown[]) => mockBuildDishImagePayload(...args),
  enqueueMealImageJobs: (...args: unknown[]) => mockEnqueueMealImageJobs(...args),
  triggerMealImageJobProcessing: (...args: unknown[]) => mockTriggerMealImageJobProcessing(...args),
  cancelPendingMealImageJobs: (...args: unknown[]) => mockCancelPendingMealImageJobs(...args),
}));

// select チェーン（.select().eq().gte().lte().order().limit()...）を汎用的にモックするヘルパー。
// 途中の `.eq()`/`.gte()` 等はチェーン自身を返し、`.single()` だけ Promise を返す。
// チェーンの末尾がそのまま await される場合に備え `.data`/`.error` も直接持たせる。
function makeSelectChain(finalValue: { data: any; error: any }) {
  const chain: any = {
    data: finalValue.data,
    error: finalValue.error,
  };
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.gte = vi.fn(() => chain);
  chain.lte = vi.fn(() => chain);
  chain.order = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.upsert = vi.fn(() => chain);
  chain.update = vi.fn(() => chain);
  chain.insert = vi.fn(() => chain);
  chain.single = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

describe('AI route rate limit contracts (#1022)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    resetUpstashEnv();

    mockGetUser.mockResolvedValue({ data: { user: { id: 'rl-user-1' } }, error: null });
    mockUpload.mockResolvedValue({ error: null });
    mockGetPublicUrl.mockReturnValue({ data: { publicUrl: 'https://example.com/generated.png' } });
    process.env.GOOGLE_AI_STUDIO_API_KEY = 'test-key';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.doUnmock('@upstash/redis');
    vi.doUnmock('@upstash/ratelimit');
  });

  it('analyze-weight-scale (analysis): 10 req/min までは 200、11回目は 429 を返す', async () => {
    mockInvoke.mockResolvedValue({
      data: {
        success: true,
        result: {
          type: 'weight_scale',
          values: { weight: 65.2, body_fat_percentage: 18.4, muscle_mass: 48.1 },
          confidence: 0.93,
          raw_text: '65.2',
        },
      },
      error: null,
    });

    const { POST } = await import('../src/app/api/ai/analyze-weight-scale/route');
    const makeRequest = () =>
      new Request('http://localhost/api/ai/analyze-weight-scale', {
        method: 'POST',
        body: JSON.stringify({ image: 'base64-image' }),
      });

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await POST(makeRequest());
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 10)).toEqual(new Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    const body = await (await POST(makeRequest())).json();
    expect(body).toMatchObject({ code: 'RATE_LIMITED' });
    // レート制限超過時は Edge Function を呼ばない（コスト削減の主目的）
    expect(mockInvoke).toHaveBeenCalledTimes(10);
  });

  it('image/generate (image): 1 req/min までは 200、2回目は 429 を返す', async () => {
    mockGenerateContent.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              { text: 'generated' },
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: Buffer.from('png-data').toString('base64'),
                },
              },
            ],
          },
        },
      ],
    });

    const { POST } = await import('../src/app/api/ai/image/generate/route');
    const makeRequest = () =>
      new Request('http://localhost/api/ai/image/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'banana curry' }),
      });

    const first = await POST(makeRequest());
    const second = await POST(makeRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body).toMatchObject({ code: 'RATE_LIMITED' });
    // 429 の場合は Gemini 画像生成 API を呼ばない
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it('consultation session close (generation): 5 req/min までは 200、6回目は 429 を返す', async () => {
    const sessionsChain: any = {
      error: null,
      select: vi.fn(() => sessionsChain),
      eq: vi.fn(() => sessionsChain),
      update: vi.fn(() => sessionsChain),
      single: vi.fn(() =>
        Promise.resolve({
          data: {
            id: 'sess-1',
            user_id: 'rl-user-1',
            status: 'active',
            title: 'AI相談',
            summary: null,
            key_topics: [],
            action_history: [],
            context_snapshot: {},
          },
          error: null,
        }),
      ),
    };
    // メッセージ 0 件 → 要約生成の LLM 呼び出しはスキップされ、レート制限判定のみを検証できる
    const messagesChain: any = {
      data: [],
      error: null,
      select: vi.fn(() => messagesChain),
      eq: vi.fn(() => messagesChain),
      order: vi.fn(() => messagesChain),
    };

    mockFrom.mockImplementation((table: string) => {
      if (table === 'ai_consultation_sessions') return sessionsChain;
      if (table === 'ai_consultation_messages') return messagesChain;
      throw new Error(`unexpected table: ${table}`);
    });

    const { POST } = await import('../src/app/api/ai/consultation/sessions/[sessionId]/close/route');
    const makeRequest = () =>
      new Request('http://localhost/api/ai/consultation/sessions/sess-1/close', { method: 'POST' });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await POST(makeRequest(), { params: { sessionId: 'sess-1' } });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 5)).toEqual(new Array(5).fill(200));
    expect(statuses[5]).toBe(429);
  });

  it('制限内であれば通常どおり 200 を返す（正常系の回帰確認）', async () => {
    mockInvoke.mockResolvedValue({
      data: {
        success: true,
        result: { type: 'weight_scale', values: { weight: 60 }, confidence: 0.9, raw_text: '60' },
      },
      error: null,
    });

    const { POST } = await import('../src/app/api/ai/analyze-weight-scale/route');
    const res = await POST(
      new Request('http://localhost/api/ai/analyze-weight-scale', {
        method: 'POST',
        body: JSON.stringify({ image: 'base64-image' }),
      }),
    );

    expect(res.status).toBe(200);
  });

  it('fail-close (route レベル): Upstash 到達不能(例外)時は image/generate が 500 を返す(429/200 通過にならない)', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

    vi.doMock('@upstash/redis', () => ({
      Redis: class {
        constructor(_opts: unknown) {}
      },
    }));
    vi.doMock('@upstash/ratelimit', () => ({
      Ratelimit: Object.assign(
        class {
          limit = vi.fn().mockRejectedValue(new Error('ECONNREFUSED: upstash unreachable'));
        },
        { slidingWindow: vi.fn(() => ({})) },
      ),
    }));

    const { POST } = await import('../src/app/api/ai/image/generate/route');
    const res = await POST(
      new Request('http://localhost/api/ai/image/generate', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'banana curry' }),
      }),
    );

    // 判定不能時は fail-close: 429(許可)にも200(通過)にもならず、500として拒否される
    expect(res.status).toBe(500);
    expect(res.status).not.toBe(200);
    // 例外伝播により早期returnするため、Gemini 画像生成 API は呼ばれない
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 3. /api/ai 外の LLM 呼び出し route (health/checkups, health/blood-tests) の contract テスト
//    (敵対的レビュー指摘: レビューアラウンド2 で追加保護)
// ─────────────────────────────────────────────
describe('/api/health/* LLM route rate limit contracts (#1022 follow-up)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    resetUpstashEnv();

    mockGetUser.mockResolvedValue({ data: { user: { id: 'rl-user-health' } }, error: null });
    mockChatCompletionsCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'ok',
              concerns: [],
              positives: [],
              recommendations: [],
              riskLevel: 'low',
            }),
          },
        },
      ],
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('health/checkups POST (generation): 5 req/min までは 200、6回目は 429 を返す', async () => {
    // 経年レビュー（2回目の LLM 呼び出し）は checkups 履歴が1件未満ならスキップされるため、
    // health_checkups への select().eq().order() は空配列を返しておく
    const checkupsChain = makeSelectChain({ data: [], error: null });
    checkupsChain.single = vi.fn(() =>
      Promise.resolve({ data: { id: 'checkup-1', checkup_date: '2026-01-01' }, error: null }),
    );
    mockFrom.mockImplementation((table: string) => {
      if (table === 'health_checkups') return checkupsChain;
      throw new Error(`unexpected table: ${table}`);
    });

    const { POST } = await import('../src/app/api/health/checkups/route');
    const makeRequest = () =>
      new Request('http://localhost/api/health/checkups', {
        method: 'POST',
        body: JSON.stringify({ checkup_date: '2026-01-01' }),
      });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await POST(makeRequest());
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 5)).toEqual(new Array(5).fill(200));
    expect(statuses[5]).toBe(429);
    // レート制限超過時は LLM を呼ばない（外部課金抑止が主目的）
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(5);
  });

  it('health/blood-tests POST (generation): 5 req/min までは 200、6回目は 429 を返す', async () => {
    const bloodTestsChain = makeSelectChain({ data: [], error: null });
    bloodTestsChain.single = vi.fn(() =>
      Promise.resolve({ data: { id: 'bt-1', test_date: '2026-01-01' }, error: null }),
    );
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blood_test_results') return bloodTestsChain;
      throw new Error(`unexpected table: ${table}`);
    });

    const { POST } = await import('../src/app/api/health/blood-tests/route');
    const makeRequest = () =>
      new Request('http://localhost/api/health/blood-tests', {
        method: 'POST',
        body: JSON.stringify({ test_date: '2026-01-01' }),
      });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await POST(makeRequest());
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 5)).toEqual(new Array(5).fill(200));
    expect(statuses[5]).toBe(429);
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(5);
  });
});

// ─────────────────────────────────────────────
// 4. 画像生成ジョブの同期トリガー route (meals) の contract テスト
//    (敵対的レビュー指摘: Fable「triggerMealImageJobProcessing が無制限」)
// ─────────────────────────────────────────────
describe('meals route: 画像生成ジョブの同期トリガーは image カテゴリで制限される (#1022 follow-up)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    resetUpstashEnv();

    mockGetUser.mockResolvedValue({ data: { user: { id: 'rl-user-meals' } }, error: null });
    mockBuildDishImagePayload.mockResolvedValue({
      dishes: [{ name: 'カレー', role: 'main' }],
      jobs: [{ dishIndex: 0, subjectHash: 'hash-1', prompt: 'p', model: 'm', referenceImageUrls: [] }],
      mealCoverImageUrl: null,
    });
    mockEnqueueMealImageJobs.mockResolvedValue(undefined);
    mockTriggerMealImageJobProcessing.mockResolvedValue(undefined);
    mockCancelPendingMealImageJobs.mockResolvedValue(undefined);

    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_daily_meals') {
        return {
          upsert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: { id: 'day-1' }, error: null }),
            })),
          })),
        };
      }
      if (table === 'planned_meals') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: { id: 'meal-x', dishes: [] }, error: null }),
            })),
          })),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('meals POST: 画像トリガーは1回/分に制限されるが、献立作成自体(200)は壊れない', async () => {
    const { POST } = await import('../src/app/api/meals/route');
    const makeRequest = () =>
      new Request('http://localhost/api/meals', {
        method: 'POST',
        body: JSON.stringify({
          date: '2026-01-01',
          mealType: 'dinner',
          dishName: 'カレー',
          dishes: [{ name: 'カレー', role: 'main' }],
        }),
      });

    const first = await POST(makeRequest());
    const second = await POST(makeRequest());
    const third = await POST(makeRequest());

    // 献立作成自体は毎回成功する（正常な献立作成フローを壊さない）
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);

    // 画像生成トリガーは image カテゴリ（1回/分）で制限され、2回目以降はスキップされる
    expect(mockTriggerMealImageJobProcessing).toHaveBeenCalledTimes(1);
    // ジョブの enqueue 自体は制限しない（pending のまま残り、後続の正常リクエストで拾われる想定）
    expect(mockEnqueueMealImageJobs).toHaveBeenCalledTimes(3);
  });
});

// ─────────────────────────────────────────────
// 5. nutrition-analysis GET のポーリング退行修正 contract テスト
//    (敵対的レビュー指摘: includeAdvice/includeSuggestion なしの GET まで制限されていた)
// ─────────────────────────────────────────────
describe('nutrition-analysis GET: AI を実際に呼ぶ場合のみレート制限する (#1022 follow-up)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    resetUpstashEnv();

    mockGetUser.mockResolvedValue({ data: { user: { id: 'rl-user-nutrition' } }, error: null });
    mockChatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'バランスの取れた食事を心がけましょう。' } }],
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') {
        return makeSelectChain({
          data: {
            age: 30,
            gender: 'male',
            health_conditions: [],
            medications: [],
            nutrition_goal: 'maintain',
          },
          error: null,
        });
      }
      if (table === 'nutrition_targets') {
        return makeSelectChain({ data: { daily_calories: 2000 }, error: null });
      }
      if (table === 'planned_meals') {
        return makeSelectChain({
          data: [
            {
              calories_kcal: 500,
              protein_g: 20,
              fat_g: 10,
              carbs_g: 60,
              fiber_g: 5,
              sodium_g: 1,
              sugar_g: 5,
              potassium_mg: 100,
              calcium_mg: 100,
              iron_mg: 1,
              vitamin_c_mg: 10,
              vitamin_d_ug: 1,
              cholesterol_mg: 10,
              user_daily_meals: { day_date: '2026-01-01' },
            },
          ],
          error: null,
        });
      }
      throw new Error(`unexpected table: ${table}`);
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('includeAdvice/includeSuggestion なしの場合、20回呼んでも429にならない（ポーリングを壊さない）', async () => {
    const { GET } = await import('../src/app/api/ai/nutrition-analysis/route');
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await GET(new Request('http://localhost/api/ai/nutrition-analysis?period=today'));
      statuses.push(res.status);
    }
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(mockChatCompletionsCreate).not.toHaveBeenCalled();
  });

  it('includeAdvice=true の場合、analysis カテゴリ（10 req/min）で制限される', async () => {
    const { GET } = await import('../src/app/api/ai/nutrition-analysis/route');
    const makeRequest = () =>
      new Request('http://localhost/api/ai/nutrition-analysis?period=today&includeAdvice=true');

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await GET(makeRequest());
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 10)).toEqual(new Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(10);
  });
});
