// @vitest-environment node
/**
 * tests/api/health-route.test.ts
 *
 * #1181: /api/health (死活監視用ヘルスチェック) の route レベル契約テスト。
 *
 *   - GET /api/health          : DB に触れず常に 200。応答は { status, version, time } だけ
 *   - GET /api/health?deep=1   : anon クライアントで subscription_plans を 1 行読む DB 疎通。
 *                                失敗・2 秒超過・設定欠落は 503 { status: 'degraded' }
 *   - HEAD                     : 同じステータスで本文なし
 *   - 全応答が Cache-Control: no-store。応答に秘密・環境変数名・エラー詳細を出さない
 *   - 失敗の原因は構造化ログ (createLogger) にだけ残す
 *
 * Supabase には接続しない (createClient をモック)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SUPABASE_URL = 'https://health-test-project.supabase.co';
const ANON_KEY = 'anon-key-for-health-test';
const SERVICE_ROLE_KEY = 'service-role-key-for-health-test';

// ── @supabase/supabase-js モック ──────────────────────────────────────────────
const mockCreateClient = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

// ── 構造化ログのモック (app_logs へ書かない) ──────────────────────────────────
const mockLoggerError = vi.fn();
const mockCreateLogger = vi.fn((..._args: unknown[]) => ({
  error: mockLoggerError,
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: (...args: unknown[]) => mockCreateLogger(...args),
  generateRequestId: () => 'req_health_test',
}));

// 失敗ログの間引き (モジュール内の状態) をテスト間で持ち越さないよう、テストごとに読み込み直す
type RouteModule = typeof import('../../src/app/api/health/route');
let GET: RouteModule['GET'];
let HEAD: RouteModule['HEAD'];
let dynamic: RouteModule['dynamic'];

type QueryResult = { data: unknown; error: unknown };

/** from().select().limit().retry().abortSignal() の一連の呼び出しを記録しつつ、最後に resolver の結果を返すモック */
function mockSupabaseQuery(resolver: (signal: AbortSignal) => Promise<QueryResult>) {
  const query = {
    select: vi.fn(),
    limit: vi.fn(),
    retry: vi.fn(),
    abortSignal: vi.fn((signal: AbortSignal) => resolver(signal)),
  };
  query.select.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.retry.mockReturnValue(query);
  const from = vi.fn(() => query);
  mockCreateClient.mockReturnValue({ from });
  return { query, from };
}

const ok = (): Promise<QueryResult> => Promise.resolve({ data: [{ id: 'plan-1' }], error: null });

const shallowRequest = () => new Request('http://localhost/api/health');
const deepRequest = (value = '1') => new Request(`http://localhost/api/health?deep=${value}`);

