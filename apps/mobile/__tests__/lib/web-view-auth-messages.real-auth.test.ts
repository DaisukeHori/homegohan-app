/**
 * web-view-auth-messages.real-auth.test.ts
 * Web (WebView) からの sign-out / session-expired を処理するときの push token の削除を、
 * 本物の supabase-js (GoTrueClient) と本物の secureSessionStorage で確かめる (#1038 F7-10 / F7-04 のレビュー指摘)
 *
 * なぜモックでは足りないか:
 *   web-view-auth-messages.test.ts は getSession / getUser / signOutWithCleanup を別々にモックしている。
 *   本物の動きでは、次のことが起きて、ログアウトで user_push_tokens の行が消せなくなっていた。
 *     1. Web の signOut() (全端末のセッションを失効) の途中で SIGNED_OUT が出ると、Web は先に session-expired を送り、
 *        そのあとで sign-out を送る (Web の設定・マイページのログアウトの順番)
 *     2. ネイティブは session-expired で getUser() を呼ぶ。サーバーは 403 session_not_found を返し、
 *        auth-js (2.105) はそれを AuthSessionMissingError にして、端末のセッションを消す (_removeSession)
 *     3. auth-js のロックで処理が直列になるため、並行して動く sign-out 側の getSession() は null を受け取る。
 *        ユーザー ID が分からず削除を諦める (skipped)、または削除の通信が anon キーで送られて RLS で 0 行になる
 *        (エラーにならないので「削除できた」ことになる)
 *   そこで、処理の最初にセッション (ユーザー ID とアクセストークン) を控え、失効と分かったあとでも
 *   その値で、本人の JWT を付けて DELETE する。
 *
 * 本物を使うもの: supabase-js / auth-js (GoTrueClient)、secureSessionStorage、signOut.ts、pushNotifications.ts、webViewAuthMessages.ts
 * 差し替えるもの: fetch (Supabase のサーバー役)、expo-secure-store / AsyncStorage (メモリ上。実機に近づけるため数 ms 遅らせる)、
 *                 expo-notifications など端末の機能
 */

// supabase.ts が読み込み時に使う環境変数 (モジュールは loadModules() の中で require して、これより後に読む)
const SUPABASE_URL = 'https://abcdefgh.supabase.co';
const ANON_KEY = 'anon-key-for-tests';
process.env.EXPO_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.EXPO_PUBLIC_WEB_URL = 'https://homegohan-app.vercel.app';

// 本物の supabase-js を何度も読み込み直すので、キャッシュが冷えた CI でも 5 秒の既定を超えないよう広げる
jest.setTimeout(30_000);

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useNavigation: () => ({}),
  useRouter: () => ({ replace: jest.fn() }),
}));
jest.mock('../../src/lib/posthog', () => ({ captureEvent: jest.fn() }));
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  AndroidImportance: { DEFAULT: 3 },
}));
jest.mock('expo-device', () => ({ __esModule: true, isDevice: true }));
jest.mock('expo-constants', () => ({ __esModule: true, default: {} }));

const PAGE = 'https://homegohan-app.vercel.app/settings';
const USER_ID = '0c6a3b7e-1111-4222-8333-944455556666';
const OTHER_USER_ID = '7d1f0a52-aaaa-4bbb-8ccc-1234567890ab';
const THIS_DEVICE_TOKEN = 'ExponentPushToken[this-device]';
const OTHER_DEVICE_TOKEN = 'ExponentPushToken[other-device]';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 条件が満たされるまで待つ (実時間。負荷の高い環境でも固定の待ち時間に頼らない) */
async function waitUntil(condition: () => boolean, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitUntil: timed out');
    await sleep(2);
  }
}

