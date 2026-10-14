/**
 * web-view-user-storage-cleanup.test.ts
 * apps/mobile/src/lib/webViewUserStorageCleanup.ts と、ネイティブのログアウト・退会 (signOut.ts) のつなぎのテスト (#1037)
 *
 * アプリの中のログアウト・退会はネイティブの設定画面だけで行う。Web の画面のログアウトがしていた
 * 利用者別の localStorage の掃除 (clearUserScopedLocalStorage) を通らないので、ネイティブが「掃除の ID」を持ち、
 * 次に WebView を開いたとき、Web のページが読み込まれる前に注入する JS で消す。
 *
 * ここでは注入する JS を、localStorage を持つ偽の window の上で実際に走らせて、
 *   - ネイティブのログアウト (signOutOnDevice)・退会 (signOutAfterAccountDeletion) のあと、利用者別のキーが WebView に残らない
 *   - 一覧 (packages/shared の USER_SCOPED_LOCAL_STORAGE_KEYS) のキーをすべて消す (一覧に足したキーも自動で消える)
 *   - 同じ掃除は二度しない (次の利用者がログインしてから書いた値を、読み込み直しのたびに消さない)
 * を確かめる。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { USER_SCOPED_LOCAL_STORAGE_KEYS, USER_SCOPED_STORAGE_CLEARED_EVENT } from '@homegohan/shared';

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
  WEB_VIEW_STORAGE_CLEAR_REQUEST_KEY,
  WEB_VIEW_STORAGE_CLEARED_MARKER_KEY,
  buildClearUserScopedWebStorageScript,
  readPendingWebViewUserScopedStorageClear,
  requestWebViewUserScopedStorageClear,
  resetWebViewUserStorageCleanupForTests,
} from '../../src/lib/webViewUserStorageCleanup';
import { signOutAfterAccountDeletion, signOutOnDevice, signOutWithCleanup } from '../../src/lib/signOut';

// ── WebView の localStorage を真似る ─────────────────────────────────────────

class FakeLocalStorage {
  readonly items = new Map<string, string>();
  failRemove = false;
  getItem(key: string): string | null {
    return this.items.has(key) ? (this.items.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    if (this.failRemove) throw new Error('SecurityError');
    this.items.delete(key);
  }
}

type FakeWebView = { storage: FakeLocalStorage; events: string[] };

function createWebView(): FakeWebView {
  return { storage: new FakeLocalStorage(), events: [] };
}

/** 注入する JS を、偽の window の上で走らせる (WebView がページの読み込みの前に走らせるのと同じ) */
function runInWebView(webView: FakeWebView, script: string): void {
  const fakeWindow = {
    localStorage: webView.storage,
    dispatchEvent: (event: { type: string }) => {
      webView.events.push(event.type);
      return true;
    },
  };
  class FakeEvent {
    constructor(readonly type: string) {}
  }
  // eslint-disable-next-line no-new-func -- 注入する JS の文字列を実際に評価して挙動を確かめるため
  new Function('window', 'Event', script)(fakeWindow, FakeEvent);
}

/** 前の利用者が残した値。一覧のすべてのキーに入れる (一覧に足したキーも自動で検査の対象になる) */
function fillUserScopedKeys(webView: FakeWebView, value = 'previous-user'): void {
  for (const key of USER_SCOPED_LOCAL_STORAGE_KEYS) webView.storage.setItem(key, value);
}

function remainingUserScopedKeys(webView: FakeWebView): string[] {
  return USER_SCOPED_LOCAL_STORAGE_KEYS.filter((key) => webView.storage.getItem(key) !== null);
}

/** WebViewScreen と同じく、掃除の ID を読んで、注入する JS を作る (ID が無ければ何も注入しない) */
async function scriptForNextWebView(): Promise<string> {
  const requestId = await readPendingWebViewUserScopedStorageClear();
  return requestId ? buildClearUserScopedWebStorageScript(requestId) : '';
}

beforeEach(async () => {
  jest.clearAllMocks();
  resetWebViewUserStorageCleanupForTests();
  await AsyncStorage.clear();
  mockSignOut.mockResolvedValue({ error: null });
});

describe('一覧 (packages/shared の USER_SCOPED_LOCAL_STORAGE_KEYS)', () => {
  it('空ではない (検査が空回りしない)', () => {
    expect(USER_SCOPED_LOCAL_STORAGE_KEYS.length).toBeGreaterThan(0);
  });
});

