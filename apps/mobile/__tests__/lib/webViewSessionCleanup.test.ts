/**
 * webViewSessionCleanup.test.ts
 * src/lib/webViewSessionCleanup.ts のテスト (#1049 F7-16)
 *
 * WebView の中で実行する JavaScript を、Node の vm に作った偽の window / document で実際に実行して、
 * ログアウトのあとに前のユーザーの Cookie / localStorage / sessionStorage / IndexedDB / Cache Storage が
 * 消えること、1 つの手順が失敗しても残りを続けること、完了を 1 回だけ知らせることを確かめる。
 */

import vm from 'vm';

import {
  WEBVIEW_SESSION_CLEARED_MESSAGE,
  WEBVIEW_SESSION_CLEANUP_HTML,
  WEBVIEW_SESSION_CLEANUP_TIMEOUT_MS,
  buildWebViewSessionCleanupScript,
  isWebViewSessionClearedMessage,
} from '../../src/lib/webViewSessionCleanup';

type FakeEnv = {
  storage: Map<string, string>;
  sessionStorage: Map<string, string>;
  cookies: Map<string, string>;
  deletedDatabases: string[];
  deletedCaches: string[];
  /** 順序の確認用: 'delete-db:name' / 'delete-cache:name' / 'post:<message>' の並び */
  events: string[];
  posted: string[];
};

function mapStorage(map: Map<string, string>, options: { throwOnClear?: boolean } = {}) {
  return {
    clear: () => {
      if (options.throwOnClear) throw new Error('SecurityError');
      map.clear();
    },
  };
}

/** document.cookie の getter / setter を、ブラウザと同じ意味で真似る (Max-Age=0 / 過去の Expires で消える) */
function fakeDocument(cookies: Map<string, string>) {
  return {
    get cookie() {
      return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    set cookie(line: string) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const lowered = attributes.map((a) => a.toLowerCase());
      // Path=/ の Cookie だけを対象にする (Path が違えば消えない、というブラウザの挙動を真似る)
      const targetsRoot = lowered.includes('path=/');
      const expired =
        lowered.includes('max-age=0') || lowered.some((a) => a.startsWith('expires=') && a.includes('1970'));
      if (expired) {
        if (targetsRoot) cookies.delete(name);
      } else {
        cookies.set(name, value);
      }
    },
  };
}

function run(
  options: {
    throwOnLocalStorageClear?: boolean;
    withoutBridge?: boolean;
    withoutIndexedDb?: boolean;
    withoutCaches?: boolean;
    databases?: Array<{ name?: string }>;
    cacheKeys?: string[];
    failingDatabases?: boolean;
  } = {},
) {
  const env: FakeEnv = {
    storage: new Map([['weeklyMenuGenerating', '1'], ['draft', 'x']]),
    sessionStorage: new Map([['s', '1']]),
    cookies: new Map([
      ['sb-abc-auth-token', 'tok'],
      ['sb-abc-auth-token.0', 'chunk0'],
      ['is_native_app', '1'],
    ]),
    deletedDatabases: [],
    deletedCaches: [],
    events: [],
    posted: [],
  };

  const databases = options.databases ?? [{ name: 'app-db' }, { name: 'other-db' }];
  const cacheKeys = options.cacheKeys ?? ['workbox-1', 'next-data'];

  const indexedDB = options.withoutIndexedDb
    ? undefined
    : {
        databases: () => (options.failingDatabases ? Promise.reject(new Error('boom')) : Promise.resolve(databases)),
        deleteDatabase: (name: string) => {
          env.deletedDatabases.push(name);
          env.events.push(`delete-db:${name}`);
          const request: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void } = {};
          // 実機と同じく、削除の完了は少し遅れて届く
          setTimeout(() => request.onsuccess?.(), 0);
          return request;
        },
      };

  const caches = options.withoutCaches
    ? undefined
    : {
        keys: () => Promise.resolve(cacheKeys),
        delete: (name: string) => {
          env.deletedCaches.push(name);
          env.events.push(`delete-cache:${name}`);
          return Promise.resolve(true);
        },
      };

  const window: Record<string, unknown> = {
    localStorage: mapStorage(env.storage, { throwOnClear: options.throwOnLocalStorageClear }),
    sessionStorage: mapStorage(env.sessionStorage),
    indexedDB,
    caches,
    ReactNativeWebView: options.withoutBridge
      ? undefined
      : {
          postMessage: (message: string) => {
            env.posted.push(message);
            env.events.push(`post:${message}`);
          },
        },
  };
  const context = vm.createContext({ window, document: fakeDocument(env.cookies), JSON, Promise, setTimeout });
  const result = vm.runInContext(buildWebViewSessionCleanupScript(), context);
  return { env, result };
}

