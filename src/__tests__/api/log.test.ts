import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Supabase (認証チェック用) クライアントのモック
const mockGetUser = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
  }),
}));

// service_role クライアント (app_logs への insert) のモック
const mockInsert = vi.fn();
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: () => ({ insert: mockInsert }),
  })),
}));

// 回数制限 (#1493)。既定は本物 (Upstash を設定しない in-memory の数え方) をそのまま通し、呼ばれ方を記録する。
// 実行環境に Upstash の設定があっても外の Redis に繋がないよう、モジュールを読み込む前に外す
const rateLimitMocks = vi.hoisted(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  return { checkRateLimit: vi.fn() };
});
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>();
  rateLimitMocks.checkRateLimit.mockImplementation(actual.checkRateLimit);
  return { ...actual, checkRateLimit: rateLimitMocks.checkRateLimit };
});

// rate-limit が読み込み時に残す warn (Upstash 未設定) を、app_logs への insert (mockInsert) に流さない
vi.mock('@/lib/db-logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db-logger')>();
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { ...actual, createLogger: () => ({ ...quiet, withUser: () => quiet }) };
});

const { POST } = await import('@/app/api/log/route');

const validUser = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' };

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({ data: { user: validUser }, error: null });
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
});

describe('POST /api/log (#1044 F6-20)', () => {
  it('正常なリクエストは 200 を返す', async () => {
    const res = await POST(makeRequest({ level: 'info', message: 'hello' }));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('level 未指定は 400 を返す', async () => {
    const res = await POST(makeRequest({ message: 'hello' }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('不正な level (enum 外) は 400 を返す', async () => {
    const res = await POST(makeRequest({ level: 'critical', message: 'hello' }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('2000文字を超える message は 400 を返す', async () => {
    const res = await POST(makeRequest({ level: 'info', message: 'a'.repeat(2001) }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('2000文字ちょうどの message は許可される', async () => {
    const res = await POST(makeRequest({ level: 'info', message: 'a'.repeat(2000) }));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('metadata 内の秘密キーは *** でマスクされて保存される', async () => {
    const res = await POST(
      makeRequest({
        level: 'info',
        message: 'login attempt',
        metadata: { password: 'p@ssw0rd', token: 'abc', note: 'ok' },
      }),
    );

    expect(res.status).toBe(200);
    const insertedArg = mockInsert.mock.calls[0][0];
    expect(insertedArg.metadata.password).toBe('***');
    expect(insertedArg.metadata.token).toBe('***');
    expect(insertedArg.metadata.note).toBe('ok');
  });

  it('message に混入した秘密情報の書式もマスクされて保存される (#1171)', async () => {
    const res = await POST(
      makeRequest({
        level: 'error',
        message: 'login failed password=hunter2 Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      }),
    );

    expect(res.status).toBe(200);
    const insertedArg = mockInsert.mock.calls[0][0];
    expect(insertedArg.message).toBe('login failed password=*** Bearer ***');
    expect(insertedArg.source).toBe('client');
    expect(insertedArg.user_id).toBe(validUser.id);
  });

  it('metadata の文字列の値に混入した秘密情報もマスクされて保存される (#1171)', async () => {
    const res = await POST(
      makeRequest({
        level: 'info',
        message: 'm',
        metadata: { error: 'connect postgresql://u:hunter2@db.example.com/postgres failed', ok: 1 },
      }),
    );

    expect(res.status).toBe(200);
    const insertedArg = mockInsert.mock.calls[0][0];
    expect(insertedArg.metadata).toEqual({ error: 'connect postgresql://u:***@db.example.com/postgres failed', ok: 1 });
  });

  it('metadata を省略したときは metadata なしで保存される', async () => {
    const res = await POST(makeRequest({ level: 'info', message: 'hello' }));

    expect(res.status).toBe(200);
    const insertedArg = mockInsert.mock.calls[0][0];
    expect(insertedArg.metadata).toBeUndefined();
  });

  it('巨大な metadata は切り詰められて保存される', async () => {
    const res = await POST(
      makeRequest({
        level: 'info',
        message: 'huge payload',
        metadata: { blob: 'x'.repeat(20_000) },
      }),
    );

    expect(res.status).toBe(200);
    const insertedArg = mockInsert.mock.calls[0][0];
    expect(insertedArg.metadata._truncated).toBe(true);
  });

  it('未認証リクエストは 401 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });
    const res = await POST(makeRequest({ level: 'info', message: 'hello' }));
    expect(res.status).toBe(401);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('POST /api/log の利用者ごとの回数制限 (#1493)', () => {
  /** in-memory の数え方は利用者ごと。テストごとに別の利用者にして、前のテストの回数を持ち越さない */
  const userOf = (n: number) => ({ id: `b1eebc99-9c0b-4ef8-bb6d-6bb9bd38${String(n).padStart(4, '0')}` });
  const signInAs = (user: { id: string }) => mockGetUser.mockResolvedValue({ data: { user }, error: null });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('L-1: 認証で確定した user.id と client-log の枠で数える (body の値は key に使わない)', async () => {
    const user = userOf(1);
    signInAs(user);

    const res = await POST(makeRequest({ level: 'error', message: 'x', metadata: { user_id: 'someone-else' } }));

    expect(res.status).toBe(200);
    expect(rateLimitMocks.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(rateLimitMocks.checkRateLimit).toHaveBeenCalledWith(user.id, 'client-log');
  });

  it('L-2: 未認証・入力の誤りは、回数を数える前に断る (枠を減らさない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });
    expect((await POST(makeRequest({ level: 'error', message: 'x' }))).status).toBe(401);

    signInAs(userOf(2));
    expect((await POST(makeRequest({ level: 'fatal', message: 'x' }))).status).toBe(400);

    expect(rateLimitMocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('L-3: 境界: 同じ利用者は 1 分に 30 回まで保存され、31 回目は 429 (保存しない)。level を問わず同じ枠で数える', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
    signInAs(userOf(3));

    for (let i = 0; i < 30; i += 1) {
      const res = await POST(makeRequest({ level: i % 2 === 0 ? 'error' : 'info', message: `m${i}` }));
      expect(res.status, `${i + 1} 回目`).toBe(200);
    }
    expect(mockInsert).toHaveBeenCalledTimes(30);

    const blocked = await POST(makeRequest({ level: 'error', message: 'one too many' }));

    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(body.retryAfter).toBeGreaterThanOrEqual(1);
    expect(body.retryAfter).toBeLessThanOrEqual(60);
    expect(blocked.headers.get('Retry-After')).toBe(String(body.retryAfter));
    // 31 回目は保存していない
    expect(mockInsert).toHaveBeenCalledTimes(30);
  });

  it('L-4: 上限に達しても、ほかの利用者は止まらない。60 秒たつと同じ利用者もまた送れる', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T01:00:00Z'));
    const heavy = userOf(4);
    signInAs(heavy);
    for (let i = 0; i < 30; i += 1) await POST(makeRequest({ level: 'error', message: 'x' }));
    expect((await POST(makeRequest({ level: 'error', message: 'x' }))).status).toBe(429);

    signInAs(userOf(5));
    expect((await POST(makeRequest({ level: 'error', message: 'x' }))).status).toBe(200);

    vi.setSystemTime(new Date('2026-10-12T01:01:01Z'));
    signInAs(heavy);
    expect((await POST(makeRequest({ level: 'error', message: 'x' }))).status).toBe(200);
  });

  it('L-5: 回数を判定できない (Upstash が例外を投げた) ときは保存せず 500 (通さない)', async () => {
    signInAs(userOf(6));
    rateLimitMocks.checkRateLimit.mockRejectedValueOnce(new Error('upstash unreachable'));

    const res = await POST(makeRequest({ level: 'error', message: 'x' }));

    expect(res.status).toBe(500);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

