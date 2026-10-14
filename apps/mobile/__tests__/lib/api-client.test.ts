/**
 * api-client.test.ts
 * src/lib/api.ts の getApiBaseUrl() と getApi() をテストする
 *
 * supabase / @homegohan/core はモックで置換する。
 * jest.isolateModules() を使って _api シングルトンをテストごとにリセットする。
 *
 * #1168: 通信できないときの文面と、AI を呼ぶ API (/api/ai/ 以下) の待ち時間・やり直しの指定も確かめる。
 */

// ── supabase モック ──────────────────────────────────────────────────────────
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
}));

// ── @homegohan/core モック ─────────────────────────────────────────────────
// ファクトリ内で jest.fn() を直接生成し、外部変数参照によるホイスティングエラーを避ける
jest.mock('@homegohan/core', () => ({
  createHttpClient: jest.fn((opts: any) => ({
    _opts: opts,
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    del: jest.fn(),
  })),
}));

describe('getApiBaseUrl()', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('EXPO_PUBLIC_API_BASE_URL が設定されていれば値を返す', () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';
    // isolateModules で新鮮なモジュールを取得
    let result: string | undefined;
    jest.isolateModules(() => {
      const { getApiBaseUrl } = require('../../src/lib/api');
      result = getApiBaseUrl();
    });
    expect(result).toBe('https://api.example.com');
  });

  it('EXPO_PUBLIC_API_BASE_URL が未設定なら Error をスロー', () => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    jest.isolateModules(() => {
      const { getApiBaseUrl } = require('../../src/lib/api');
      expect(() => getApiBaseUrl()).toThrow('[mobile] Missing env: EXPO_PUBLIC_API_BASE_URL');
    });
  });

  it.each(['', '   '])('EXPO_PUBLIC_API_BASE_URL が %j (空・空白だけ) でも、未設定として MobileConfigError をスロー (#1434)', (blank) => {
    process.env.EXPO_PUBLIC_API_BASE_URL = blank;
    jest.isolateModules(() => {
      const { getApiBaseUrl } = require('../../src/lib/api');
      let thrown: unknown;
      try {
        getApiBaseUrl();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        name: 'MobileConfigError',
        message: '[mobile] Missing env: EXPO_PUBLIC_API_BASE_URL',
        missing: ['EXPO_PUBLIC_API_BASE_URL'],
      });
    });
  });
});

describe('getApi()', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, EXPO_PUBLIC_API_BASE_URL: 'https://api.example.com' };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('createHttpClient を baseUrl 付きで呼ぶ', () => {
    jest.isolateModules(() => {
      const { createHttpClient } = require('@homegohan/core');
      const { getApi } = require('../../src/lib/api');
      getApi();
      expect(createHttpClient).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://api.example.com' }),
      );
    });
  });

  it('2 回目以降はキャッシュを返す (createHttpClient は 1 回だけ呼ばれる)', () => {
    jest.isolateModules(() => {
      const { createHttpClient } = require('@homegohan/core');
      const { getApi } = require('../../src/lib/api');
      const a = getApi();
      const b = getApi();
      expect(a).toBe(b);
      expect(createHttpClient).toHaveBeenCalledTimes(1);
    });
  });

  it('通信できないときの文面 (「通信できません」) を createHttpClient に渡す', () => {
    jest.isolateModules(() => {
      const { createHttpClient } = require('@homegohan/core');
      const { getApi } = require('../../src/lib/api');
      getApi();
      const { networkErrorMessages } = (createHttpClient as jest.Mock).mock.calls[0][0];
      expect(networkErrorMessages.offline).toContain('通信できません');
      expect(networkErrorMessages.timeout).toContain('通信できません');
    });
  });
});