describe('ネイティブのログアウト・退会のあと、WebView に利用者別のキーが残らない (#1037)', () => {
  it('設定画面のログアウト (signOutOnDevice) のあと、次に開く WebView が一覧のキーをすべて消す', async () => {
    const webView = createWebView();
    fillUserScopedKeys(webView);
    webView.storage.setItem('unrelated', 'keep');

    await signOutOnDevice('user-1', { clearSession: jest.fn() });
    runInWebView(webView, await scriptForNextWebView());

    expect(remainingUserScopedKeys(webView)).toEqual([]);
    // 一覧に無いキーは消さない
    expect(webView.storage.getItem('unrelated')).toBe('keep');
    // Web の clearUserScopedLocalStorage() と同じイベントを出す
    expect(webView.events).toEqual([USER_SCOPED_STORAGE_CLEARED_EVENT]);
  });

  it('サインアウトが失敗しても (オフラインなど)、WebView の掃除は頼んである (サインアウトの前に頼む)', async () => {
    mockSignOut.mockResolvedValue({ error: new Error('network') });
    const webView = createWebView();
    fillUserScopedKeys(webView);

    await signOutOnDevice('user-1', { clearSession: jest.fn() });
    runInWebView(webView, await scriptForNextWebView());

    expect(remainingUserScopedKeys(webView)).toEqual([]);
  });

  it('退会のあと (signOutAfterAccountDeletion) も、次に開く WebView が一覧のキーをすべて消す', async () => {
    const webView = createWebView();
    fillUserScopedKeys(webView);

    await signOutAfterAccountDeletion('user-1', { clearSession: jest.fn() });
    runInWebView(webView, await scriptForNextWebView());

    expect(remainingUserScopedKeys(webView)).toEqual([]);
  });

  it('Web からの sign-out などの共通処理 (signOutWithCleanup) のあとも消す', async () => {
    const webView = createWebView();
    fillUserScopedKeys(webView);

    await signOutWithCleanup('user-1');
    runInWebView(webView, await scriptForNextWebView());

    expect(remainingUserScopedKeys(webView)).toEqual([]);
  });

  it('アプリを起動し直してから開く WebView でも消す (掃除の ID は AsyncStorage に残る)', async () => {
    await signOutOnDevice('user-1', { clearSession: jest.fn() });
    const saved = await AsyncStorage.getItem(WEB_VIEW_STORAGE_CLEAR_REQUEST_KEY);
    expect(saved).toEqual(expect.any(String));

    // プロセスのメモリを忘れる (起動し直し)
    resetWebViewUserStorageCleanupForTests();
    const webView = createWebView();
    fillUserScopedKeys(webView);
    runInWebView(webView, await scriptForNextWebView());

    expect(remainingUserScopedKeys(webView)).toEqual([]);
  });

  it('掃除の ID は、ネイティブのログアウトの AsyncStorage の掃除 (clearUserScopedAsyncStorage) では消えない', async () => {
    await signOutOnDevice('user-1', { clearSession: jest.fn() });
    // 2 回目のログアウト (userId 不明で、プレフィックスでスキャンして消す経路) でも残る
    await signOutOnDevice(null, { clearSession: jest.fn() });

    expect(await AsyncStorage.getItem(WEB_VIEW_STORAGE_CLEAR_REQUEST_KEY)).toEqual(expect.any(String));
  });
});

