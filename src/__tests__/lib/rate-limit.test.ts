import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// #1197 共通レートリミッタ (src/lib/rate-limit.ts) の単体テスト。
// ここでは「呼び出し側が決めた key (ユーザー ID 以外も含む) でカテゴリ単位に数える」使い方と、
// お問い合わせフォーム用の contact カテゴリ (クライアント IP 単位で 10 回/分) を確かめる。
// 既存カテゴリ (generation / analysis / image) の限度値と Upstash のモックによる共通の挙動は
// tests/ai-rate-limit-contracts.test.ts、招待メール系の限度値は
// src/__tests__/lib/membership/invite-throttle.in-memory.test.ts で確かめている。

const ORIGINAL_ENV = { ...process.env };

// 構造化ログ。未設定警告の出力先を差し替えて、DB 保存の試行 (SUPABASE_* 未設定のエラー出力) を避ける
const mockLogWarn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
    withUser: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

const MINUTE_MS = 60_000;

type RateLimit = typeof import('@/lib/rate-limit');
let rateLimit: RateLimit;

function useInMemoryFallback() {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  useInMemoryFallback();
  vi.useFakeTimers();
  rateLimit = await import('@/lib/rate-limit');
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
  vi.doUnmock('@upstash/redis');
  vi.doUnmock('@upstash/ratelimit');
});

describe('contact カテゴリ (in-memory フォールバック): key ごとに 10 回/分', () => {
  it('同じ key では 10 回まで通り、11 回目は止まる。残り回数は 9 → 0 と減る', async () => {
    const results = [];
    for (let i = 0; i < 11; i++) {
      results.push(await rateLimit.checkRateLimit('203.0.113.1', 'contact'));
    }

    expect(results.slice(0, 10).map((r) => r.success)).toEqual(new Array(10).fill(true));
    expect(results.slice(0, 10).map((r) => r.remaining)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(results.every((r) => r.limit === 10 && r.windowSec === 60)).toBe(true);
    expect(results[10]).toMatchObject({ success: false, limit: 10, remaining: 0, windowSec: 60 });
  });

  it('止まった結果の reset は、最初のリクエストの 60 秒後', async () => {
    const startedAt = Date.now();
    for (let i = 0; i < 10; i++) {
      await rateLimit.checkRateLimit('203.0.113.2', 'contact');
    }
    vi.advanceTimersByTime(20_000);

    const blocked = await rateLimit.checkRateLimit('203.0.113.2', 'contact');

    expect(blocked.success).toBe(false);
    expect(blocked.reset).toBe(startedAt + MINUTE_MS);
    expect(rateLimit.getRetryAfterSec(blocked)).toBe(40);
  });

  it('60 秒たつと枠が戻り、また 10 回まで通る', async () => {
    for (let i = 0; i < 10; i++) {
      await rateLimit.checkRateLimit('203.0.113.3', 'contact');
    }
    expect((await rateLimit.checkRateLimit('203.0.113.3', 'contact')).success).toBe(false);

    vi.advanceTimersByTime(MINUTE_MS + 1);

    for (let i = 0; i < 10; i++) {
      expect((await rateLimit.checkRateLimit('203.0.113.3', 'contact')).success).toBe(true);
    }
    expect((await rateLimit.checkRateLimit('203.0.113.3', 'contact')).success).toBe(false);
  });

  it('key (クライアント IP) ごとに独立している。IPv6 と "unknown" も 1 つの key として数える', async () => {
    const keys = ['203.0.113.4', '2001:db8::4', 'unknown'];
    for (const key of keys) {
      for (let i = 0; i < 10; i++) {
        expect((await rateLimit.checkRateLimit(key, 'contact')).success).toBe(true);
      }
      expect((await rateLimit.checkRateLimit(key, 'contact')).success).toBe(false);
    }

    // 使い切った key があっても、別の key は新しい枠から始まる
    expect(await rateLimit.checkRateLimit('203.0.113.5', 'contact')).toMatchObject({ success: true, remaining: 9 });
  });

  it('同じ key でも、カテゴリが違えば別々に数える (contact を使い切っても AI 系の枠は残る)', async () => {
    const key = 'shared-key';
    for (let i = 0; i < 10; i++) {
      await rateLimit.checkRateLimit(key, 'contact');
    }
    expect((await rateLimit.checkRateLimit(key, 'contact')).success).toBe(false);

    expect(await rateLimit.checkRateLimit(key, 'analysis')).toMatchObject({ success: true, limit: 10 });
    expect(await rateLimit.checkRateLimit(key, 'generation')).toMatchObject({ success: true, limit: 5 });
  });

  it('逆に、ほかのカテゴリを使い切っても contact の枠は減らない', async () => {
    const key = 'shared-key-2';
    for (let i = 0; i < 10; i++) {
      await rateLimit.checkRateLimit(key, 'analysis');
    }
    expect((await rateLimit.checkRateLimit(key, 'analysis')).success).toBe(false);

    expect(await rateLimit.checkRateLimit(key, 'contact')).toMatchObject({ success: true, remaining: 9 });
  });
});

describe('429 レスポンス (rateLimitExceededResponse): contact が上限を超えたとき', () => {
  async function exceed(key: string) {
    for (let i = 0; i < 10; i++) {
      await rateLimit.checkRateLimit(key, 'contact');
    }
    return rateLimit.checkRateLimit(key, 'contact');
  }

  it('429 と、error / code / retryAfter を持つ JSON を返す。error の文言は共通化する前の contact と同じ', async () => {
    const exceeded = await exceed('203.0.113.10');
    vi.advanceTimersByTime(15_000);

    const res = rateLimit.rateLimitExceededResponse(exceeded);
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body).toEqual({
      error: 'リクエストが多すぎます。しばらく時間をおいてからお試しください。',
      code: 'RATE_LIMITED',
      retryAfter: 45,
    });
  });

  it('Retry-After ヘッダーは、本文の retryAfter と同じ秒数', async () => {
    const exceeded = await exceed('203.0.113.11');
    vi.advanceTimersByTime(15_000);

    const res = rateLimit.rateLimitExceededResponse(exceeded);
    const body = await res.json();

    expect(res.headers.get('Retry-After')).toBe('45');
    expect(res.headers.get('Retry-After')).toBe(String(body.retryAfter));
  });

  it('reset の時刻を過ぎていても、Retry-After は 1 秒未満にならない (最小 1 秒)', async () => {
    const exceeded = await exceed('203.0.113.12');
    vi.advanceTimersByTime(MINUTE_MS + 5_000);

    const res = rateLimit.rateLimitExceededResponse(exceeded);
    const body = await res.json();

    expect(res.headers.get('Retry-After')).toBe('1');
    expect(body.retryAfter).toBe(1);
  });
});