describe('getApi() — 時間のかかる API (AI を呼ぶ API など) の待ち時間とやり直し (#1168)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, EXPO_PUBLIC_API_BASE_URL: 'https://api.example.com' };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  /** getApi() が返すクライアントと、その下の (モックの) createHttpClient が返したクライアントを取り出す */
  function loadApi() {
    let result: { api: any; inner: any; SLOW_API_TIMEOUT_MS: number } | undefined;
    jest.isolateModules(() => {
      const { createHttpClient } = require('@homegohan/core');
      const { getApi, SLOW_API_TIMEOUT_MS } = require('../../src/lib/api');
      const api = getApi();
      const inner = (createHttpClient as jest.Mock).mock.results[0].value;
      result = { api, inner, SLOW_API_TIMEOUT_MS };
    });
    return result!;
  }

  it('時間のかかる API の待ち時間は、共通クライアントの既定 (20 秒) より長い', () => {
    const { SLOW_API_TIMEOUT_MS } = loadApi();
    expect(SLOW_API_TIMEOUT_MS).toBeGreaterThan(20_000);
  });

  it('AI を呼ぶ POST は、待ち時間を長くし、やり直さない指定を足す', () => {
    const { api, inner, SLOW_API_TIMEOUT_MS } = loadApi();

    api.post('/api/ai/analyze-fridge', { imageUrl: 'https://example.com/a.jpg' });

    expect(inner.post).toHaveBeenCalledWith(
      '/api/ai/analyze-fridge',
      { imageUrl: 'https://example.com/a.jpg' },
      { timeoutMs: SLOW_API_TIMEOUT_MS, retry: false },
    );
  });

  it('AI を呼ぶ GET も、待ち時間を長くし、やり直さない (AI への問い合わせが二重に走らないように)', () => {
    const { api, inner, SLOW_API_TIMEOUT_MS } = loadApi();

    api.get('/api/ai/nutrition-analysis?period=today&includeAdvice=true');
    api.del('/api/ai/consultation/actions/m1/execute');

    expect(inner.get).toHaveBeenCalledWith('/api/ai/nutrition-analysis?period=today&includeAdvice=true', {
      timeoutMs: SLOW_API_TIMEOUT_MS,
      retry: false,
    });
    expect(inner.del).toHaveBeenCalledWith('/api/ai/consultation/actions/m1/execute', {
      timeoutMs: SLOW_API_TIMEOUT_MS,
      retry: false,
    });
  });

  it('先頭の / が無いパスでも、AI を呼ぶ API として扱う', () => {
    const { api, inner, SLOW_API_TIMEOUT_MS } = loadApi();

    api.post('api/ai/classify-photo', {});

    expect(inner.post).toHaveBeenCalledWith('api/ai/classify-photo', {}, { timeoutMs: SLOW_API_TIMEOUT_MS, retry: false });
  });

  it('呼び出し側が timeoutMs / retry を指定していれば、それを優先する', () => {
    const { api, inner } = loadApi();

    api.post('/api/ai/menu/v4/generate', {}, { timeoutMs: 5_000, retry: true });

    expect(inner.post).toHaveBeenCalledWith('/api/ai/menu/v4/generate', {}, { timeoutMs: 5_000, retry: true });
  });

  it('AI 以外の API には、何も足さずにそのまま渡す (既定の 20 秒・GET などのやり直しが効く)', () => {
    const { api, inner } = loadApi();

    api.get('/api/pantry');
    api.post('/api/pantry', { name: 'トマト' });
    api.put('/api/org/settings', { a: 1 }, { timeoutMs: 3_000 });
    api.patch('/api/pantry/1', { name: 'なす' });
    api.del('/api/pantry/1');

    expect(inner.get).toHaveBeenCalledWith('/api/pantry', undefined);
    expect(inner.post).toHaveBeenCalledWith('/api/pantry', { name: 'トマト' }, undefined);
    expect(inner.put).toHaveBeenCalledWith('/api/org/settings', { a: 1 }, { timeoutMs: 3_000 });
    expect(inner.patch).toHaveBeenCalledWith('/api/pantry/1', { name: 'なす' }, undefined);
    expect(inner.del).toHaveBeenCalledWith('/api/pantry/1', undefined);
  });

  it('/api/ai で始まるだけの別のパス (/api/aiming など) は AI 扱いにしない', () => {
    const { api, inner } = loadApi();

    api.get('/api/aiming');

    expect(inner.get).toHaveBeenCalledWith('/api/aiming', undefined);
  });

  it.each([
    '/api/health/blood-tests',
    '/api/health/checkups',
    '/api/health/insights',
    '/api/comparison/trigger',
  ])('/api/ai/ の外でも、保存のあとに AI の結果を待ってから返す POST (%s) は、待ち時間を長くする', (path) => {
    const { api, inner, SLOW_API_TIMEOUT_MS } = loadApi();

    api.post(path, { a: 1 });

    expect(inner.post).toHaveBeenCalledWith(path, { a: 1 }, { timeoutMs: SLOW_API_TIMEOUT_MS, retry: false });
  });

  it('クエリや末尾の / があっても、同じ API として扱う', () => {
    const { api, inner, SLOW_API_TIMEOUT_MS } = loadApi();

    api.post('/api/health/blood-tests/', {});
    api.post('/api/health/insights?force=1', {});

    expect(inner.post).toHaveBeenNthCalledWith(1, '/api/health/blood-tests/', {}, { timeoutMs: SLOW_API_TIMEOUT_MS, retry: false });
    expect(inner.post).toHaveBeenNthCalledWith(2, '/api/health/insights?force=1', {}, { timeoutMs: SLOW_API_TIMEOUT_MS, retry: false });
  });

  it('同じパスでも、一覧の取得 (GET) や、既読にするだけの POST のような速い呼び出しは、既定のままにする', () => {
    const { api, inner } = loadApi();

    api.get('/api/health/blood-tests?limit=20');
    api.get('/api/health/checkups?limit=365');
    api.post('/api/health/insights/abc/read', {});

    expect(inner.get).toHaveBeenNthCalledWith(1, '/api/health/blood-tests?limit=20', undefined);
    expect(inner.get).toHaveBeenNthCalledWith(2, '/api/health/checkups?limit=365', undefined);
    expect(inner.post).toHaveBeenCalledWith('/api/health/insights/abc/read', {}, undefined);
  });

  it('クライアントの返り値 (Promise) をそのまま返す', async () => {
    const { api, inner } = loadApi();
    inner.get.mockResolvedValueOnce({ items: [1] });

    await expect(api.get('/api/pantry')).resolves.toEqual({ items: [1] });
  });
});
