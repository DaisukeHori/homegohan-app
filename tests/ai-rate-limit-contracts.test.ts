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

// 同意の判定 (T15 / #1154) は「同意済み」に差し替える。同意が無いときに AI へ送らないことは tests/ai-consent-enforcement-routes.test.ts が実際の route を呼んで確かめる
vi.mock('@/lib/ai/consent-guard', () => import('./helpers/ai-consent-guard-allowed'));
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
  // AI のキュー (weekly_menu_requests / meal_image_jobs) へ書く service role のクライアント (getAiQueueWriter。#1465)。
  // このテストはレート制限の検証が目的なので、利用者のクライアントと同じ表の作り物 (mockFrom) を使う
  getSupabaseAdmin: vi.fn(() => ({ from: mockFrom })),
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

// consultation/actions/execute の case 'generate_day_menu' 等では使うが、
// このテストでは update_meal 経路のみを検証するため固定値でモックする
// (#1148: 機能フラグは feature_flags の isFeatureEnabled。AI 相談の緊急停止スイッチ ai_chat_enabled は ON として答える)
vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: vi.fn(async (key: string) => key === 'ai_chat_enabled'),
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
    const firstBody = await first.json();
    const secondBody = await second.json();

    // 献立作成自体は毎回成功する（正常な献立作成フローを壊さない）
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);

    // 画像生成トリガーは image カテゴリ（1回/分）で制限され、2回目以降はスキップされる
    expect(mockTriggerMealImageJobProcessing).toHaveBeenCalledTimes(1);
    // #1022 round3: rate 超過時は enqueue 自体もスキップし、孤児 pending ジョブを作らない
    // （enqueue と trigger は常にセットで gate される）
    expect(mockEnqueueMealImageJobs).toHaveBeenCalledTimes(1);

    // 1回目は画像生成が実行されるため throttled フラグは付かない
    expect(firstBody).not.toHaveProperty('imageGenerationThrottled');
    // 2回目以降は image 上限超過のため additive に imageGenerationThrottled: true が付与される
    expect(secondBody).toMatchObject({ imageGenerationThrottled: true });
  });

  it('meals POST: 孤児ジョブ防止 — rate 超過時は enqueue 自体が呼ばれない(pending 行を作らない)', async () => {
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

    await POST(makeRequest()); // 1回目: image 上限(1/min)を消費
    mockEnqueueMealImageJobs.mockClear();
    mockTriggerMealImageJobProcessing.mockClear();

    const res = await POST(makeRequest()); // 2回目: rate 超過

    expect(res.status).toBe(200);
    expect(mockEnqueueMealImageJobs).not.toHaveBeenCalled();
    expect(mockTriggerMealImageJobProcessing).not.toHaveBeenCalled();
  });

  it('fail-close 分離: 画像副作用サイトで checkRateLimit が例外を投げても meal 作成は 200 で成功し、画像だけ skip される', async () => {
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

    const { POST } = await import('../src/app/api/meals/route');
    const res = await POST(
      new Request('http://localhost/api/meals', {
        method: 'POST',
        body: JSON.stringify({
          date: '2026-01-01',
          mealType: 'dinner',
          dishName: 'カレー',
          dishes: [{ name: 'カレー', role: 'main' }],
        }),
      }),
    );
    const body = await res.json();

    // 画像副作用サイト限定の緩和: Redis 例外時でも meal 作成自体は 200 で成功する
    expect(res.status).toBe(200);
    expect(body.meal).toBeTruthy();
    expect(body).toMatchObject({ imageGenerationThrottled: true });
    // 例外を検知した時点で画像生成はスキップされ、enqueue/trigger どちらも呼ばれない（孤児防止）
    expect(mockEnqueueMealImageJobs).not.toHaveBeenCalled();
    expect(mockTriggerMealImageJobProcessing).not.toHaveBeenCalled();

    vi.doUnmock('@upstash/redis');
    vi.doUnmock('@upstash/ratelimit');
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

// ─────────────────────────────────────────────
// 6. consultation/actions/execute の update_meal 画像トリガーが image 上限をバイパスしないこと
//    (敵対的レビュー round3 Critical 指摘: generation(5/min) はあるが image(1/min+20/day) を
//     通っておらず、相談チャットの update_meal 連打で image 上限が丸ごとバイパスされていた)
// ─────────────────────────────────────────────
describe('consultation/actions/execute update_meal: 画像トリガーは generation とは別に image 上限も通る (#1022 follow-up)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    resetUpstashEnv();

    mockGetUser.mockResolvedValue({ data: { user: { id: 'rl-user-exec' } }, error: null });
    mockBuildDishImagePayload.mockResolvedValue({
      dishes: [{ name: 'カレー', role: 'main' }],
      jobs: [{ dishIndex: 0, subjectHash: 'hash-1', prompt: 'p', model: 'm', referenceImageUrls: [] }],
      mealCoverImageUrl: null,
    });
    mockEnqueueMealImageJobs.mockResolvedValue(undefined);
    mockTriggerMealImageJobProcessing.mockResolvedValue(undefined);

    const actionLogsChain: any = {
      select: vi.fn(() => actionLogsChain),
      eq: vi.fn(() => actionLogsChain),
      update: vi.fn(() => actionLogsChain),
      single: vi.fn(() =>
        Promise.resolve({
          data: {
            id: 'action-1',
            status: 'pending',
            action_type: 'update_meal',
            action_params: {
              mealId: 'meal-1',
              updates: { dish_name: 'カレー', dishes: [{ name: 'カレー', role: 'main' }] },
            },
            ai_consultation_sessions: { user_id: 'rl-user-exec' },
          },
          error: null,
        }),
      ),
    };

    const plannedMealsChain: any = {
      select: vi.fn(() => plannedMealsChain),
      eq: vi.fn(() => plannedMealsChain),
      update: vi.fn(() => plannedMealsChain),
      maybeSingle: vi.fn(() =>
        Promise.resolve({
          data: {
            id: 'meal-1',
            dish_name: 'old',
            dishes: [],
            image_url: null,
            user_daily_meals: { user_id: 'rl-user-exec' },
          },
          error: null,
        }),
      ),
      single: vi.fn(() =>
        Promise.resolve({
          data: { id: 'meal-1', dish_name: 'カレー', calories_kcal: null, dishes: [{ name: 'カレー', role: 'main' }] },
          error: null,
        }),
      ),
    };

    mockFrom.mockImplementation((table: string) => {
      if (table === 'ai_action_logs') return actionLogsChain;
      if (table === 'planned_meals') return plannedMealsChain;
      throw new Error(`unexpected table: ${table}`);
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('generation(5/min)の枠内でも、2回目以降は image(1/min)超過で画像だけ skip される(DB更新は成功維持)', async () => {
    const { POST } = await import('../src/app/api/ai/consultation/actions/[actionId]/execute/route');
    const makeRequest = () =>
      new Request('http://localhost/api/ai/consultation/actions/action-1/execute', { method: 'POST' });

    const first = await POST(makeRequest(), { params: { actionId: 'action-1' } });
    const second = await POST(makeRequest(), { params: { actionId: 'action-1' } });

    const firstBody = await first.json();
    const secondBody = await second.json();

    // generation(5/min)の枠内なので、DB更新自体は両方とも成功する
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstBody.result).toMatchObject({ mealId: 'meal-1', updated: true });
    expect(secondBody.result).toMatchObject({ mealId: 'meal-1', updated: true });

    // 画像トリガーは image(1/min)で制限され、1回目のみ実行・2回目は skip される
    // (修正前は generation の枠(5/min = 実質数千/日)しか通らず image 上限が丸ごとバイパスされていた)
    expect(mockTriggerMealImageJobProcessing).toHaveBeenCalledTimes(1);
    expect(mockEnqueueMealImageJobs).toHaveBeenCalledTimes(1);

    // 2回目は additive に imageGenerationThrottled: true が付与される
    expect(firstBody.result).not.toHaveProperty('imageGenerationThrottled');
    expect(secondBody.result).toMatchObject({ imageGenerationThrottled: true });
  });
});

// ─────────────────────────────────────────────
// 7. #1163 招待メール・参加リクエスト・譲渡提案メールの送信回数カテゴリ (in-memory フォールバック)
//    限度値 (Standard):
//      family-invite 5/分 + 20/日 / org-invite 10/分 + 200/日 / org-invite-scope 500/日 /
//      child-promotion 5/分 + 10/日 / invite-target 3/日 / transfer-propose 3/分 + 10/日
// ─────────────────────────────────────────────
describe('src/lib/rate-limit.ts 招待メール系カテゴリ (#1163)', () => {
  const MINUTE_MS = 60_000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    resetUpstashEnv();
    vi.doUnmock('@upstash/redis');
    vi.doUnmock('@upstash/ratelimit');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.useRealTimers();
    vi.doUnmock('@upstash/redis');
    vi.doUnmock('@upstash/ratelimit');
  });

  it.each([
    ['family-invite', 5],
    ['org-invite', 10],
    ['child-promotion', 5],
    ['transfer-propose', 3],
  ] as const)('%s: 分あたり %i 回まで許可し、次は windowSec=60 で失敗する', async (category, burst) => {
    const { checkRateLimit } = await import('@/lib/rate-limit');
    const key = `user-burst-${category}`;

    const results = [];
    for (let i = 0; i < burst + 1; i++) {
      results.push(await checkRateLimit(key, category));
    }

    expect(results.slice(0, burst).every((r) => r.success)).toBe(true);
    expect(results[burst].success).toBe(false);
    expect(results[burst].windowSec).toBe(60);
    // 成功時の windowSec は先頭ルール (分あたり) のもの
    expect(results[0].windowSec).toBe(60);
  });

  it.each([
    ['family-invite', 20],
    ['org-invite', 200],
    ['child-promotion', 10],
    ['transfer-propose', 10],
  ] as const)('%s: 日次 %i 回まで許可し、次は windowSec=86400 で失敗する (分あたり制限とは別)', async (category, daily) => {
    vi.useFakeTimers();
    const { checkRateLimit } = await import('@/lib/rate-limit');
    const key = `user-daily-${category}`;

    const results = [];
    for (let i = 0; i < daily + 1; i++) {
      results.push(await checkRateLimit(key, category));
      // 分あたりの枠だけをリセットし、日次クォータの判定を分離して検証する
      vi.advanceTimersByTime(MINUTE_MS + 1_000);
    }

    expect(results.slice(0, daily).every((r) => r.success)).toBe(true);
    expect(results[daily].success).toBe(false);
    expect(results[daily].windowSec).toBe(24 * 60 * 60);
    expect(results[daily].reset).toBeGreaterThan(Date.now());

    // 24 時間たてば日次の枠はリセットされる
    vi.advanceTimersByTime(DAY_MS);
    expect((await checkRateLimit(key, category)).success).toBe(true);
  });

  it('org-invite-scope: 組織あたり 1 日 500 回まで (分あたりの制限は無い)。501 回目は失敗する', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit');
    const orgKey = 'org-scope-1';

    let failures = 0;
    for (let i = 0; i < 500; i++) {
      if (!(await checkRateLimit(orgKey, 'org-invite-scope')).success) failures += 1;
    }
    const over = await checkRateLimit(orgKey, 'org-invite-scope');

    expect(failures).toBe(0);
    expect(over.success).toBe(false);
    expect(over.windowSec).toBe(24 * 60 * 60);
    // 別の組織は影響を受けない
    expect((await checkRateLimit('org-scope-2', 'org-invite-scope')).success).toBe(true);
  });

  it('invite-target: 同じ鍵へは 1 日 3 回まで。4 回目は失敗し、別の鍵は影響を受けない', async () => {
    vi.useFakeTimers();
    const { checkRateLimit } = await import('@/lib/rate-limit');
    const targetKey = 'family-invite:family-1:0123456789abcdef0123456789abcdef';

    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await checkRateLimit(targetKey, 'invite-target'));
      vi.advanceTimersByTime(MINUTE_MS + 1_000);
    }

    expect(results.map((r) => r.success)).toEqual([true, true, true, false]);
    expect(results[3].windowSec).toBe(24 * 60 * 60);
    expect(
      (await checkRateLimit('family-invite:family-1:ffffffffffffffffffffffffffffffff', 'invite-target')).success,
    ).toBe(true);

    vi.advanceTimersByTime(DAY_MS);
    expect((await checkRateLimit(targetKey, 'invite-target')).success).toBe(true);
  });

  it('同じ key でもカテゴリが違えば別々に数える (family-invite の枠を使い切っても org-invite は通る)', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit');
    const key = 'user-shared-key';

    for (let i = 0; i < 5; i++) {
      expect((await checkRateLimit(key, 'family-invite')).success).toBe(true);
    }
    expect((await checkRateLimit(key, 'family-invite')).success).toBe(false);

    expect((await checkRateLimit(key, 'org-invite')).success).toBe(true);
    expect((await checkRateLimit(key, 'child-promotion')).success).toBe(true);
    expect((await checkRateLimit(key, 'transfer-propose')).success).toBe(true);
    // AI 系の枠とも混ざらない
    expect((await checkRateLimit(key, 'generation')).success).toBe(true);
  });

  it('key ごとにカウンタが独立している', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit');

    for (let i = 0; i < 3; i++) {
      expect((await checkRateLimit('user-a', 'transfer-propose')).success).toBe(true);
    }
    expect((await checkRateLimit('user-a', 'transfer-propose')).success).toBe(false);
    expect((await checkRateLimit('user-b', 'transfer-propose')).success).toBe(true);
  });

  it('既存カテゴリにも windowSec が付く (generation/analysis/image は 60、image の日次超過は 86400)', async () => {
    vi.useFakeTimers();
    const { checkRateLimit } = await import('@/lib/rate-limit');

    expect((await checkRateLimit('u-gen', 'generation')).windowSec).toBe(60);
    expect((await checkRateLimit('u-ana', 'analysis')).windowSec).toBe(60);

    let last = await checkRateLimit('u-img', 'image');
    expect(last.windowSec).toBe(60);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(MINUTE_MS + 1_000);
      last = await checkRateLimit('u-img', 'image');
    }
    expect(last.success).toBe(false);
    expect(last.windowSec).toBe(24 * 60 * 60);
  });

  it('超過時の reset は将来の時刻で、getRetryAfterSec は 1 以上の整数秒を返す', async () => {
    const { checkRateLimit, getRetryAfterSec } = await import('@/lib/rate-limit');

    for (let i = 0; i < 3; i++) await checkRateLimit('u-retry', 'transfer-propose');
    const exceeded = await checkRateLimit('u-retry', 'transfer-propose');

    expect(exceeded.success).toBe(false);
    expect(exceeded.reset).toBeGreaterThan(Date.now());
    const retryAfter = getRetryAfterSec(exceeded);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // reset が過去でも 1 秒以上
    expect(getRetryAfterSec({ ...exceeded, reset: Date.now() - 10_000 })).toBe(1);
  });

  it('既存の rateLimitExceededResponse (AI 系の平らな形式) は変えない', async () => {
    const { checkRateLimit, rateLimitExceededResponse } = await import('@/lib/rate-limit');
    await checkRateLimit('u-flat', 'image');
    const exceeded = await checkRateLimit('u-flat', 'image');

    const res = rateLimitExceededResponse(exceeded);
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(body.retryAfter));
    expect(body).toEqual({
      error: 'リクエストが多すぎます。しばらく時間をおいてからお試しください。',
      code: 'RATE_LIMITED',
      retryAfter: body.retryAfter,
    });
  });
});

