/**
 * web-view-cookie-cleanup.test.ts
 * ネイティブのログアウトで、WebView に残る前の利用者の Cookie を消す (#1612 / #1049 F7-16) のテスト。
 * 中身は apps/mobile/src/lib/webViewUserStorageCleanup.ts の「Cookie」を参照。
 *
 *   1. ログアウトの時点: clearWebViewNativeCookies が React Native の Networking.clearCookies で端末の Cookie の置き場を空にする。
 *      ログアウトの掃除の経路 (clearUserScopedLocalData) から呼ばれる。知らせが来ない・無い・例外でもログアウトを止めない。
 *      完了を待つのは、このあとにサインアウトする経路だけ。起動時に未ログインと決まったとき ({ webViewNativeCookies: 'background' }) と
 *      SIGNED_OUT (clearUserScopedLocalDataAfterSignedOut) は待たない (#1647)
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
import {
  clearUserScopedLocalData,
  clearUserScopedLocalDataAfterSignedOut,
} from '../../src/lib/userScopedLocalData';

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
  type Callback = (result: boolean) => void;
  const networking = Networking as { clearCookies?: (callback: Callback) => void } | undefined;
  const original = networking?.clearCookies;
  /** 知らせを止めておく clearCookies (知らせが来ない端末を真似る)。release() で知らせる */
  let pendingCallbacks: Callback[] = [];
  const clearCookies = jest.fn((callback: Callback) => {
    pendingCallbacks.push(callback);
  });
  const release = (result = true) => {
    const callbacks = pendingCallbacks;
    pendingCallbacks = [];
    for (const callback of callbacks) callback(result);
  };
  /** AsyncStorage の掃除 (await の連鎖) を流しきるのに十分な回数 */
  const FLUSH_MICROTASK_ROUNDS = 50;
  /** 約束が、いまの時点で済んでいるか (マイクロタスクを流しきってから見る) */
  async function isSettled(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    for (let i = 0; i < FLUSH_MICROTASK_ROUNDS; i += 1) await Promise.resolve();
    return settled;
  }

  beforeEach(() => {
    pendingCallbacks = [];
    clearCookies.mockClear();
    if (networking) networking.clearCookies = clearCookies;
  });

  afterEach(() => {
    release();
    if (networking) networking.clearCookies = original;
  });

  it('前提: テストの環境で Networking を差し替えられる', () => {
    expect(networking).toBeDefined();
  });

  it('clearUserScopedLocalData は (既定で) 端末の Cookie の置き場を空にするのを待ってから戻る (ログアウト・退会・起動時の失効の明言)', async () => {
    const pending = clearUserScopedLocalData('user-1');

    expect(await isSettled(pending)).toBe(false);
    expect(clearCookies).toHaveBeenCalledTimes(1);

    release();
    await expect(pending).resolves.toBeUndefined();
  });

  it('{ webViewNativeCookies: "wait" } も同じく待つ', async () => {
    const pending = clearUserScopedLocalData('user-1', { webViewNativeCookies: 'wait' });

    expect(await isSettled(pending)).toBe(false);
    // 最後の段 (Cookie の掃除) まで進んだうえで、その完了を待っている
    expect(clearCookies).toHaveBeenCalledTimes(1);
    release();
    await expect(pending).resolves.toBeUndefined();
  });

  it('{ webViewNativeCookies: "background" } (起動時に未ログインと決まったとき) は、Cookie の掃除を始めるが完了を待たずに戻る', async () => {
    const pending = clearUserScopedLocalData(null, { webViewNativeCookies: 'background' });

    expect(await isSettled(pending)).toBe(true);
    expect(clearCookies).toHaveBeenCalledTimes(1);
    expect(pendingCallbacks).toHaveLength(1);
  });

  it('clearUserScopedLocalDataAfterSignedOut (SIGNED_OUT) は、Cookie の掃除を始めるが完了を待たずに戻る', async () => {
    const pending = clearUserScopedLocalDataAfterSignedOut('user-1');

    expect(await isSettled(pending)).toBe(true);
    expect(clearCookies).toHaveBeenCalledTimes(1);
  });

  it('待たない経路で、知らせが来ず上限の時間が来ても、例外も拒否も外へ出さずログに残すだけ', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await clearUserScopedLocalData(null, { webViewNativeCookies: 'background' });
      expect(warn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(WEB_VIEW_NATIVE_COOKIE_CLEAR_TIMEOUT_MS);
      for (let i = 0; i < FLUSH_MICROTASK_ROUNDS; i += 1) await Promise.resolve();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('could not clear WebView cookies');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      warn.mockRestore();
    }
  });

  it('待たない経路で clearCookies が同期で例外を投げても、例外を外へ出さずログに残すだけ', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearCookies.mockImplementationOnce(() => {
      throw new TypeError('native module missing');
    });
    try {
      await expect(clearUserScopedLocalDataAfterSignedOut('user-1')).resolves.toBeUndefined();
      for (let i = 0; i < FLUSH_MICROTASK_ROUNDS; i += 1) await Promise.resolve();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('消し終わったときはログに残さない', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pending = clearUserScopedLocalData('user-1');
      // 最後の段 (Cookie の掃除) まで進んでから知らせる
      expect(await isSettled(pending)).toBe(false);
      expect(clearCookies).toHaveBeenCalledTimes(1);
      release(true);
      await pending;
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
