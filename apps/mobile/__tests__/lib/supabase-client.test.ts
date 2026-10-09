/**
 * supabase-client.test.ts
 * apps/mobile/src/lib/supabase.ts のテスト (#1038 F7-06 / F7-07)
 *
 * - セッションの保存先が、平文の AsyncStorage ではなく安全な保管庫の storage になっている
 * - 保存キーは supabase-js の既定 (sb-<ref>-auth-token) のまま = これまでのセッションを読める
 * - 本物の supabase-js (GoTrueClient) と組み合わせても、セッションの保存・読み出し・削除ができる
 */

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-for-tests';

// このテストは各ケースで jest.resetModules() して、supabase.ts と supabase-js を読み直す。
// キャッシュが冷えた CI でも、ケースごとの 5 秒の既定を超えないように上限を広げる
jest.setTimeout(30_000);

type SecureStoreMock = { __reset: () => void; __store: Map<string, string> };

/**
 * モジュールを読み直し (jest.resetModules)、その読み直し後の AsyncStorage / 保管庫のモックを返す。
 * テスト対象のコードが使うのと同じインスタンスを検査するため、import ではなく require で取る。
 */
function loadFresh() {
  jest.resetModules();
  /* eslint-disable @typescript-eslint/no-require-imports */
  const AsyncStorage = require('@react-native-async-storage/async-storage').default ?? require('@react-native-async-storage/async-storage');
  const SecureStore = require('expo-secure-store') as SecureStoreMock;
  /* eslint-enable @typescript-eslint/no-require-imports */
  SecureStore.__reset();
  return { AsyncStorage, SecureStore };
}

