/**
 * web-view-cookie-cleanup.test.ts
 * ネイティブのログアウトで、WebView に残る前の利用者の Cookie を消す (#1612 / #1049 F7-16) のテスト。
 * 中身は apps/mobile/src/lib/webViewUserStorageCleanup.ts の「Cookie」を参照。
 *
 *   1. ログアウトの時点: clearWebViewNativeCookies が React Native の Networking.clearCookies で端末の Cookie の置き場を空にする。
 *      ログアウトの掃除の経路 (clearUserScopedLocalData) から呼ばれる。知らせが来ない・無い・例外でもログアウトを止めない
 *   2. 次に WebView を開いたとき: localStorage の掃除と同じ注入の JS が、clearAuthCookies のときだけ
 *      USER_SCOPED_COOKIE_NAME_PREFIXES の接頭辞の Cookie (Supabase の認証の Cookie) を Path=/ で期限切れにする
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Networking } from 'react-native';
import {
  USER_SCOPED_COOKIE_NAME_PREFIXES,
  USER_SCOPED_LOCAL_STORAGE_KEYS,
} from '@homegohan/shared';

const mockSignOut = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  SUPABASE_AUTH_STORAGE_KEY: 'sb-test-auth-token',
  supabase: { auth: { signOut: (...args: unknown[]) => mockSignOut(...args) } },
}));
jest.mock('../../src/lib/pushNotifications', () => ({
  unregisterExpoPushToken: jest.fn(async () => 'deleted'),
}));
jest.mock('../../src/lib/secureSessionStorage', () => ({
  secureSessionStorage: { removeItem: jest.fn(async () => undefined) },
}));

import {
  WEB_VIEW_NATIVE_COOKIE_CLEAR_TIMEOUT_MS,
  WEB_VIEW_STORAGE_CLEARED_MARKER_KEY,
  buildClearUserScopedWebStorageScript,
  clearWebViewNativeCookies,
  resetWebViewUserStorageCleanupForTests,
} from '../../src/lib/webViewUserStorageCleanup';
import { clearUserScopedLocalData } from '../../src/lib/userScopedLocalData';

// ── WebView の localStorage と document.cookie を真似る ──────────────────────

class FakeLocalStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.has(key) ? (this.items.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  get length(): number {
    return this.items.size;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
}

/**
 * document.cookie の読み書きを真似る。Path=/ の Cookie だけを持つ (Web は Path=/ で張る)。
 * 消すには、同じ Path (Path=/) を付けて Max-Age=0 で書く必要がある (Path を省くと今のページの Path の別の Cookie として扱われ、消えない)。
 */
class FakeCookieDocument {
  readonly jar = new Map<string, string>();
  readonly writes: string[] = [];
  failOnRead = false;
  get cookie(): string {
    if (this.failOnRead) throw new Error('SecurityError');
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  set cookie(raw: string) {
    this.writes.push(raw);
    const [pair, ...attributes] = raw.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1);
    const expired = attributes.some((attr) => /^max-age=0$/i.test(attr));
    const rootPath = attributes.some((attr) => /^path=\/$/i.test(attr));
    if (!rootPath) return;
    if (expired) this.jar.delete(name);
    else this.jar.set(name, value);
  }
}

type FakeWebView = { storage: FakeLocalStorage; document: FakeCookieDocument };

function createWebView(): FakeWebView {
  return { storage: new FakeLocalStorage(), document: new FakeCookieDocument() };
}

/** 注入する JS を、偽の window / document の上で走らせる (WebView がページの読み込みの前に走らせるのと同じ) */
function runInWebView(webView: FakeWebView, script: string): void {
  const fakeWindow = { localStorage: webView.storage, dispatchEvent: () => true };
  class FakeEvent {
    constructor(readonly type: string) {}
  }
  // eslint-disable-next-line no-new-func -- 注入する JS の文字列を実際に評価して挙動を確かめるため
  new Function('window', 'Event', 'document', script)(fakeWindow, FakeEvent, webView.document);
}