beforeEach(async () => {
  vi.clearAllMocks();
  // 前のテストで設定した戻り値・例外を持ち越さない
  mockCreateClient.mockReset();
  vi.resetModules();
  ({ GET, HEAD, dynamic } = await import('../../src/app/api/health/route'));
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_ROLE_KEY);
  vi.stubEnv('NEXT_PUBLIC_APP_VERSION', 'v9.9.9-test');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('route の設定', () => {
  it('静的化されないよう dynamic = force-dynamic', () => {
    expect(dynamic).toBe('force-dynamic');
  });
});

describe('GET /api/health (浅い確認)', () => {
  it('DB に触れず 200 と { status, version, time } だけを返す', async () => {
    const res = await GET(shallowRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['status', 'time', 'version']);
    expect(body.status).toBe('ok');
    expect(body.version).toBe('v9.9.9-test');
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateLogger).not.toHaveBeenCalled();
  });

  it('time は現在時刻の ISO 8601 文字列', async () => {
    const before = Date.now();
    const body = await (await GET(shallowRequest())).json();
    const after = Date.now();

    expect(new Date(body.time).toISOString()).toBe(body.time);
    expect(new Date(body.time).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(body.time).getTime()).toBeLessThanOrEqual(after);
  });

  it('NEXT_PUBLIC_APP_VERSION が未設定・空でも version は文字列 (unknown)', async () => {
    for (const value of [undefined, '']) {
      vi.stubEnv('NEXT_PUBLIC_APP_VERSION', value);

      const body = await (await GET(shallowRequest())).json();
      expect(body.version).toBe('unknown');
    }
  });

  it('Cache-Control: no-store を付ける (CDN に古い「正常」を返させない)', async () => {
    const res = await GET(shallowRequest());
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('deep の値が 1 / true 以外 (0, 空, 任意文字列) なら浅い確認のまま', async () => {
    for (const value of ['0', '', 'false', 'yes']) {
      const body = await (await GET(deepRequest(value))).json();
      expect(body.checks).toBeUndefined();
    }
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});

describe('GET /api/health?deep=1 (DB 疎通)', () => {
  it('subscription_plans を anon キーで 1 行読めれば 200 / checks.database = ok', async () => {
    const { query, from } = mockSupabaseQuery(ok);

    const res = await GET(deepRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok', version: 'v9.9.9-test', checks: { database: 'ok' } });
    expect(Object.keys(body).sort()).toEqual(['checks', 'status', 'time', 'version']);

    expect(from).toHaveBeenCalledWith('subscription_plans');
    expect(query.select).toHaveBeenCalledWith('id');
    expect(query.limit).toHaveBeenCalledWith(1);
    expect(mockCreateLogger).not.toHaveBeenCalled();
  });

  it('service_role ではなく anon キーで接続する (権限を最小に保つ)', async () => {
    mockSupabaseQuery(ok);

    await GET(deepRequest());

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    const [url, key, options] = mockCreateClient.mock.calls[0];
    expect(url).toBe(SUPABASE_URL);
    expect(key).toBe(ANON_KEY);
    expect(key).not.toBe(SERVICE_ROLE_KEY);
    expect(options).toMatchObject({ auth: { persistSession: false, autoRefreshToken: false } });
  });

  it('自動再試行を切り、2 秒で打ち切る AbortSignal を渡す', async () => {
    const { query } = mockSupabaseQuery(ok);

    await GET(deepRequest());

    expect(query.retry).toHaveBeenCalledWith(false);
    expect(query.abortSignal).toHaveBeenCalledTimes(1);
    expect(query.abortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });

  it('deep=true でも DB 疎通を確認する', async () => {
    mockSupabaseQuery(ok);

    const res = await GET(deepRequest('true'));

    expect((await res.json()).checks).toEqual({ database: 'ok' });
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it('行が 0 件でもエラーが無ければ疎通 OK とみなす (空のマスタで誤報しない)', async () => {
    mockSupabaseQuery(() => Promise.resolve({ data: [], error: null }));

    const res = await GET(deepRequest());

    expect(res.status).toBe(200);
  });

  it('クエリがエラーを返したら 503 / status = degraded。原因は応答に出さずログに残す', async () => {
    mockSupabaseQuery(() =>
      Promise.resolve({
        data: null,
        error: { message: 'permission denied for table subscription_plans', code: '42501' },
      }),
    );

    const res = await GET(deepRequest());

    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ status: 'degraded', checks: { database: 'fail' } });

    // 応答にはエラー詳細・テーブル名・コードを含めない
    const text = JSON.stringify(body);
    expect(text).not.toContain('permission denied');
    expect(text).not.toContain('subscription_plans');
    expect(text).not.toContain('42501');

    // 原因は構造化ログにだけ残る
    expect(mockCreateLogger).toHaveBeenCalledWith('GET /api/health', 'req_health_test');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    const [message, error, metadata] = mockLoggerError.mock.calls[0];
    expect(message).toContain('DB 疎通に失敗');
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('permission denied for table subscription_plans');
    expect(metadata).toMatchObject({ reason: 'query_error', timeout_ms: 2000, code: '42501' });
  });

  it('createClient / クエリが例外を投げても 503 で返す (500 にしない)', async () => {
    mockCreateClient.mockImplementation(() => {
      throw new Error('boom: sensitive internal detail');
    });

    const res = await GET(deepRequest());

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(JSON.stringify(body)).not.toContain('boom');
    expect(mockLoggerError.mock.calls[0][2]).toMatchObject({ reason: 'exception' });
  });

  it.each(['', '   '])('接続設定 (URL / anon キー) が %j なら DB へ行かず 503 (空白だけも未設定。#1434)', async (blank) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', blank);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', blank);

    const res = await GET(deepRequest());

    expect(res.status).toBe(503);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockLoggerError.mock.calls[0][2]).toMatchObject({ reason: 'config_missing' });
    // 環境変数名を応答に出さない
    expect(JSON.stringify(await res.json())).not.toMatch(/SUPABASE|ANON|KEY|URL/i);
  });

  it('2 秒以内に応答が無ければ打ち切って 503 (timeout)', async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    mockSupabaseQuery(
      (signal) =>
        new Promise<QueryResult>((resolve) => {
          capturedSignal = signal;
          // 実際の supabase-js と同じく、abort されると error 付きで resolve する
          signal.addEventListener('abort', () =>
            resolve({ data: null, error: { message: 'AbortError: The user aborted a request.', code: '' } }),
          );
        }),
    );

    const pending = GET(deepRequest());

    await vi.advanceTimersByTimeAsync(1999);
    expect(capturedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(capturedSignal?.aborted).toBe(true);

    const res = await pending;
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe('degraded');
    expect(mockLoggerError.mock.calls[0][2]).toMatchObject({ reason: 'timeout', timeout_ms: 2000 });
  });

  it('DB 障害中に連打されても失敗ログは 60 秒に 1 回へ間引く (応答の 503 は毎回返す)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    mockSupabaseQuery(() => Promise.resolve({ data: null, error: { message: 'down' } }));

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await GET(deepRequest())).status);

    expect(statuses).toEqual([503, 503, 503, 503, 503]);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 59_999);
    await GET(deepRequest());
    expect(mockLoggerError).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 1);
    await GET(deepRequest());
    expect(mockLoggerError).toHaveBeenCalledTimes(2);
  });

  it('応答が速ければ打ち切りタイマーを残さない', async () => {
    vi.useFakeTimers();
    mockSupabaseQuery(ok);

    const res = await GET(deepRequest());

    expect(res.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('秘密情報を応答に出さない', () => {
  it('成功・失敗どちらの応答にも URL・anon キー・service_role キー・環境変数名が含まれない', async () => {
    const texts: string[] = [];

    texts.push(await (await GET(shallowRequest())).text());

    mockSupabaseQuery(ok);
    texts.push(await (await GET(deepRequest())).text());

    mockSupabaseQuery(() => Promise.resolve({ data: null, error: { message: `failed for ${SUPABASE_URL} with ${ANON_KEY}` } }));
    texts.push(await (await GET(deepRequest())).text());

    for (const text of texts) {
      expect(text).not.toContain(SUPABASE_URL);
      expect(text).not.toContain('health-test-project');
      expect(text).not.toContain(ANON_KEY);
      expect(text).not.toContain(SERVICE_ROLE_KEY);
      expect(text).not.toMatch(/SUPABASE|SERVICE_ROLE|process\.env/);
    }
  });
});

describe('HEAD /api/health (UptimeRobot の既定)', () => {
  it('浅い確認: 200 / 本文なし / no-store', async () => {
    const res = await HEAD(shallowRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('deep=1 で DB が正常なら 200', async () => {
    mockSupabaseQuery(ok);

    const res = await HEAD(deepRequest());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('deep=1 で DB に届かなければ 503 (本文なし / no-store)', async () => {
    mockSupabaseQuery(() => Promise.resolve({ data: null, error: { message: 'connection refused' } }));

    const res = await HEAD(deepRequest());

    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
  });
});