/** 署名の検証はしないので、構造だけ正しい JWT でよい */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.c2lnbmF0dXJl`;
}

const USER_ID = '0c6a3b7e-1111-4222-8333-944455556666';

function makeUser() {
  return {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'user@example.com',
    app_metadata: { provider: 'email' },
    user_metadata: { nickname: 'ほめゴハン太郎' },
    created_at: '2026-01-01T00:00:00Z',
  };
}

afterEach(() => {
  jest.dontMock('@supabase/supabase-js');
});

describe('supabase クライアントの設定 (#1038 F7-06)', () => {
  it('auth.storage には安全な保管庫の storage を渡し、AsyncStorage をそのまま渡さない。保存キーは既定のまま', () => {
    const { AsyncStorage } = loadFresh();
    const createClient = jest.fn(() => ({ auth: {} }));
    jest.doMock('@supabase/supabase-js', () => ({ createClient }));

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { SUPABASE_AUTH_STORAGE_KEY } = require('../../src/lib/supabase');
    const { secureSessionStorage } = require('../../src/lib/secureSessionStorage');
    /* eslint-enable @typescript-eslint/no-require-imports */

    expect(createClient).toHaveBeenCalledTimes(1);
    const [url, , options] = createClient.mock.calls[0] as unknown as [string, string, { auth: Record<string, unknown> }];
    expect(url).toBe('https://abcdefgh.supabase.co');
    expect(options.auth.storage).toBe(secureSessionStorage);
    expect(options.auth.storage).not.toBe(AsyncStorage);
    // supabase-js の既定 (sb-<プロジェクト ref>-auth-token) と同じ。これまで保存されたセッションをそのまま読める
    expect(options.auth.storageKey).toBe('sb-abcdefgh-auth-token');
    expect(SUPABASE_AUTH_STORAGE_KEY).toBe('sb-abcdefgh-auth-token');
    expect(options.auth.persistSession).toBe(true);
    expect(options.auth.autoRefreshToken).toBe(true);
    expect(options.auth.detectSessionInUrl).toBe(false);
  });

  it('保存キーは、supabase-js が既定で選ぶキーと一致する (明示しても、これまでのセッションを取りこぼさない)', () => {
    loadFresh();
    jest.dontMock('@supabase/supabase-js');
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { SUPABASE_AUTH_STORAGE_KEY } = require('../../src/lib/supabase');
    const { createClient } = require('@supabase/supabase-js');
    /* eslint-enable @typescript-eslint/no-require-imports */

    // storageKey を渡さずに作ったクライアントの既定キーと比べる
    const defaultClient = createClient('https://abcdefgh.supabase.co', 'anon-key-for-tests');
    expect((defaultClient.auth as unknown as { storageKey: string }).storageKey).toBe(SUPABASE_AUTH_STORAGE_KEY);
  });
});

describe('getStoredSession (#1038 F7-07)', () => {
  it('保存済みのセッションを、検証も更新もせずそのまま返す', async () => {
    loadFresh();
    jest.doMock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({ auth: {} })) }));
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getStoredSession, SUPABASE_AUTH_STORAGE_KEY } = require('../../src/lib/supabase');
    const { secureSessionStorage } = require('../../src/lib/secureSessionStorage');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const stored = {
      access_token: 'expired-access-token',
      refresh_token: 'refresh-token',
      expires_at: 1,
      expires_in: 3600,
      token_type: 'bearer',
      user: makeUser(),
    };
    await secureSessionStorage.setItem(SUPABASE_AUTH_STORAGE_KEY, JSON.stringify(stored));

    expect(await getStoredSession()).toEqual(stored);
  });

  it('保存が無い・壊れている・必要な項目が欠けているときは null', async () => {
    loadFresh();
    jest.doMock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({ auth: {} })) }));
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getStoredSession, SUPABASE_AUTH_STORAGE_KEY } = require('../../src/lib/supabase');
    const { secureSessionStorage } = require('../../src/lib/secureSessionStorage');
    /* eslint-enable @typescript-eslint/no-require-imports */

    expect(await getStoredSession()).toBeNull();

    await secureSessionStorage.setItem(SUPABASE_AUTH_STORAGE_KEY, '{not json');
    expect(await getStoredSession()).toBeNull();

    await secureSessionStorage.setItem(SUPABASE_AUTH_STORAGE_KEY, JSON.stringify({ access_token: 'a', refresh_token: 'r' }));
    expect(await getStoredSession()).toBeNull(); // user が無い
  });
});

describe('本物の supabase-js と組み合わせる (#1038 F7-06)', () => {
  it('setSession → getSession → signOut(local) が動き、トークンは AsyncStorage に残らない', async () => {
    const { AsyncStorage, SecureStore } = loadFresh();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const accessToken = makeJwt({ sub: USER_ID, exp, session_id: 'sess-1', role: 'authenticated', pad: 'x'.repeat(2500) });
    const refreshToken = 'refresh-token-abcdefghijklmnop';

    const fetchMock = jest.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify(makeUser()), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/auth/v1/logout')) {
        return new Response(null, { status: 204 });
      }
      return new Response('{}', { status: 404 });
    });

    // 本物の createClient を使う (モックしない)
    jest.dontMock('@supabase/supabase-js');
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { createClient } = require('@supabase/supabase-js');
    const { secureSessionStorage } = require('../../src/lib/secureSessionStorage');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const client = createClient('https://abcdefgh.supabase.co', 'anon-key-for-tests', {
      auth: {
        storage: secureSessionStorage,
        storageKey: 'sb-abcdefgh-auth-token',
        autoRefreshToken: false,
        persistSession: true,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchMock },
    });

    const set = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    expect(set.error).toBeNull();
    expect(set.data.session?.user.id).toBe(USER_ID);

    // 保存先: 平文の AsyncStorage にトークンは無く、保管庫に分割して置かれている
    const asyncKeys: string[] = await AsyncStorage.getAllKeys();
    for (const key of asyncKeys) {
      const value: string = (await AsyncStorage.getItem(key)) ?? '';
      expect(value).not.toContain(refreshToken);
      expect(value).not.toContain('access_token');
    }
    const secureValues = [...SecureStore.__store.values()];
    expect(secureValues.join('')).toContain(refreshToken);
    for (const value of secureValues) expect(Buffer.byteLength(value, 'utf8')).toBeLessThan(2048);

    // 読み出し
    const got = await client.auth.getSession();
    expect(got.data.session?.access_token).toBe(accessToken);
    expect(got.data.session?.refresh_token).toBe(refreshToken);

    // サインアウト後は保管庫が空になる
    const out = await client.auth.signOut({ scope: 'local' });
    expect(out.error).toBeNull();
    expect(SecureStore.__store.size).toBe(0);
    expect((await client.auth.getSession()).data.session).toBeNull();
  });
});