/** マイクロタスクとタイマーを流して、非同期の後始末を終わらせる */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe('buildWebViewSessionCleanupScript — 前のユーザーの Web 側の状態を消す', () => {
  it('localStorage と sessionStorage を空にする', async () => {
    const { env } = run();
    await flush();

    expect(env.storage.size).toBe(0);
    expect(env.sessionStorage.size).toBe(0);
  });

  it('JavaScript から見える Cookie を全部消す (Supabase のセッション Cookie の分割分と is_native_app を含む)', async () => {
    const { env } = run();
    await flush();

    expect([...env.cookies.keys()]).toEqual([]);
  });

  it('IndexedDB の全データベースと Cache Storage の全キャッシュを消す', async () => {
    const { env } = run();
    await flush();

    expect(env.deletedDatabases).toEqual(['app-db', 'other-db']);
    expect(env.deletedCaches).toEqual(['workbox-1', 'next-data']);
  });

  it('名前の無いデータベースは飛ばす', async () => {
    const { env } = run({ databases: [{ name: undefined }, { name: 'only-db' }] });
    await flush();

    expect(env.deletedDatabases).toEqual(['only-db']);
  });

  it('完了のメッセージを 1 回だけ送る。送るのは IndexedDB / Cache Storage を消し終えたあと', async () => {
    const { env } = run();
    await flush();

    const expected = JSON.stringify({ type: WEBVIEW_SESSION_CLEARED_MESSAGE });
    expect(env.posted).toEqual([expected]);
    // 知らせを受けたアプリは WebView を片付けるので、非同期の削除の途中で知らせてはいけない
    const postIndex = env.events.indexOf(`post:${expected}`);
    expect(postIndex).toBe(env.events.length - 1);
    expect(env.events.slice(0, postIndex).sort()).toEqual(
      ['delete-cache:next-data', 'delete-cache:workbox-1', 'delete-db:app-db', 'delete-db:other-db'].sort(),
    );
  });

  it('最後の式は true (react-native-webview の injectedJavaScript の決まり)', () => {
    const { result } = run();
    expect(result).toBe(true);
  });
});

describe('buildWebViewSessionCleanupScript — 一部が使えなくても止まらない', () => {
  it('localStorage.clear() が例外 (SecurityError) を投げても、Cookie などを消して完了を知らせる', async () => {
    const { env } = run({ throwOnLocalStorageClear: true });
    await flush();

    expect(env.storage.size).toBe(2); // 消せなかった
    expect(env.sessionStorage.size).toBe(0);
    expect([...env.cookies.keys()]).toEqual([]);
    expect(env.posted).toHaveLength(1);
  });

  it('IndexedDB / Cache Storage が無い WebView でも完了を知らせる', async () => {
    const { env } = run({ withoutIndexedDb: true, withoutCaches: true });
    await flush();

    expect(env.storage.size).toBe(0);
    expect(env.posted).toHaveLength(1);
  });

  it('IndexedDB の一覧取得が失敗しても完了を知らせる', async () => {
    const { env } = run({ failingDatabases: true });
    await flush();

    expect(env.deletedCaches).toEqual(['workbox-1', 'next-data']);
    expect(env.posted).toHaveLength(1);
  });

  it('window.ReactNativeWebView が無くても例外を投げない', async () => {
    expect(() => run({ withoutBridge: true })).not.toThrow();
    await flush();
  });
});

describe('isWebViewSessionClearedMessage', () => {
  it('完了のメッセージだけを true にする', () => {
    expect(isWebViewSessionClearedMessage(JSON.stringify({ type: WEBVIEW_SESSION_CLEARED_MESSAGE }))).toBe(true);
  });

  it('ほかのメッセージ・壊れた JSON・文字列でない値は false', () => {
    expect(isWebViewSessionClearedMessage(JSON.stringify({ type: 'tab-navigate' }))).toBe(false);
    expect(isWebViewSessionClearedMessage(JSON.stringify({}))).toBe(false);
    expect(isWebViewSessionClearedMessage('null')).toBe(false);
    expect(isWebViewSessionClearedMessage('not json')).toBe(false);
    expect(isWebViewSessionClearedMessage(undefined)).toBe(false);
    expect(isWebViewSessionClearedMessage({ type: WEBVIEW_SESSION_CLEARED_MESSAGE })).toBe(false);
  });
});

describe('定数', () => {
  it('隠した WebView に渡す HTML はネットワークを使わない文字列で、スクリプトや外部参照を持たない', () => {
    expect(WEBVIEW_SESSION_CLEANUP_HTML).toContain('<body></body>');
    expect(WEBVIEW_SESSION_CLEANUP_HTML).not.toMatch(/<script|src=|href=/i);
  });

  it('待つ上限は数秒 (ログアウト直後の WebView を長く居座らせない)', () => {
    expect(WEBVIEW_SESSION_CLEANUP_TIMEOUT_MS).toBeGreaterThanOrEqual(2000);
    expect(WEBVIEW_SESSION_CLEANUP_TIMEOUT_MS).toBeLessThanOrEqual(10000);
  });
});
