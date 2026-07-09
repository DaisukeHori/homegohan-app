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
});
