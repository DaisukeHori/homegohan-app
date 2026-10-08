/**
 * supabase-config.test.ts
 * apps/mobile/src/lib/supabase.ts の環境変数の扱いのテスト (#1182)
 *
 * 以前は、EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY が無いと、https://placeholder.supabase.co と
 * 'placeholder' のキーでクライアントを作り、そのまま起動していた (ログインなどが接続エラーで失敗し続け、原因が分からない)。
 *
 *  - 設定されていれば、その値でクライアントを作る (placeholder は使わない)
 *  - 足りなければ、開発中 (__DEV__) は読み込み時に、足りない変数名を書いた MobileConfigError を投げる
 *  - 足りなければ、リリースビルドはクラッシュさせず、ログを出し、何かを呼んだ瞬間に同じエラーを投げるクライアントにする
 *    (存在しない接続先のクライアントは作らない。画面は app/_layout.tsx が出す)
 *
 * supabase.ts は、環境変数を読み込み時に見る。そのため、テストごとに jest.isolateModules で読み込み直す。
 */

import fs from 'fs';
import path from 'path';

// ── 周辺モジュールのモック ───────────────────────────────────────────────────
jest.mock('react-native-url-polyfill/auto', () => ({}));

const mockCreateClient = jest.fn((url: string, key: string, options: unknown) => ({ kind: 'real-client', url, key, options }));
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: [string, string, unknown]) => mockCreateClient(...args),
}));

const URL_VALUE = 'https://abcdefgh.supabase.co';
const KEY_VALUE = 'anon-key-value-secret-looking';

const globalWithDev = global as unknown as { __DEV__: boolean };
const ORIGINAL_DEV = globalWithDev.__DEV__;

// process.env は差し替えず、同じオブジェクトを書き換えて戻す。jest-expo では `process.env.EXPO_PUBLIC_X` が
// expo/virtual/env 経由の参照に置き換わり、そこは読み込み時の process.env を握り続けるため。
// (jest.isolateModules で読み込み直すたびに、そのときの process.env を握り直す)
const ENV_NAMES = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

type SupabaseModule = typeof import('../../src/lib/supabase');

/** supabase.ts を、いまの環境変数・__DEV__ で読み込み直す */
function loadSupabaseModule(): SupabaseModule {
  let loaded: SupabaseModule | undefined;
  jest.isolateModules(() => {
    loaded = require('../../src/lib/supabase');
  });
  return loaded as SupabaseModule;
}

/** 読み込みで投げられた例外を返す (投げなければ undefined) */
function loadAndCatch(): unknown {
  try {
    loadSupabaseModule();
    return undefined;
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const name of ENV_NAMES) ORIGINAL_ENV[name] = process.env[name];
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (ORIGINAL_ENV[name] === undefined) delete process.env[name];
    else process.env[name] = ORIGINAL_ENV[name];
  }
  globalWithDev.__DEV__ = ORIGINAL_DEV;
  jest.restoreAllMocks();
});

describe('環境変数が設定されているとき', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = URL_VALUE;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = KEY_VALUE;
  });

  it.each([true, false])('__DEV__=%s でも、その URL とキーでクライアントを 1 回だけ作る', (dev) => {
    globalWithDev.__DEV__ = dev;

    const { supabase } = loadSupabaseModule();

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    const [url, key, options] = mockCreateClient.mock.calls[0];
    expect(url).toBe(URL_VALUE);
    expect(key).toBe(KEY_VALUE);
    expect(options).toMatchObject({
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
    });
    expect(supabase).toMatchObject({ kind: 'real-client', url: URL_VALUE, key: KEY_VALUE });
  });

  it('placeholder の接続先やキーは使わない', () => {
    loadSupabaseModule();

    expect(JSON.stringify(mockCreateClient.mock.calls)).not.toMatch(/placeholder/i);
  });
});

describe('必須の環境変数が無いとき (開発中: __DEV__=true)', () => {
  beforeEach(() => {
    globalWithDev.__DEV__ = true;
  });

  it('読み込み時に、足りない変数名を書いた MobileConfigError を投げ、クライアントを作らない', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

    const error = loadAndCatch() as Error & { missing?: string[] };

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MobileConfigError');
    expect(error.message).toContain('EXPO_PUBLIC_SUPABASE_URL');
    expect(error.message).toContain('EXPO_PUBLIC_SUPABASE_ANON_KEY');
    expect(error.missing).toEqual(['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY']);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('片方だけ無ければ、その変数名だけを書く (設定されている方の値は書かない)', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = URL_VALUE;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

    const error = loadAndCatch() as Error;

    expect(error.message).toContain('EXPO_PUBLIC_SUPABASE_ANON_KEY');
    expect(error.message).not.toContain('EXPO_PUBLIC_SUPABASE_URL');
    expect(error.message).not.toContain(URL_VALUE);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('値が空文字でも、未設定として扱って投げる', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = '';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = KEY_VALUE;

    expect((loadAndCatch() as Error).message).toContain('EXPO_PUBLIC_SUPABASE_URL');
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});

describe('必須の環境変数が無いとき (リリースビルド: __DEV__=false)', () => {
  beforeEach(() => {
    globalWithDev.__DEV__ = false;
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  });

  it('クラッシュさせず (読み込みは成功する)、存在しない接続先のクライアントも作らない', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(loadAndCatch()).toBeUndefined();

    expect(mockCreateClient).not.toHaveBeenCalled();
    // 足りない変数名を、端末のログに 1 回残す
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain('[mobile] Missing env: EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY');
  });

  it('クライアントの機能を呼ぼうとした瞬間に、足りない変数名を書いた MobileConfigError を投げる', () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = loadSupabaseModule();

    for (const use of [
      () => supabase.auth,
      () => supabase.from('user_profiles'),
      () => supabase.auth.getSession(),
      () => supabase.rpc('anything'),
    ]) {
      let thrown: (Error & { missing?: string[] }) | undefined;
      try {
        use();
      } catch (error) {
        thrown = error as Error & { missing?: string[] };
      }
      expect(thrown?.name).toBe('MobileConfigError');
      expect(thrown?.message).toContain('EXPO_PUBLIC_SUPABASE_URL');
      expect(thrown?.missing).toEqual(['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY']);
    }
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('await や Promise の解決のような無害な参照 (then・シンボル) では投げない', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase } = loadSupabaseModule();

    expect((supabase as unknown as { then?: unknown }).then).toBeUndefined();
    expect((supabase as unknown as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined();
    await expect(Promise.resolve(supabase)).resolves.toBe(supabase);
  });
});

describe('ソースの確認', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/lib/supabase.ts'), 'utf-8');

  it('placeholder の接続先・キーが残っていない', () => {
    expect(source).not.toMatch(/placeholder/i);
    expect(source).not.toMatch(/\|\|\s*['"]https?:/);
  });

  it('環境変数を直接読まず、env.ts の resolveSupabaseEnv を通している', () => {
    expect(source).not.toContain('process.env');
    expect(source).toContain('resolveSupabaseEnv');
  });
});