describe('同じ掃除は二度しない (次の利用者の値を消さない)', () => {
  it('次の利用者がログインしてから書いた値は、同じ WebView の読み込み直しや別のタブの WebView を開いても消さない', async () => {
    const webView = createWebView();
    fillUserScopedKeys(webView);
    await signOutOnDevice('user-1', { clearSession: jest.fn() });
    const script = await scriptForNextWebView();

    runInWebView(webView, script);
    expect(webView.storage.getItem(WEB_VIEW_STORAGE_CLEARED_MARKER_KEY)).toEqual(expect.any(String));

    // 次の利用者が書いた値
    fillUserScopedKeys(webView, 'next-user');
    // 同じ WebView の読み込み直し (injectedJavaScriptBeforeContentLoaded は読み込みのたびに走る)・
    // 別のタブの WebView (localStorage は全タブで共有) のどちらも、同じ ID の JS を走らせる
    runInWebView(webView, script);
    runInWebView(webView, await scriptForNextWebView());

    expect(remainingUserScopedKeys(webView)).toEqual([...USER_SCOPED_LOCAL_STORAGE_KEYS]);
    expect(webView.storage.getItem(USER_SCOPED_LOCAL_STORAGE_KEYS[0])).toBe('next-user');
    expect(webView.events).toEqual([USER_SCOPED_STORAGE_CLEARED_EVENT]);
  });

  it('もう一度ログアウトしたら、新しい ID でまた消す', async () => {
    const webView = createWebView();
    await signOutOnDevice('user-1', { clearSession: jest.fn() });
    runInWebView(webView, await scriptForNextWebView());

    fillUserScopedKeys(webView, 'next-user');
    await signOutOnDevice('user-2', { clearSession: jest.fn() });
    runInWebView(webView, await scriptForNextWebView());

    expect(remainingUserScopedKeys(webView)).toEqual([]);
  });

  it('消す途中で失敗したら済んだ印を書かず、次の読み込みでもう一度消す', async () => {
    const webView = createWebView();
    fillUserScopedKeys(webView);
    await signOutOnDevice('user-1', { clearSession: jest.fn() });
    const script = await scriptForNextWebView();

    webView.storage.failRemove = true;
    expect(() => runInWebView(webView, script)).not.toThrow();
    expect(webView.storage.getItem(WEB_VIEW_STORAGE_CLEARED_MARKER_KEY)).toBeNull();

    webView.storage.failRemove = false;
    runInWebView(webView, script);
    expect(remainingUserScopedKeys(webView)).toEqual([]);
  });
});

describe('ログアウトの印の読み書き', () => {
  it('一度もログアウトしていない端末では、何も注入しない (ログイン中の利用者の値を消さない)', async () => {
    expect(await readPendingWebViewUserScopedStorageClear()).toBeNull();
    expect(await scriptForNextWebView()).toBe('');
  });

  it('ログアウトのたびに新しい ID を作る', async () => {
    await requestWebViewUserScopedStorageClear();
    const first = await readPendingWebViewUserScopedStorageClear();
    await requestWebViewUserScopedStorageClear();
    const second = await readPendingWebViewUserScopedStorageClear();

    expect(first).toEqual(expect.any(String));
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    expect(await AsyncStorage.getItem(WEB_VIEW_STORAGE_CLEAR_REQUEST_KEY)).toBe(second);
  });

  it('AsyncStorage に書けなくても例外を投げず、このプロセスの間に開く WebView では消す', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));

    await expect(requestWebViewUserScopedStorageClear()).resolves.toBeUndefined();

    const webView = createWebView();
    fillUserScopedKeys(webView);
    runInWebView(webView, await scriptForNextWebView());
    expect(remainingUserScopedKeys(webView)).toEqual([]);
  });

  it('AsyncStorage を読めないときは、漏らさない側に倒して消す (同じプロセスの中では同じ ID なので、二度は消さない)', async () => {
    // 読む 3 回 (下の first / second / scriptForNextWebView) とも失敗させる
    const getItem = AsyncStorage.getItem as jest.Mock;
    getItem
      .mockRejectedValueOnce(new Error('io'))
      .mockRejectedValueOnce(new Error('io'))
      .mockRejectedValueOnce(new Error('io'));

    const first = await readPendingWebViewUserScopedStorageClear();
    const second = await readPendingWebViewUserScopedStorageClear();
    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);

    const webView = createWebView();
    fillUserScopedKeys(webView);
    runInWebView(webView, await scriptForNextWebView());
    expect(remainingUserScopedKeys(webView)).toEqual([]);
  });
});

describe('注入する JS', () => {
  it('一覧のキーをすべて、JSON の文字列で埋め込む (一覧を写さず、packages/shared から作る)', () => {
    const script = buildClearUserScopedWebStorageScript('id-1');
    expect(script).toContain(JSON.stringify(USER_SCOPED_LOCAL_STORAGE_KEYS));
  });

  it('ID に引用符などが入っていても、JS の文字列として壊れない', () => {
    const webView = createWebView();
    fillUserScopedKeys(webView);
    const oddId = `a'b"c\\d</script>`;

    runInWebView(webView, buildClearUserScopedWebStorageScript(oddId));

    expect(remainingUserScopedKeys(webView)).toEqual([]);
    expect(webView.storage.getItem(WEB_VIEW_STORAGE_CLEARED_MARKER_KEY)).toBe(oddId);
  });

  it('localStorage を使えない WebView でも例外を投げない', () => {
    const script = buildClearUserScopedWebStorageScript('id-1');
    // eslint-disable-next-line no-new-func -- 注入する JS を評価する
    const run = () => new Function('window', 'Event', script)({}, class {});
    expect(run).not.toThrow();
  });
});