/** 署名の検証はしないので、構造だけ正しい JWT でよい */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.c2lnbmF0dXJl`;
}

function decodeJwtPayload(token: string): { sub?: string; exp?: number; role?: string } | null {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function makeUser(id = USER_ID) {
  return {
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'user@example.com',
    app_metadata: { provider: 'email' },
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  };
}

function makeSession(accessToken: string, refreshToken = 'refresh-token-abcdefghijklmnop') {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: now + 3600,
    expires_in: 3600,
    token_type: 'bearer',
    user: makeUser(),
  };
}

type FetchCall = { method: string; url: string; authorization: string | null; apikey: string | null };

/**
 * Supabase のサーバー役。ここで再現するのは、このテストに関係する次の動きだけ。
 *   - GET  /auth/v1/user   : セッションが失効していれば 403 session_not_found (本物の GoTrue と同じ形)
 *   - POST /auth/v1/logout : 生きていれば失効させて 204。失効済みなら 403 session_not_found
 *   - DELETE /rest/v1/user_push_tokens : PostgREST と同じく、JWT の署名と期限だけを見る (セッションの失効は見ない)。
 *       authenticated の JWT なら RLS (自分の行のみ) を通して削除。anon キーなら RLS で 0 行 (エラーにならない)
 */
function createFakeSupabaseServer() {
  const server = {
    /** Web の signOut() (scope: global) で、サーバー側のセッションが失効した */
    sessionRevoked: false,
    /** GET /auth/v1/user を受けた回数 */
    userRequests: 0,
    /** 解決されるまで GET /auth/v1/user の応答を返さない (応答待ちの最中に別のメッセージを届けるため) */
    userGate: null as Promise<void> | null,
    calls: [] as FetchCall[],
    pushTokenRows: [
      { user_id: USER_ID, expo_push_token: THIS_DEVICE_TOKEN },
      { user_id: USER_ID, expo_push_token: OTHER_DEVICE_TOKEN },
      { user_id: OTHER_USER_ID, expo_push_token: THIS_DEVICE_TOKEN },
    ],
    fetch: undefined as unknown as typeof fetch,
    deleteCalls: () => server.calls.filter((c) => c.method === 'DELETE' && c.url.includes('/rest/v1/user_push_tokens')),
  };

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const sessionNotFound = () =>
    json({ code: 403, error_code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist' }, 403);

  const headerOf = (init: RequestInit | undefined, name: string): string | null => {
    const headers = init?.headers as unknown;
    if (!headers) return null;
    if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
    const found = Object.entries(headers as Record<string, string>).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found ? found[1] : null;
  };

  server.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const authorization = headerOf(init, 'Authorization');
    server.calls.push({ method, url, authorization, apikey: headerOf(init, 'apikey') });

    if (url.includes('/auth/v1/user') && method === 'GET') {
      server.userRequests += 1;
      if (server.userGate) await server.userGate;
      return server.sessionRevoked ? sessionNotFound() : json(makeUser());
    }
    if (url.includes('/auth/v1/logout') && method === 'POST') {
      if (server.sessionRevoked) return sessionNotFound();
      server.sessionRevoked = true;
      return new Response(null, { status: 204 });
    }
    if (url.includes('/auth/v1/token')) {
      return json({ code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }, 400);
    }
    if (url.includes('/rest/v1/user_push_tokens') && method === 'DELETE') {
      const params = new URL(url).searchParams;
      const wantedUser = (params.get('user_id') ?? '').replace(/^eq\./, '');
      const wantedToken = (params.get('expo_push_token') ?? '').replace(/^eq\./, '');
      const claims = decodeJwtPayload((authorization ?? '').replace(/^Bearer /, ''));
      const isAuthenticatedUser = claims?.role === 'authenticated' && typeof claims.exp === 'number' && claims.exp > Date.now() / 1000;
      let deleted = 0;
      if (isAuthenticatedUser) {
        // RLS: 自分の行しか見えない / 消せない
        const before = server.pushTokenRows.length;
        server.pushTokenRows = server.pushTokenRows.filter(
          (row) => !(row.user_id === claims?.sub && row.user_id === wantedUser && row.expo_push_token === wantedToken),
        );
        deleted = before - server.pushTokenRows.length;
      }
      return new Response(null, { status: 204, headers: { 'Content-Range': `*/${deleted}` } });
    }
    return json({}, 404);
  }) as typeof fetch;

  return server;
}

type Modules = {
  supabase: import('@supabase/supabase-js').SupabaseClient;
  SUPABASE_AUTH_STORAGE_KEY: string;
  secureSessionStorage: { setItem: (key: string, value: string) => Promise<void> };
  handleWebAuthMessage: typeof import('../../src/lib/webViewAuthMessages').handleWebAuthMessage;
  AsyncStorage: { getItem: (k: string) => Promise<string | null>; setItem: (k: string, v: string) => Promise<void> };
  captureEvent: jest.Mock;
};

/** 実機に近づけるため、端末のストレージの読み書きを数 ms 遅らせる (処理の割り込みが起きやすくなる) */
function slowDown(target: Record<string, unknown>, methods: string[], ms: number) {
  for (const method of methods) {
    const original = (target[method] as (...args: unknown[]) => Promise<unknown>).bind(target);
    target[method] = async (...args: unknown[]) => {
      await sleep(ms);
      return original(...args);
    };
  }
}

function loadModules(server: ReturnType<typeof createFakeSupabaseServer>): Modules {
  jest.resetModules();
  /* eslint-disable @typescript-eslint/no-require-imports */
  const AsyncStorageModule = require('@react-native-async-storage/async-storage');
  const AsyncStorage = AsyncStorageModule.default ?? AsyncStorageModule;
  const SecureStore = require('expo-secure-store');
  slowDown(AsyncStorage, ['getItem', 'setItem', 'removeItem', 'multiRemove', 'getAllKeys'], 5);
  slowDown(SecureStore, ['getItemAsync', 'setItemAsync', 'deleteItemAsync'], 3);
  SecureStore.__reset();

  // 本物の supabase.ts。supabase-js は呼び出しのたびにグローバルの fetch を引くので、ここで差し替えれば効く
  (globalThis as { fetch: unknown }).fetch = server.fetch;
  const { supabase, SUPABASE_AUTH_STORAGE_KEY } = require('../../src/lib/supabase');
  const { secureSessionStorage } = require('../../src/lib/secureSessionStorage');
  const { handleWebAuthMessage } = require('../../src/lib/webViewAuthMessages');
  const { captureEvent } = require('../../src/lib/posthog');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { supabase, SUPABASE_AUTH_STORAGE_KEY, secureSessionStorage, handleWebAuthMessage, AsyncStorage, captureEvent };
}

function makeDeps() {
  const rebridge = jest.fn();
  const goToWelcome = jest.fn();
  return { deps: { rebridge, goToWelcome, limiter: { tryAcquire: () => true } }, rebridge, goToWelcome };
}

const originalFetch = globalThis.fetch;
let server: ReturnType<typeof createFakeSupabaseServer>;
let m: Modules;
let accessToken: string;

beforeEach(async () => {
  server = createFakeSupabaseServer();
  m = loadModules(server);

  accessToken = makeJwt({ sub: USER_ID, role: 'authenticated', session_id: 'sess-1', exp: Math.floor(Date.now() / 1000) + 3600 });
  // ネイティブのログイン済みの状態: セッションが保管庫にあり、登録済みの push token の値を控えてある
  await m.secureSessionStorage.setItem(m.SUPABASE_AUTH_STORAGE_KEY, JSON.stringify(makeSession(accessToken)));
  await m.AsyncStorage.setItem(`push_token_value_v1:${USER_ID}`, THIS_DEVICE_TOKEN);
  server.calls.length = 0;
});

afterEach(async () => {
  await m.supabase.auth.stopAutoRefresh();
  (globalThis as { fetch: unknown }).fetch = originalFetch;
});

/** サーバー側のこのユーザーの行が、この端末の分だけ消え、他の端末・他のユーザーの行は残っていること */
function expectOnlyThisDeviceRowDeleted() {
  expect(server.pushTokenRows).toEqual([
    { user_id: USER_ID, expo_push_token: OTHER_DEVICE_TOKEN },
    { user_id: OTHER_USER_ID, expo_push_token: THIS_DEVICE_TOKEN },
  ]);
}

/** DELETE が 1 回だけ、本人の JWT を付けて送られたこと (anon キーでは RLS で 0 行になり、エラーにならずに素通りする) */
function expectOneDeleteWithUserJwt() {
  const deletes = server.deleteCalls();
  expect(deletes).toHaveLength(1);
  expect(deletes[0].authorization).toBe(`Bearer ${accessToken}`);
  expect(deletes[0].authorization).not.toBe(`Bearer ${ANON_KEY}`);
  expect(deletes[0].apikey).toBe(ANON_KEY);
}

async function nativeSessionIsGone() {
  const { data } = await m.supabase.auth.getSession();
  return data.session === null;
}

describe('sign-out だけが届いたとき (Web がログアウトの前に知らせる、いまの順番)', () => {
  it('セッションが生きていれば、本人の JWT で DELETE して、ログアウトする', async () => {
    const tab = makeDeps();

    const result = await m.handleWebAuthMessage({ type: 'sign-out' }, PAGE, tab.deps);

    expect(result).toBe('signed-out');
    expectOneDeleteWithUserJwt();
    expectOnlyThisDeviceRowDeleted();
    expect(tab.goToWelcome).toHaveBeenCalledTimes(1);
    expect(await nativeSessionIsGone()).toBe(true);
  });

  it('Web の signOut() が先にサーバーのセッションを失効させていても (403 session_not_found)、本人の JWT で DELETE できる', async () => {
    server.sessionRevoked = true;
    const tab = makeDeps();

    const result = await m.handleWebAuthMessage({ type: 'sign-out' }, PAGE, tab.deps);

    expect(result).toBe('signed-out');
    expectOneDeleteWithUserJwt();
    expectOnlyThisDeviceRowDeleted();
    expect(await nativeSessionIsGone()).toBe(true);
  });

  it('5 つのタブの WebView が同時に sign-out を送ってきても、DELETE もログアウトも 1 回だけ', async () => {
    const tabs = Array.from({ length: 5 }, () => makeDeps());

    await Promise.all(tabs.map((tab) => m.handleWebAuthMessage({ type: 'sign-out' }, PAGE, tab.deps)));

    expectOneDeleteWithUserJwt();
    expectOnlyThisDeviceRowDeleted();
    expect(tabs.reduce((sum, tab) => sum + tab.goToWelcome.mock.calls.length, 0)).toBe(1);
  });
});

describe('session-expired が先に届き、そのあとに sign-out が届くとき (Web の signOut() の途中で SIGNED_OUT が出る順番。レビューで報告された不具合)', () => {
  it('session-expired の getUser() の途中で sign-out が届いても、本人の JWT で DELETE が 1 回送られる', async () => {
    server.sessionRevoked = true; // Web のログアウトで、全端末のセッションが失効済み
    let openGate: () => void = () => {};
    server.userGate = new Promise<void>((resolve) => (openGate = resolve)); // getUser() の応答を止めて、その最中に sign-out を届ける
    const tabA = makeDeps();
    const tabB = makeDeps();

    const sessionExpired = m.handleWebAuthMessage({ type: 'session-expired' }, PAGE, tabA.deps);
    await waitUntil(() => server.userRequests === 1); // getUser() は応答待ち
    const signOut = m.handleWebAuthMessage({ type: 'sign-out' }, PAGE, tabB.deps);
    await sleep(30); // sign-out が、先に動いている getUser() の完了を待ちながら、できるところまで進む時間
    openGate();
    await Promise.all([sessionExpired, signOut]);

    expectOneDeleteWithUserJwt();
    expectOnlyThisDeviceRowDeleted();
    expect(tabA.rebridge).not.toHaveBeenCalled();
    expect(tabA.goToWelcome.mock.calls.length + tabB.goToWelcome.mock.calls.length).toBe(1);
    expect(await nativeSessionIsGone()).toBe(true);
  });

  it('session-expired と sign-out を同時に処理しても (ストレージの読み書きに数 ms かかる実機の状態)、DELETE は本人の JWT で 1 回', async () => {
    server.sessionRevoked = true;
    const tabA = makeDeps();
    const tabB = makeDeps();

    await Promise.all([
      m.handleWebAuthMessage({ type: 'session-expired' }, PAGE, tabA.deps),
      m.handleWebAuthMessage({ type: 'sign-out' }, PAGE, tabB.deps),
    ]);

    expectOneDeleteWithUserJwt();
    expectOnlyThisDeviceRowDeleted();
    expect(tabA.rebridge).not.toHaveBeenCalled();
    expect(tabA.goToWelcome.mock.calls.length + tabB.goToWelcome.mock.calls.length).toBe(1);
    expect(await nativeSessionIsGone()).toBe(true);
  });

  it('逆の順番 (sign-out のあとに session-expired) を同時に処理しても、DELETE は本人の JWT で 1 回で、読み込み直しはしない', async () => {
    server.sessionRevoked = true;
    const tabA = makeDeps();
    const tabB = makeDeps();

    await Promise.all([
      m.handleWebAuthMessage({ type: 'sign-out' }, PAGE, tabA.deps),
      m.handleWebAuthMessage({ type: 'session-expired' }, PAGE, tabB.deps),
    ]);

    expectOneDeleteWithUserJwt();
    expectOnlyThisDeviceRowDeleted();
    expect(tabB.rebridge).not.toHaveBeenCalled();
    expect(await nativeSessionIsGone()).toBe(true);
  });

  it('session-expired の処理が終わってから sign-out が届いても、DELETE は全体で 1 回 (2 回目は消す行も ID も無い)', async () => {
    server.sessionRevoked = true;
    const tab = makeDeps();

    expect(await m.handleWebAuthMessage({ type: 'session-expired' }, PAGE, tab.deps)).toBe('signed-out');
    await m.handleWebAuthMessage({ type: 'sign-out' }, PAGE, tab.deps);

    expectOneDeleteWithUserJwt();
    expectOnlyThisDeviceRowDeleted();
    expect(await nativeSessionIsGone()).toBe(true);
  });
});

describe('session-expired だけが届いたとき', () => {
  it('サーバーで失効していたら (getUser() がセッションを消す)、そのあとのログアウトでも、控えておいた JWT で DELETE する', async () => {
    server.sessionRevoked = true;
    const tab = makeDeps();

    const result = await m.handleWebAuthMessage({ type: 'session-expired' }, PAGE, tab.deps);

    expect(result).toBe('signed-out');
    expectOneDeleteWithUserJwt();
    expectOnlyThisDeviceRowDeleted();
    expect(tab.goToWelcome).toHaveBeenCalledTimes(1);
    expect(tab.rebridge).not.toHaveBeenCalled();
    expect(await nativeSessionIsGone()).toBe(true);
  });

  it('セッションが生きていれば、読み込み直しを頼むだけ: DELETE もログアウトもしない', async () => {
    const tab = makeDeps();

    const result = await m.handleWebAuthMessage({ type: 'session-expired' }, PAGE, tab.deps);

    expect(result).toBe('rebridged');
    expect(server.deleteCalls()).toHaveLength(0);
    expect(tab.rebridge).toHaveBeenCalledTimes(1);
    expect(tab.goToWelcome).not.toHaveBeenCalled();
    expect(await nativeSessionIsGone()).toBe(false);
    expect(server.pushTokenRows).toHaveLength(3);
  });

  it('ネイティブも未ログインなら何もしない (ログアウトが済んだ後に届いた通知など)', async () => {
    const tab = makeDeps();
    await m.handleWebAuthMessage({ type: 'sign-out' }, PAGE, makeDeps().deps);
    server.calls.length = 0;

    const result = await m.handleWebAuthMessage({ type: 'session-expired' }, PAGE, tab.deps);

    expect(result).toBe('no-session');
    expect(server.calls).toEqual([]);
    expect(tab.rebridge).not.toHaveBeenCalled();
  });
});

describe('DELETE が行を消せなかったとき', () => {
  it('0 行だった (RLS に弾かれた・行が既に無い。どちらもエラーにならない) ことを、PostHog に送って観測できる。ログアウトは止めない', async () => {
    server.pushTokenRows = [{ user_id: OTHER_USER_ID, expo_push_token: THIS_DEVICE_TOKEN }];
    const tab = makeDeps();

    await m.handleWebAuthMessage({ type: 'sign-out' }, PAGE, tab.deps);

    expect(server.deleteCalls()).toHaveLength(1);
    expect(m.captureEvent).toHaveBeenCalledWith(
      'push_token_unregister_no_rows',
      expect.objectContaining({ token_source: 'stored' }),
    );
    expect(m.captureEvent).not.toHaveBeenCalledWith('push_token_unregister_failed', expect.anything());
    expect(tab.goToWelcome).toHaveBeenCalledTimes(1);
    expect(await nativeSessionIsGone()).toBe(true);
  });
});