describe('src/lib/rate-limit.ts in-memory ストアの掃除 (#1163)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    resetUpstashEnv();
    vi.doUnmock('@upstash/redis');
    vi.doUnmock('@upstash/ratelimit');
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.useRealTimers();
  });

  it('件数がしきい値 (10,000) を超えている状態で新しい鍵が来ると、期限切れのエントリだけを掃除する', async () => {
    const { checkRateLimit, getInMemoryStoreSize } = await import('@/lib/rate-limit');

    // generation は 1 回の判定でエントリを 1 つ作る (60 秒ウィンドウ)
    for (let i = 0; i < 10_001; i++) {
      await checkRateLimit(`prune-key-${i}`, 'generation');
    }
    expect(getInMemoryStoreSize()).toBe(10_001);

    // 全エントリの期限が切れてから、新しい鍵で判定する → 掃除されて 1 件だけ残る
    vi.advanceTimersByTime(61_000);
    await checkRateLimit('prune-trigger', 'generation');

    expect(getInMemoryStoreSize()).toBe(1);
  });

  it('期限内のエントリは掃除しない (カウンタが消えて上限が緩むことはない)', async () => {
    const { checkRateLimit, getInMemoryStoreSize } = await import('@/lib/rate-limit');

    for (let i = 0; i < 10_001; i++) {
      await checkRateLimit(`live-key-${i}`, 'generation');
    }
    // しきい値を超えた状態で新しい鍵が来ても、期限内なので何も消えない
    await checkRateLimit('live-trigger', 'generation');
    expect(getInMemoryStoreSize()).toBe(10_002);

    // live-key-0 は 1 回使用済み: あと 4 回で上限 (5 回) に達し、その次は失敗する
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push((await checkRateLimit('live-key-0', 'generation')).success);
    }
    expect(results).toEqual([true, true, true, true, false]);
  });

  it('しきい値以下なら掃除しない (期限切れのエントリは再利用時に上書きされるだけ)', async () => {
    const { checkRateLimit, getInMemoryStoreSize } = await import('@/lib/rate-limit');

    for (let i = 0; i < 100; i++) {
      await checkRateLimit(`small-key-${i}`, 'generation');
    }
    vi.advanceTimersByTime(61_000);
    await checkRateLimit('small-trigger', 'generation');

    expect(getInMemoryStoreSize()).toBe(101);
  });
});

