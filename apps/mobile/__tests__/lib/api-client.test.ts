/**
 * api-client.test.ts
 * src/lib/api.ts の getApiBaseUrl() と getApi() をテストする
 *
 * supabase / @homegohan/core はモックで置換する。
 * jest.isolateModules() を使って _api シングルトンをテストごとにリセットする。
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
  createHttpClient: jest.fn((opts: any) => ({ _opts: opts, get: jest.fn(), post: jest.fn() })),
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
});
