import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// #1197 お問い合わせ API (POST /api/contact) のレート制限。
// 以前は route が独自に Upstash / in-memory の制限を持っていた。今は共通ヘルパー
// (src/lib/rate-limit.ts) の contact カテゴリ (クライアント IP 単位で 10 回/分) を使う。
// ここでは route が「何を key に、どのカテゴリで」判定するか、超過・判定不能のときに何を返すかを確かめる。
// 共通ヘルパーの限度値そのものは src/__tests__/lib/rate-limit.test.ts で確かめる。

const mockGetUser = vi.fn();
const mockSingle = vi.fn();
const mockSelectAfterInsert = vi.fn(() => ({ single: mockSingle }));
const mockInsert = vi.fn(() => ({ select: mockSelectAfterInsert }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
    from: () => ({ insert: mockInsert }),
  }),
}));

// 構造化ログ。判定不能のときに error ログが残ることを確かめる
const mockLogError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    withUser: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

// 共通レートリミッタは本物 (in-memory フォールバック) を通しつつ、呼び出しの記録と差し替えができるようにする
const mockCheckRateLimit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>();
  mockCheckRateLimit.mockImplementation(actual.checkRateLimit);
  return {
    ...actual,
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  };
});

const { POST } = await import('@/app/api/contact/route');

const TOO_MANY_REQUESTS_MESSAGE = 'リクエストが多すぎます。しばらく時間をおいてからお試しください。';

const validBody = {
  inquiryType: 'general',
  email: 'user@example.com',
  subject: 'テスト件名',
  message: 'テストメッセージ',
};

function makeRequest(headers: Record<string, string>) {
  return new Request('http://localhost/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(validBody),
  }) as any;
}

const fromIp = (ip: string) => makeRequest({ 'x-forwarded-for': ip });

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
  mockSingle.mockResolvedValue({
    data: { id: 'inquiry-1', inquiry_type: 'general', email: 'user@example.com', subject: 's', message: 'm' },
    error: null,
  });
  // 管理者通知メール (Resend) を有効にして、送られないことも確かめられるようにする
  vi.stubEnv('RESEND_API_KEY', 're_test_key');
  vi.stubEnv('ADMIN_NOTIFICATION_EMAIL', 'admin@example.com');
  fetchSpy.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/contact: 判定の key とカテゴリ', () => {
  it('クライアント IP を key に、contact カテゴリで判定する', async () => {
    const res = await POST(fromIp('203.0.113.10'));

    expect(res.status).toBe(200);
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('203.0.113.10', 'contact');
  });

  it('x-forwarded-for に複数の IP があるときは、先頭の IP (前後の空白は除く) で数える', async () => {
    await POST(makeRequest({ 'x-forwarded-for': ' 203.0.113.11 , 70.41.3.18, 10.0.0.1' }));

    expect(mockCheckRateLimit).toHaveBeenCalledWith('203.0.113.11', 'contact');
  });

  it('x-forwarded-for が無ければ x-real-ip で数える', async () => {
    await POST(makeRequest({ 'x-real-ip': '198.51.100.12' }));

    expect(mockCheckRateLimit).toHaveBeenCalledWith('198.51.100.12', 'contact');
  });

  it('どちらのヘッダーも無ければ "unknown" の枠で数える', async () => {
    await POST(makeRequest({}));

    expect(mockCheckRateLimit).toHaveBeenCalledWith('unknown', 'contact');
  });

  it('判定は、リクエスト本文の検証や DB への保存より前に行う', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 30_000,
      windowSec: 60,
    });
    // 本文が壊れていても、先に 429 になる (本文の検証には進まない)
    const res = await POST(
      new Request('http://localhost/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.13' },
        body: '{not json',
      }) as any,
    );

    expect(res.status).toBe(429);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('POST /api/contact: 上限を超えたとき (10 回/分)', () => {
  it('同じ IP からの 11 回目は 429。共通形式の本文と Retry-After を返し、保存も通知メールもしない', async () => {
    const ip = '203.0.113.20';
    for (let i = 0; i < 10; i++) {
      expect((await POST(fromIp(ip))).status).toBe(200);
    }
    expect(mockInsert).toHaveBeenCalledTimes(10);
    expect(fetchSpy).toHaveBeenCalledTimes(10);

    const res = await POST(fromIp(ip));
    const json = await res.json();

    expect(res.status).toBe(429);
    // 画面 (src/app/contact/page.tsx) が読む error の文言は、共通化する前と同じ
    expect(json.error).toBe(TOO_MANY_REQUESTS_MESSAGE);
    expect(json.code).toBe('RATE_LIMITED');
    expect(Number.isInteger(json.retryAfter)).toBe(true);
    expect(json.retryAfter).toBeGreaterThanOrEqual(1);
    expect(json.retryAfter).toBeLessThanOrEqual(60);
    expect(res.headers.get('Retry-After')).toBe(String(json.retryAfter));
    // 429 のリクエストは保存せず、管理者へも通知しない
    expect(mockInsert).toHaveBeenCalledTimes(10);
    expect(fetchSpy).toHaveBeenCalledTimes(10);
  });

  it('別の IP の枠は影響を受けない', async () => {
    const exhausted = '203.0.113.21';
    for (let i = 0; i < 10; i++) {
      await POST(fromIp(exhausted));
    }
    expect((await POST(fromIp(exhausted))).status).toBe(429);

    expect((await POST(fromIp('203.0.113.22'))).status).toBe(200);
  });

  it('x-forwarded-for の先頭が同じなら、後ろの IP が違っても同じ枠で数える', async () => {
    const results: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await POST(makeRequest({ 'x-forwarded-for': `203.0.113.23, 10.0.0.${i}` }));
      results.push(res.status);
    }

    expect(results.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(results[10]).toBe(429);
  });
});

describe('POST /api/contact: 判定できないとき (fail-closed)', () => {
  it('判定が例外を投げたら 500 を返し、保存も通知メールもしない。構造化ログに error を残す', async () => {
    const failure = new Error('ECONNREFUSED: upstash unreachable');
    mockCheckRateLimit.mockRejectedValueOnce(failure);

    const res = await POST(fromIp('203.0.113.30'));
    const json = await res.json();

    // fail-open (通してしまう) にはしない。画面が読める JSON で返す
    expect(res.status).toBe(500);
    expect(json).toEqual({ error: 'サーバーエラーが発生しました' });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('fail-closed'), failure);
  });

  it('次のリクエストは、判定が戻れば通常どおり受け付ける', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('transient'));
    expect((await POST(fromIp('203.0.113.31'))).status).toBe(500);

    expect((await POST(fromIp('203.0.113.31'))).status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });
});