describe('src/lib/rate-limit.ts Upstash 利用時の prefix とウィンドウ (#1163)', () => {
  const constructed: Array<{ prefix: string; limiter: unknown }> = [];
  const slidingWindow = vi.fn((max: number, window: string) => ({ max, window }));
  // すべての Ratelimit インスタンスが共有する limit()。テストごとに挙動を差し替える
  // (同じモジュールへ vi.doMock を重ねて登録すると、どちらが有効になるかが不定になるため 1 回だけ登録する)
  const limitMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    constructed.length = 0;
    slidingWindow.mockClear();
    limitMock.mockReset();
    limitMock.mockResolvedValue({ success: true, limit: 1, remaining: 0, reset: Date.now() + 60_000 });
    process.env = { ...ORIGINAL_ENV };
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
          constructor(opts: { prefix: string; limiter: unknown }) {
            constructed.push(opts);
          }
          limit = limitMock;
        },
        { slidingWindow },
      ),
    }));
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.doUnmock('@upstash/redis');
    vi.doUnmock('@upstash/ratelimit');
  });

  it('既存カテゴリの prefix とウィンドウは変えない (generation / analysis / image / image-daily)', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit');

    await checkRateLimit('u1', 'generation');
    await checkRateLimit('u1', 'analysis');
    await checkRateLimit('u1', 'image');

    expect(constructed.map((c) => c.prefix)).toEqual([
      'homegohan:ai-rl:generation',
      'homegohan:ai-rl:analysis',
      'homegohan:ai-rl:image',
      'homegohan:ai-rl:image-daily',
    ]);
    expect(slidingWindow.mock.calls).toEqual([
      [5, '60 s'],
      [10, '60 s'],
      [1, '60 s'],
      [20, '86400 s'],
    ]);
  });

  it('招待メール系は専用の prefix と、Standard の上限・ウィンドウで Ratelimit を作る', async () => {
    const { checkRateLimit } = await import('@/lib/rate-limit');

    await checkRateLimit('u1', 'family-invite');
    await checkRateLimit('u1', 'org-invite');
    await checkRateLimit('org1', 'org-invite-scope');
    await checkRateLimit('u1', 'child-promotion');
    await checkRateLimit('t1', 'invite-target');
    await checkRateLimit('u1', 'transfer-propose');

    expect(constructed.map((c) => c.prefix)).toEqual([
      'homegohan:ai-rl:family-invite',
      'homegohan:ai-rl:family-invite-daily',
      'homegohan:ai-rl:org-invite',
      'homegohan:ai-rl:org-invite-daily',
      'homegohan:ai-rl:org-invite-scope-daily',
      'homegohan:ai-rl:child-promotion',
      'homegohan:ai-rl:child-promotion-daily',
      'homegohan:ai-rl:invite-target-daily',
      'homegohan:ai-rl:transfer-propose',
      'homegohan:ai-rl:transfer-propose-daily',
    ]);
    expect(slidingWindow.mock.calls).toEqual([
      [5, '60 s'],
      [20, '86400 s'],
      [10, '60 s'],
      [200, '86400 s'],
      [500, '86400 s'],
      [5, '60 s'],
      [10, '86400 s'],
      [3, '86400 s'],
      [3, '60 s'],
      [10, '86400 s'],
    ]);
  });

  it('Upstash でも超過したルールの windowSec を返し、超過した時点で後ろのルールは判定しない', async () => {
    limitMock.mockReset();
    limitMock.mockResolvedValueOnce({ success: false, limit: 5, remaining: 0, reset: Date.now() + 30_000 });

    const { checkRateLimit } = await import('@/lib/rate-limit');
    const result = await checkRateLimit('u1', 'family-invite');

    // 分あたりで止まったら、日次のルールは判定しない
    expect(result.success).toBe(false);
    expect(result.windowSec).toBe(60);
    expect(limitMock).toHaveBeenCalledTimes(1);
  });

  it('Upstash でも分あたりを通ったあと日次で止まれば、日次のウィンドウ秒数を返す', async () => {
    limitMock.mockReset();
    limitMock
      .mockResolvedValueOnce({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60_000 })
      .mockResolvedValueOnce({ success: false, limit: 20, remaining: 0, reset: Date.now() + 3_600_000 });

    const { checkRateLimit } = await import('@/lib/rate-limit');
    const result = await checkRateLimit('u1', 'family-invite');

    expect(result.success).toBe(false);
    expect(result.windowSec).toBe(24 * 60 * 60);
    expect(limitMock).toHaveBeenCalledTimes(2);
  });

  it('fail-close: 招待メール系も Redis が例外を投げたら握りつぶさず伝播する', async () => {
    limitMock.mockReset();
    limitMock.mockRejectedValue(new Error('ECONNREFUSED: upstash unreachable'));

    const { checkRateLimit } = await import('@/lib/rate-limit');

    await expect(checkRateLimit('u1', 'family-invite')).rejects.toThrow('ECONNREFUSED');
    await expect(checkRateLimit('t1', 'invite-target')).rejects.toThrow('ECONNREFUSED');
  });
});