/** 前の利用者の Web のセッションの Cookie (@supabase/ssr の既定の名前。チャンクと code-verifier を含む) */
const PREVIOUS_USER_AUTH_COOKIES = [
  'sb-abcdefghijklmnop-auth-token',
  'sb-abcdefghijklmnop-auth-token.0',
  'sb-abcdefghijklmnop-auth-token.1',
  'sb-abcdefghijklmnop-auth-token-code-verifier',
];

function fillPreviousUserCookies(webView: FakeWebView): void {
  for (const name of PREVIOUS_USER_AUTH_COOKIES) webView.document.jar.set(name, 'previous-user');
  webView.document.jar.set('is_native_app', '1');
  webView.document.jar.set('unrelated', 'keep');
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest.useRealTimers();
  resetWebViewUserStorageCleanupForTests();
  await AsyncStorage.clear();
  mockSignOut.mockResolvedValue({ error: null });
});

describe('注入する JS の Cookie の掃除 (clearAuthCookies)', () => {
  it('clearAuthCookies のときは、Supabase の認証の Cookie (チャンク・code-verifier を含む) を Path=/ で消し、ほかは残す', () => {
    const webView = createWebView();
    fillPreviousUserCookies(webView);

    runInWebView(webView, buildClearUserScopedWebStorageScript('id-1', { clearAuthCookies: true }));

    expect([...webView.document.jar.keys()].sort()).toEqual(['is_native_app', 'unrelated']);
    for (const write of webView.document.writes) {
      expect(write).toMatch(/Max-Age=0/);
      expect(write).toMatch(/Path=\//);
    }
    expect(webView.document.writes).toHaveLength(PREVIOUS_USER_AUTH_COOKIES.length);
    expect(webView.storage.getItem(WEB_VIEW_STORAGE_CLEARED_MARKER_KEY)).toBe('id-1');
  });

  it('既定 (認証ブリッジで開くとき) は Cookie に触れない (ブリッジがいま張った新しい利用者の Cookie を消さない)', () => {
    const webView = createWebView();
    fillPreviousUserCookies(webView);

    runInWebView(webView, buildClearUserScopedWebStorageScript('id-1'));
    runInWebView(webView, buildClearUserScopedWebStorageScript('id-2', { clearAuthCookies: false }));

    expect(webView.document.writes).toEqual([]);
    expect(webView.document.jar.size).toBe(PREVIOUS_USER_AUTH_COOKIES.length + 2);
  });

  it('同じ掃除は二度しない (次の利用者がログインしてから張った Cookie を、読み込み直しのたびに消さない)', () => {
    const webView = createWebView();
    const script = buildClearUserScopedWebStorageScript('id-1', { clearAuthCookies: true });
    runInWebView(webView, script);

    webView.document.jar.set('sb-abcdefghijklmnop-auth-token', 'next-user');
    runInWebView(webView, script);

    expect(webView.document.jar.get('sb-abcdefghijklmnop-auth-token')).toBe('next-user');
  });

  it('Cookie を読めなくても、localStorage の掃除と済んだ印の書き込みは続ける', () => {
    const webView = createWebView();
    for (const key of USER_SCOPED_LOCAL_STORAGE_KEYS) webView.storage.setItem(key, 'previous-user');
    webView.document.failOnRead = true;

    expect(() =>
      runInWebView(webView, buildClearUserScopedWebStorageScript('id-1', { clearAuthCookies: true })),
    ).not.toThrow();

    expect(USER_SCOPED_LOCAL_STORAGE_KEYS.filter((key) => webView.storage.getItem(key) !== null)).toEqual([]);
    expect(webView.storage.getItem(WEB_VIEW_STORAGE_CLEARED_MARKER_KEY)).toBe('id-1');
  });

  it('名前の前後の空白を除いて判定する (document.cookie は "; " で区切る)', () => {
    const webView = createWebView();
    webView.document.jar.set('a', '1');
    webView.document.jar.set('sb-x-auth-token', 'previous-user');

    runInWebView(webView, buildClearUserScopedWebStorageScript('id-1', { clearAuthCookies: true }));

    expect(webView.document.jar.has('sb-x-auth-token')).toBe(false);
    expect(webView.document.jar.get('a')).toBe('1');
  });

  it('接頭辞の一覧は packages/shared から JSON の文字列で埋め込む (一覧を写さない)', () => {
    expect(USER_SCOPED_COOKIE_NAME_PREFIXES.length).toBeGreaterThan(0);
    expect(buildClearUserScopedWebStorageScript('id-1', { clearAuthCookies: true })).toContain(
      JSON.stringify(USER_SCOPED_COOKIE_NAME_PREFIXES),
    );
  });
});

describe('clearWebViewNativeCookies (ログアウトの時点で端末の Cookie の置き場を空にする)', () => {
  it('ネイティブが true を知らせたら cleared', async () => {
    const clearCookies = jest.fn((callback: (result: boolean) => void) => callback(true));
    await expect(clearWebViewNativeCookies({ clearCookies })).resolves.toBe('cleared');
    expect(clearCookies).toHaveBeenCalledTimes(1);
  });

  it('false (iOS で消す Cookie が無かった) なら nothing', async () => {
    await expect(clearWebViewNativeCookies({ clearCookies: (callback) => callback(false) })).resolves.toBe('nothing');
  });

  it('clearCookies が無い・Networking が無いときは failed (例外を投げない)', async () => {
    await expect(clearWebViewNativeCookies({})).resolves.toBe('failed');
    await expect(clearWebViewNativeCookies(undefined)).resolves.toBe('failed');
  });

  it('clearCookies が例外を投げても failed (例外を投げない)', async () => {
    const clearCookies = () => {
      throw new TypeError('native module missing');
    };
    await expect(clearWebViewNativeCookies({ clearCookies })).resolves.toBe('failed');
  });

  it('知らせが来なければ、上限の時間で failed にして先へ進む (ログアウトを止めない)。あとから来た知らせは無視する', async () => {
    jest.useFakeTimers();
    let late: ((result: boolean) => void) | null = null;
    const pending = clearWebViewNativeCookies({
      clearCookies: (callback) => {
        late = callback;
      },
    });

    jest.advanceTimersByTime(WEB_VIEW_NATIVE_COOKIE_CLEAR_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    jest.advanceTimersByTime(1);
    await expect(pending).resolves.toBe('failed');
    expect(() => late?.(true)).not.toThrow();
  });

  it('知らせが来たら上限の時計を止める (あとで時間が来ても結果は変わらない)', async () => {
    jest.useFakeTimers();
    const result = await clearWebViewNativeCookies({ clearCookies: (callback) => callback(true) });
    expect(result).toBe('cleared');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('アプリの既定 (React Native の Networking) でも例外を投げない (テストの環境のネイティブには clearCookies が無い)', async () => {
    await expect(clearWebViewNativeCookies()).resolves.toEqual(expect.stringMatching(/^(cleared|nothing|failed)$/));
  });
});

describe('ログアウトの掃除の経路 (clearUserScopedLocalData) から Cookie も消す', () => {
  it('clearUserScopedLocalData は、端末の Cookie の置き場を空にするのを待ってから戻る', async () => {
    const networking = Networking;
    const clearCookies = jest.fn((callback: (result: boolean) => void) => callback(true));
    const original = networking?.clearCookies;
    if (networking) networking.clearCookies = clearCookies;
    try {
      await clearUserScopedLocalData('user-1');
    } finally {
      if (networking && original) networking.clearCookies = original;
    }
    expect(clearCookies).toHaveBeenCalledTimes(1);
  });
});