describe('contact カテゴリ (Upstash 設定時)', () => {
  const limitMock = vi.fn();
  const slidingWindowMock = vi.fn((..._args: unknown[]) => ({ kind: 'sliding-window' }));
  const ratelimitConstructorMock = vi.fn();

  async function loadWithUpstash() {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

    vi.resetModules();
    vi.doMock('@upstash/redis', () => ({
      Redis: class {
        constructor(_options: unknown) {}
      },
    }));
    vi.doMock('@upstash/ratelimit', () => ({
      Ratelimit: Object.assign(
        class {
          limit = limitMock;
          constructor(options: unknown) {
            ratelimitConstructorMock(options);
          }
        },
        { slidingWindow: slidingWindowMock },
      ),
    }));
    return import('@/lib/rate-limit');
  }

  beforeEach(() => {
    limitMock.mockReset();
    slidingWindowMock.mockClear();
    ratelimitConstructorMock.mockClear();
  });

  it('Upstash の sliding window (10 回 / 60 秒) を使い、key (IP) をそのまま渡す', async () => {
    const reset = Date.now() + 30_000;
    limitMock.mockResolvedValueOnce({ success: true, limit: 10, remaining: 7, reset });
    const { checkRateLimit } = await loadWithUpstash();

    const result = await checkRateLimit('203.0.113.20', 'contact');

    expect(slidingWindowMock).toHaveBeenCalledTimes(1);
    expect(slidingWindowMock).toHaveBeenCalledWith(10, '60 s');
    expect(ratelimitConstructorMock).toHaveBeenCalledTimes(1);
    expect(ratelimitConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'homegohan:ai-rl:contact', limiter: { kind: 'sliding-window' } }),
    );
    expect(limitMock).toHaveBeenCalledWith('203.0.113.20');
    expect(result).toEqual({ success: true, limit: 10, remaining: 7, reset, windowSec: 60 });
  });

  it('Upstash が超過と答えたら success: false で返す (in-memory の数え方には切り替わらない)', async () => {
    const reset = Date.now() + 10_000;
    limitMock.mockResolvedValueOnce({ success: false, limit: 10, remaining: 0, reset });
    const { checkRateLimit, getRetryAfterSec } = await loadWithUpstash();

    const result = await checkRateLimit('203.0.113.21', 'contact');

    expect(result).toMatchObject({ success: false, remaining: 0, windowSec: 60 });
    expect(getRetryAfterSec(result)).toBe(10);
  });

  it('同じ設定の Ratelimit は 1 つだけ作り、リクエストごとに作り直さない', async () => {
    limitMock.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 60_000 });
    const { checkRateLimit } = await loadWithUpstash();

    await checkRateLimit('203.0.113.22', 'contact');
    await checkRateLimit('203.0.113.23', 'contact');

    expect(ratelimitConstructorMock).toHaveBeenCalledTimes(1);
    expect(limitMock).toHaveBeenCalledTimes(2);
  });

  it('fail-closed: Upstash が例外を投げたら success: true に握りつぶさず、例外をそのまま伝播する', async () => {
    const failure = new Error('ECONNREFUSED: upstash unreachable');
    limitMock.mockRejectedValueOnce(failure);
    const { checkRateLimit } = await loadWithUpstash();

    await expect(checkRateLimit('203.0.113.24', 'contact')).rejects.toBe(failure);
  });
});

describe('Upstash 未設定 (in-memory フォールバック)', () => {
  it('モジュールの読み込み時に、未設定であることを warn ログに残す (fail-open にはしない)', async () => {
    // beforeEach で読み込み済み。ログは import の副作用なので、その呼び出しを確かめる
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining('UPSTASH_REDIS_REST_URL'));

    // 未設定でも判定は動き、上限を超えたら止まる (無制限に通さない)
    for (let i = 0; i < 10; i++) {
      expect((await rateLimit.checkRateLimit('203.0.113.30', 'contact')).success).toBe(true);
    }
    expect((await rateLimit.checkRateLimit('203.0.113.30', 'contact')).success).toBe(false);
  });
});
