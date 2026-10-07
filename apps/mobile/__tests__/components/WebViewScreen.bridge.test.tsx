/**
 * WebViewScreen 認証ブリッジ・オリジン固定のテスト (#1036 / #1158)
 *
 * WebViewScreen.test.tsx が「URL / 注入スクリプトにトークンが載らない」基本形を見るのに対し、
 * こちらは次を検証する:
 *   1. code 発行リクエスト (POST /api/auth/native-bridge/code, Bearer, body は refresh_token)
 *   2. 失敗時 (ネットワーク / 非 2xx / 不正レスポンス / セッション無し) はトークン無しの直接 URL へ倒れる
 *   3. access_token の残りが少なければ先に refreshSession する
 *   4. initialPath (deep link 由来) の検証: //evil.example 等は既定パスへ戻る
 *   5. onShouldStartLoadWithRequest: 自オリジン以外のトップフレーム遷移は遮断して既定ブラウザへ
 *   6. onOpenWindow (target=_blank): 自オリジンは今の WebView、他オリジンは既定ブラウザ
 *   7. onMessage: 送信元が自オリジンでなければ tab-navigate / download 等を処理しない
 *   8. 注入スクリプト (タブ intercept / tabPress リセット): 他オリジンでは何も実行しない
 */

import React from 'react';
import * as vm from 'vm';
import { Linking } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';

const WEB_BASE_URL = 'https://homegohan-app.vercel.app';
process.env.EXPO_PUBLIC_WEB_URL = WEB_BASE_URL;

// ── expo-router モック ────────────────────────────────────────────────────────
const mockRouter = {
  push: jest.fn(),
  back: jest.fn(),
  canGoBack: jest.fn(() => false),
};
const mockNavigation = {
  addListener: jest.fn((_event: string, _cb: () => void) => jest.fn()),
  isFocused: jest.fn(() => false),
};
let mockSearchParams: Record<string, unknown> = {};
jest.mock('expo-router', () => ({
  useNavigation: () => mockNavigation,
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockSearchParams,
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: any) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── react-native-webview モック (props と ref を保持して検査できるようにする) ──
const mockWebViewProps: Record<string, any> = {};
jest.mock('react-native-webview', () => ({
  WebView: (props: any) => {
    Object.assign(mockWebViewProps, props);
    const { View } = require('react-native');
    return <View testID={props.testID ?? 'webview'} />;
  },
}));

jest.mock('expo-file-system', () => ({
  documentDirectory: '/tmp/',
  writeAsStringAsync: jest.fn(() => Promise.resolve()),
  EncodingType: { UTF8: 'utf8' },
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(() => Promise.resolve(false)),
  shareAsync: jest.fn(),
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      refreshSession: jest.fn(),
    },
  },
}));
import { supabase as mockSupabase } from '../../src/lib/supabase';
const mockGetSession = mockSupabase.auth.getSession as jest.Mock;
const mockRefreshSession = mockSupabase.auth.refreshSession as jest.Mock;

jest.mock('../../src/theme/colors', () => ({
  colors: { accent: '#FF6B35' },
}));

import * as FileSystem from 'expo-file-system';
import { WebViewScreen } from '../../src/components/web/WebViewScreen';

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパー
// ─────────────────────────────────────────────────────────────────────────────
const CODE = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo';
const ACCESS = 'secret-access-token-AAA';
const REFRESH = 'secret-refresh-token-BBB';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    access_token: ACCESS,
    refresh_token: REFRESH,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    user: { id: 'user-uuid-1', email: 'test@example.com' },
    provider_token: 'provider-secret',
    provider_refresh_token: 'provider-refresh-secret',
    ...overrides,
  };
}

function okResponse(body: unknown = { code: CODE, expires_in: 60 }) {
  return { ok: true, status: 200, json: async () => body };
}

const mockFetch = jest.fn();
const originalFetch = global.fetch;
let openURLSpy: jest.SpyInstance;

async function renderScreen(path = '/home') {
  const utils = render(<WebViewScreen path={path} />);
  await waitFor(() => {
    expect(mockWebViewProps.source?.uri).toBeDefined();
  });
  return utils;
}

const uriOf = (): string => mockWebViewProps.source.uri;

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockWebViewProps).forEach((k) => delete mockWebViewProps[k]);
  mockSearchParams = {};
  mockNavigation.isFocused.mockReturnValue(false);
  mockGetSession.mockResolvedValue({ data: { session: makeSession() } });
  mockRefreshSession.mockResolvedValue({ data: { session: null }, error: null });
  mockFetch.mockResolvedValue(okResponse());
  global.fetch = mockFetch as unknown as typeof fetch;
  openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  openURLSpy.mockRestore();
  (console.warn as jest.Mock).mockRestore?.();
});

afterAll(() => {
  global.fetch = originalFetch;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. code 発行リクエスト
// ─────────────────────────────────────────────────────────────────────────────
describe('code 発行リクエスト', () => {
  it('POST /api/auth/native-bridge/code を Bearer 付きで呼び、body に refresh_token だけを載せる', async () => {
    await renderScreen('/home');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${WEB_BASE_URL}/api/auth/native-bridge/code`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS}`);
    expect(JSON.parse(init.body)).toEqual({ refresh_token: REFRESH });
  });

  it('WebView の source は /auth/native-bridge?code=… で、どちらのトークンも含まない', async () => {
    await renderScreen('/menus/weekly');

    const parsed = new URL(uriOf());
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${WEB_BASE_URL}/auth/native-bridge`);
    expect(parsed.searchParams.get('code')).toBe(CODE);
    expect(parsed.searchParams.get('next')).toBe('/menus/weekly?mode=app');
    expect(uriOf()).not.toContain(ACCESS);
    expect(uriOf()).not.toContain(REFRESH);
  });

  it('injectedJavaScriptBeforeContentLoaded は未指定で、source と injectedJavaScript にトークン・ユーザー情報が無い', async () => {
    await renderScreen('/home');

    expect(mockWebViewProps.injectedJavaScriptBeforeContentLoaded).toBeUndefined();
    const serialized = JSON.stringify({
      source: mockWebViewProps.source,
      injectedJavaScript: mockWebViewProps.injectedJavaScript,
    });
    for (const secret of [ACCESS, REFRESH, 'provider-secret', 'provider-refresh-secret', 'test@example.com']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('WebView の props のどこにもトークンが現れない (全 props を再帰的に走査)', async () => {
    await renderScreen('/home');

    const seen = new WeakSet<object>();
    const strings: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === 'string') strings.push(value);
      else if (value && typeof value === 'object') {
        if (seen.has(value as object)) return;
        seen.add(value as object);
        if ((value as { $$typeof?: unknown }).$$typeof) return; // React 要素・ref は対象外
        Object.values(value as object).forEach(walk);
      }
    };
    const { ref: _ref, ...props } = mockWebViewProps;
    walk(props);

    const joined = strings.join('\n');
    expect(joined).not.toContain(ACCESS);
    expect(joined).not.toContain(REFRESH);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 失敗時のフォールバック (トークンを URL に載せる旧方式には戻らない)
// ─────────────────────────────────────────────────────────────────────────────
describe('code 発行に失敗した場合は直接 URL へ倒れる', () => {
  function expectDirectUrlWithoutTokens(path: string) {
    const uri = uriOf();
    expect(uri).toBe(`${WEB_BASE_URL}${path}`);
    expect(uri).not.toContain('/auth/native-bridge');
    expect(uri).not.toContain('access_token');
    expect(uri).not.toContain('refresh_token');
    expect(uri).not.toContain(ACCESS);
    expect(uri).not.toContain(REFRESH);
    expect(mockWebViewProps.injectedJavaScriptBeforeContentLoaded).toBeUndefined();
  }

  it('ネットワークエラー', async () => {
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));
    await renderScreen('/home');
    expectDirectUrlWithoutTokens('/home?mode=app');
  });

  it.each([401, 403, 429, 500, 503])('HTTP %i', async (status) => {
    mockFetch.mockResolvedValue({ ok: false, status, json: async () => ({ error: { code: 'X' } }) });
    await renderScreen('/menus/weekly');
    expectDirectUrlWithoutTokens('/menus/weekly?mode=app');
  });

  it.each([
    ['code が無い', {}],
    ['code が文字列でない', { code: 42 }],
    ['code に不正な文字', { code: 'abc&access_token=x&padding-padding' }],
  ])('不正なレスポンス (%s)', async (_label, body) => {
    mockFetch.mockResolvedValue(okResponse(body));
    await renderScreen('/home');
    expectDirectUrlWithoutTokens('/home?mode=app');
  });

  it('getSession が例外でも直接 URL を表示する (ローディングのまま固まらない)', async () => {
    mockGetSession.mockRejectedValue(new Error('storage failure'));
    await renderScreen('/home');
    expectDirectUrlWithoutTokens('/home?mode=app');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('セッションが無ければ code 発行を呼ばず直接 URL', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    await renderScreen('/home');
    expectDirectUrlWithoutTokens('/home?mode=app');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. access_token の事前 refresh
// ─────────────────────────────────────────────────────────────────────────────
describe('access_token の残りが少ない場合', () => {
  it('120 秒未満なら refreshSession してから、更新後のトークンで code を発行する', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: makeSession({ expires_at: Math.floor(Date.now() / 1000) + 30 }) },
    });
    mockRefreshSession.mockResolvedValue({
      data: { session: makeSession({ access_token: 'renewed-access', refresh_token: 'renewed-refresh' }) },
      error: null,
    });

    await renderScreen('/home');

    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer renewed-access');
    expect(JSON.parse(init.body)).toEqual({ refresh_token: 'renewed-refresh' });
    expect(uriOf()).toContain('/auth/native-bridge?code=');
  });

  it('十分に有効なら refreshSession しない', async () => {
    await renderScreen('/home');
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. initialPath (deep link / tab-navigate 由来) の検証
// ─────────────────────────────────────────────────────────────────────────────
describe('initialPath の検証', () => {
  it('同一オリジンのパスはそのまま使う (bridge の next に反映)', async () => {
    mockSearchParams = { initialPath: '/menus/weekly?date=2026-10-07&modal=shopping' };
    await renderScreen('/menus/weekly');

    const next = new URL(uriOf()).searchParams.get('next');
    expect(next).toBe('/menus/weekly?date=2026-10-07&modal=shopping&mode=app');
  });

  it.each([
    ['プロトコル相対', '//evil.example'],
    ['プロトコル相対 + パス', '//evil.example/x'],
    ['バックスラッシュ', '/\\evil.example'],
    ['authority 注入', '@evil.example'],
    ['絶対 URL', 'https://evil.example/'],
    ['javascript:', 'javascript:alert(1)'],
    ['エンコードされた //', '/%2Fevil.example'],
  ])('危険な値 (%s) は tab の既定パスへ戻る: bridge の next', async (_label, initialPath) => {
    mockSearchParams = { initialPath };
    await renderScreen('/home');

    const parsed = new URL(uriOf());
    expect(parsed.searchParams.get('next')).toBe('/home?mode=app');
    expect(uriOf()).not.toContain('evil');
  });

  it.each([
    ['プロトコル相対', '//evil.example'],
    ['authority 注入', '@evil.example'],
    ['バックスラッシュ', '/\\evil.example'],
  ])('危険な値 (%s) は tab の既定パスへ戻る: セッション無しの直接 URL', async (_label, initialPath) => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    mockSearchParams = { initialPath };
    await renderScreen('/home');

    // authority 注入 (https://homegohan-app.vercel.app@evil.example) になっていない
    expect(uriOf()).toBe(`${WEB_BASE_URL}/home?mode=app`);
    expect(new URL(uriOf()).host).toBe('homegohan-app.vercel.app');
  });

  // deep link (homegohan://home?initialPath=…) は他のアプリや Web ページからも起動できる。
  // initialPath が /auth/native-bridge?code=<攻撃者の code> を指せると、bridge が先に正規の code でセッションを張った後、
  // next として攻撃者の code を引き換え、被害者の WebView を攻撃者のアカウントでログインさせられる (login CSRF)。
  // そのため initialPath はどれかのタブの prefix 配下に限る (tab-navigate の fullPath は必ずタブの prefix に一致する)。
  const ATTACKER_CODE = 'ATTACKERCODEattackercode0123456789ABCDEFG';
  const OUTSIDE_TAB_PATHS: Array<[string, string]> = [
    ['認証ブリッジ (攻撃者の code)', `/auth/native-bridge?code=${ATTACKER_CODE}&next=%2Fhome`],
    ['旧方式の認証ブリッジ (攻撃者のトークン)', '/auth/native-bridge?access_token=attacker-at&refresh_token=attacker-rt'],
    ['タブ外のページ', '/login'],
    ['ドットセグメントでタブの外へ', `/home/../auth/native-bridge?code=${ATTACKER_CODE}`],
    ['エンコードされたドットセグメントでタブの外へ', `/home/%2e%2e/auth/native-bridge?code=${ATTACKER_CODE}`],
  ];

  it.each(OUTSIDE_TAB_PATHS)(
    'タブの配下でない値 (%s) は tab の既定パスへ戻る: bridge の next',
    async (_label, initialPath) => {
      mockSearchParams = { initialPath };
      await renderScreen('/home');

      const parsed = new URL(uriOf());
      expect(parsed.searchParams.get('code')).toBe(CODE); // 正規の code だけ
      expect(parsed.searchParams.get('next')).toBe('/home?mode=app');
      expect(uriOf()).not.toContain('ATTACKER');
      expect(uriOf()).not.toContain('attacker');
    },
  );

  it.each(OUTSIDE_TAB_PATHS)(
    'タブの配下でない値 (%s) は tab の既定パスへ戻る: セッション無しの直接 URL',
    async (_label, initialPath) => {
      mockGetSession.mockResolvedValue({ data: { session: null } });
      mockSearchParams = { initialPath };
      await renderScreen('/home');

      expect(uriOf()).toBe(`${WEB_BASE_URL}/home?mode=app`);
    },
  );

  it.each([
    ['同じタブの配下 (tab-navigate が渡す fullPath)', '/menus/weekly?date=2026-10-07', '/menus/weekly', '/menus/weekly?date=2026-10-07&mode=app'],
    ['別のタブの配下 (どれかのタブの prefix 配下なら通す)', '/profile/settings?tab=a', '/home', '/profile/settings?tab=a&mode=app'],
  ])('%s のパスは、そのまま使う', async (_label, initialPath, screenPath, expectedNext) => {
    mockSearchParams = { initialPath };
    await renderScreen(screenPath);

    expect(new URL(uriOf()).searchParams.get('next')).toBe(expectedNext);
  });

  it('配列で渡された場合は先頭要素だけを検証して使う', async () => {
    mockSearchParams = { initialPath: ['//evil.example', '/menus'] };
    await renderScreen('/home');
    expect(new URL(uriOf()).searchParams.get('next')).toBe('/home?mode=app');
  });

  it('initialPath が変わると新しい code で読み込み直し、古い結果で上書きされない', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    mockFetch
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(okResponse({ code: 'B'.repeat(43), expires_in: 60 }));

    mockSearchParams = { initialPath: '/menus/weekly?a=1' };
    const { rerender } = render(<WebViewScreen path="/menus/weekly" />);
    // 1 回目の code 発行がまだ返ってこない間に initialPath が変わる
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    mockSearchParams = { initialPath: '/menus/weekly?b=2' };
    rerender(<WebViewScreen path="/menus/weekly" />);

    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toContain('code=' + 'B'.repeat(43));
    });
    expect(new URL(uriOf()).searchParams.get('next')).toBe('/menus/weekly?b=2&mode=app');

    // 遅れて 1 回目が返ってきても、画面の URL は 2 回目のまま
    await act(async () => {
      resolveFirst(okResponse({ code: 'A'.repeat(43), expires_in: 60 }));
    });
    expect(uriOf()).toContain('code=' + 'B'.repeat(43));
    expect(uriOf()).not.toContain('A'.repeat(43));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. onShouldStartLoadWithRequest
// ─────────────────────────────────────────────────────────────────────────────
describe('onShouldStartLoadWithRequest', () => {
  const load = (url: string, isTopFrame: boolean | undefined = true) =>
    mockWebViewProps.onShouldStartLoadWithRequest({ url, isTopFrame, navigationType: 'click' });

  it('自オリジンへの遷移は許可し、外部ブラウザは開かない', async () => {
    await renderScreen('/home');
    expect(load(`${WEB_BASE_URL}/home?mode=app`)).toBe(true);
    expect(load(`${WEB_BASE_URL}/auth/native-bridge?code=${CODE}&next=%2Fhome`)).toBe(true);
    expect(load('about:blank')).toBe(true);
    expect(openURLSpy).not.toHaveBeenCalled();
  });

  it('他オリジンのトップフレーム遷移は遮断し、既定ブラウザで開く', async () => {
    await renderScreen('/home');
    expect(load('https://cookpad.example/recipe/123')).toBe(false);
    expect(openURLSpy).toHaveBeenCalledTimes(1);
    expect(openURLSpy).toHaveBeenCalledWith('https://cookpad.example/recipe/123');
  });

  it('isTopFrame が無い (Android) 場合もトップフレームとして扱う', async () => {
    await renderScreen('/home');
    expect(load('https://cookpad.example/recipe/123', undefined)).toBe(false);
    expect(openURLSpy).toHaveBeenCalledWith('https://cookpad.example/recipe/123');
  });

  it('他オリジンのサブフレームは黙って遮断する (外部ブラウザは開かない)', async () => {
    await renderScreen('/home');
    expect(load('https://tracker.example/frame', false)).toBe(false);
    expect(openURLSpy).not.toHaveBeenCalled();
  });

  it.each([
    'https://homegohan-app.vercel.app.evil.example/',
    'https://homegohan-app.vercel.app@evil.example/',
    'http://homegohan-app.vercel.app/',
    'https://homegohan-app.vercel.app:8443/',
  ])('自オリジンに見せかけた URL は許可しない: %s', async (url) => {
    await renderScreen('/home');
    expect(load(url)).toBe(false);
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'intent://x#Intent;end'])(
    '非 http(s) は遮断し、外部にも渡さない: %s',
    async (url) => {
      await renderScreen('/home');
      expect(load(url)).toBe(false);
      expect(openURLSpy).not.toHaveBeenCalled();
    },
  );

  it('originWhitelist は既定のまま (非 http(s) スキームのハンドオフを壊さない)', async () => {
    await renderScreen('/home');
    expect(mockWebViewProps.originWhitelist).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. onOpenWindow (target="_blank" / window.open)
// ─────────────────────────────────────────────────────────────────────────────
describe('onOpenWindow', () => {
  const openWindow = (targetUrl: string) => mockWebViewProps.onOpenWindow({ nativeEvent: { targetUrl } });

  function attachFakeWebView() {
    const injectJavaScript = jest.fn();
    mockWebViewProps.ref.current = { injectJavaScript };
    return injectJavaScript;
  }

  it('他オリジンは既定ブラウザで開き、WebView は動かさない (#1158)', async () => {
    await renderScreen('/home');
    const injectJavaScript = attachFakeWebView();

    openWindow('https://cookpad.example/recipe/123');

    expect(openURLSpy).toHaveBeenCalledWith('https://cookpad.example/recipe/123');
    expect(injectJavaScript).not.toHaveBeenCalled();
  });

  it('自オリジンは現在の WebView で開く (外部ブラウザは開かない)', async () => {
    await renderScreen('/home');
    const injectJavaScript = attachFakeWebView();
    const target = `${WEB_BASE_URL}/meals/abc?mode=app`;

    openWindow(target);

    expect(openURLSpy).not.toHaveBeenCalled();
    expect(injectJavaScript).toHaveBeenCalledTimes(1);
    const script: string = injectJavaScript.mock.calls[0][0];
    // 自オリジン上でだけ assign を呼ぶスクリプトであること
    const own = { origin: WEB_BASE_URL, assign: jest.fn(), replace: jest.fn() };
    vm.runInNewContext(script, { window: { location: own } });
    expect(own.assign).toHaveBeenCalledWith(target);
    const foreign = { origin: 'https://evil.example', assign: jest.fn(), replace: jest.fn() };
    vm.runInNewContext(script, { window: { location: foreign } });
    expect(foreign.assign).not.toHaveBeenCalled();
  });

  it.each(['about:blank', 'javascript:alert(1)', 'data:text/html,x', 'intent://x'])(
    '何もしない: %s',
    async (target) => {
      await renderScreen('/home');
      const injectJavaScript = attachFakeWebView();
      openWindow(target);
      expect(openURLSpy).not.toHaveBeenCalled();
      expect(injectJavaScript).not.toHaveBeenCalled();
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. onMessage の送信元検証
// ─────────────────────────────────────────────────────────────────────────────
describe('onMessage の送信元検証', () => {
  const message = (url: string | undefined, payload: unknown) =>
    mockWebViewProps.onMessage({ nativeEvent: { url, data: JSON.stringify(payload) } });
  const flushTimers = () => act(async () => new Promise((resolve) => setTimeout(resolve, 5)));

  const tabNavigate = { type: 'tab-navigate', path: '/menus', fullPath: '/menus/weekly?x=1' };

  it('自オリジンからの tab-navigate は処理する', async () => {
    await renderScreen('/home');
    message(`${WEB_BASE_URL}/home?mode=app`, tabNavigate);
    await flushTimers();
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/menus',
      params: { initialPath: '/menus/weekly?x=1' },
    });
  });

  it('自オリジンからの navigate-back は処理する', async () => {
    await renderScreen('/home');
    message(`${WEB_BASE_URL}/home`, { type: 'navigate-back' });
    expect(mockRouter.push).toHaveBeenCalledWith('/(tabs)/home');
  });

  it('Android の送信元は origin のみ (パス無し) で届く。これも自オリジンとして処理する', async () => {
    await renderScreen('/home');
    message(WEB_BASE_URL, { type: 'navigate-back' });
    expect(mockRouter.push).toHaveBeenCalledWith('/(tabs)/home');
  });

  it.each([
    ['他オリジン', 'https://evil.example/'],
    ['類似ホスト (サフィックス)', 'https://homegohan-app.vercel.app.evil.example/'],
    ['類似ホスト (userinfo)', 'https://homegohan-app.vercel.app@evil.example/'],
    ['http', 'http://homegohan-app.vercel.app/'],
    ['about:blank', 'about:blank'],
    ['送信元なし', undefined],
    ['空文字', ''],
  ])('%s からのメッセージは一切処理しない', async (_label, url) => {
    await renderScreen('/home');

    message(url, tabNavigate);
    message(url, { type: 'navigate-back' });
    message(url, { type: 'download', filename: 'x.csv', content: 'a,b', mimeType: 'text/csv' });
    await flushTimers();

    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it('自オリジンからの download は従来どおり処理される (ゲートが正規の経路を塞がない)', async () => {
    await renderScreen('/home');
    message(`${WEB_BASE_URL}/settings`, {
      type: 'download',
      filename: 'export.csv',
      content: 'a,b',
      mimeType: 'text/csv',
    });
    await flushTimers();
    expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith('/tmp/export.csv', 'a,b', { encoding: 'utf8' });
  });

  it('JSON でないデータは (自オリジンでも) 例外を投げず無視する', async () => {
    await renderScreen('/home');
    expect(() =>
      mockWebViewProps.onMessage({ nativeEvent: { url: `${WEB_BASE_URL}/home`, data: 'not json' } }),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. 注入スクリプトのオリジンガード
// ─────────────────────────────────────────────────────────────────────────────
describe('タブ intercept スクリプト (injectedJavaScript) のオリジンガード', () => {
  function makePage(origin: string) {
    const listeners: Array<{ type: string; handler: (e: any) => void }> = [];
    const originalPushState = jest.fn();
    const win: any = {
      location: { origin, pathname: '/home', search: '' },
      ReactNativeWebView: { postMessage: jest.fn() },
    };
    const doc: any = {
      body: {},
      addEventListener: jest.fn((type: string, handler: (e: any) => void) => listeners.push({ type, handler })),
    };
    const hist: any = { pushState: originalPushState, back: jest.fn() };
    return { win, doc, hist, listeners, originalPushState };
  }

  function run(script: string, page: ReturnType<typeof makePage>) {
    vm.runInNewContext(script, {
      window: page.win,
      document: page.doc,
      history: page.hist,
      URL,
      setTimeout,
    });
  }

  it('他オリジンのページでは何も installされない (リスナー・pushState フック・フラグ)', async () => {
    await renderScreen('/home');
    const page = makePage('https://evil.example');

    run(mockWebViewProps.injectedJavaScript, page);

    expect(page.doc.addEventListener).not.toHaveBeenCalled();
    expect(page.hist.pushState).toBe(page.originalPushState);
    expect(page.win.__tabInterceptInstalled).toBeUndefined();
    expect(page.win.ReactNativeWebView.postMessage).not.toHaveBeenCalled();
  });

  it('opaque origin ("null") でも何も install されない', async () => {
    await renderScreen('/home');
    const page = makePage('null');
    run(mockWebViewProps.injectedJavaScript, page);
    expect(page.doc.addEventListener).not.toHaveBeenCalled();
    expect(page.win.__tabInterceptInstalled).toBeUndefined();
  });

  it('自オリジンのページではクリック intercept と pushState フックが install される', async () => {
    await renderScreen('/home');
    const page = makePage(WEB_BASE_URL);

    run(mockWebViewProps.injectedJavaScript, page);

    expect(page.win.__tabInterceptInstalled).toBe(true);
    expect(page.doc.addEventListener).toHaveBeenCalledWith('click', expect.any(Function), true);
    expect(page.hist.pushState).not.toBe(page.originalPushState);
  });

  it('自オリジンのページでは別タブへのリンククリックが tab-navigate として通知される', async () => {
    await renderScreen('/home');
    const page = makePage(WEB_BASE_URL);
    run(mockWebViewProps.injectedJavaScript, page);

    const click = page.listeners.find((l) => l.type === 'click')!.handler;
    const event = {
      target: { tagName: 'A', href: `${WEB_BASE_URL}/menus/weekly?x=1`, parentElement: null },
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    };
    click(event);

    expect(event.preventDefault).toHaveBeenCalled();
    const sent = JSON.parse(page.win.ReactNativeWebView.postMessage.mock.calls[0][0]);
    expect(sent).toEqual({ type: 'tab-navigate', path: '/menus', fullPath: '/menus/weekly?x=1' });
  });
});

/**
 * タブ再タップのリセットは「WebView が自オリジンのページを表示していないとき」の復帰手段でもあるため、
 * 注入スクリプトにオリジンガードを付けない。ガードを付けると次の 2 経路で、アプリを終了するまで戻れなくなる。
 *   (a) 起動時にオフライン (または init 中に通信が途切れた) で直接 URL の読み込みに失敗すると、
 *       iOS の WKWebView は最初の about:blank (location.origin は "null") のまま既定のエラー表示になる。
 *       エラー表示には再試行ボタンも pull-to-refresh も無く、init は effectivePath が変わらない限り再実行されない。
 *   (b) Android の shouldOverrideUrlLoading が 250ms の待ち時間切れで許可に倒れ、外部ページが WebView に載る。
 * このスクリプトが持つのは公開されている自オリジンの URL だけで、トークンも code も無い。
 * 外部ページ上で実行しても漏れるものが無いので、ガードによる安全上の利点も無い。
 */
describe('タブ再タップ (tabPress) のリセットスクリプト', () => {
  function getTabPressListener(): () => void {
    const call = mockNavigation.addListener.mock.calls.find(([event]) => event === 'tabPress');
    expect(call).toBeDefined();
    return call![1];
  }

  /** 再タップして、WebView に注入されたリセットスクリプトを取り出す */
  function tapActiveTab(): string {
    const injectJavaScript = jest.fn();
    mockWebViewProps.ref.current = { injectJavaScript };
    mockNavigation.isFocused.mockReturnValue(true);

    getTabPressListener()();

    expect(injectJavaScript).toHaveBeenCalledTimes(1);
    return injectJavaScript.mock.calls[0][0];
  }

  /** スクリプトを、location.origin が origin のページ (を模した sandbox) で実行する */
  function runOnPage(script: string, origin: string) {
    const location = { origin, assign: jest.fn(), replace: jest.fn() };
    vm.runInNewContext(script, { window: { location } });
    return location;
  }

  it.each([
    ['自オリジンのページ', WEB_BASE_URL],
    ['読み込みに失敗して残った about:blank (opaque origin)', 'null'],
    ['待ち時間切れで許可され WebView に載った外部ページ', 'https://evil.example'],
  ])('%s の上でも、JSON リテラル化した初期 URL へ location.replace する', async (_label, origin) => {
    await renderScreen('/profile');

    const script = tapActiveTab();
    expect(script).toContain(JSON.stringify(`${WEB_BASE_URL}/profile?mode=app`));

    const location = runOnPage(script, origin);
    expect(location.replace).toHaveBeenCalledTimes(1);
    expect(location.replace).toHaveBeenCalledWith(`${WEB_BASE_URL}/profile?mode=app`);
    expect(location.assign).not.toHaveBeenCalled();
  });

  it('起動時にオフライン (code 発行に失敗) で about:blank のまま固まっても、再タップで直接 URL へ復帰できる', async () => {
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));
    await renderScreen('/menus/weekly');
    // トークンを含まない直接 URL に倒れている (この読み込みが失敗した状態を about:blank で表す)
    expect(uriOf()).toBe(`${WEB_BASE_URL}/menus/weekly?mode=app`);

    const location = runOnPage(tapActiveTab(), 'null');

    expect(location.replace).toHaveBeenCalledWith(`${WEB_BASE_URL}/menus/weekly?mode=app`);
  });

  it('リセット先は tab の初期 URL のまま (initialPath や bridge の code を引き継がない)', async () => {
    mockSearchParams = { initialPath: '/menus/weekly?a=1' };
    await renderScreen('/menus/weekly');
    // init が bridge URL (code 付き) を開いていても、リセットスクリプトには code を持ち込まない
    expect(uriOf()).toContain('/auth/native-bridge?code=');

    const script = tapActiveTab();

    expect(script).toContain(JSON.stringify(`${WEB_BASE_URL}/menus/weekly?mode=app`));
    for (const secret of [ACCESS, REFRESH, CODE, 'native-bridge', 'code=', 'initialPath', 'a=1']) {
      expect(script).not.toContain(secret);
    }
  });

  it('フォーカスされていないタブの再タップでは何もしない', async () => {
    await renderScreen('/profile');
    const injectJavaScript = jest.fn();
    mockWebViewProps.ref.current = { injectJavaScript };
    mockNavigation.isFocused.mockReturnValue(false);

    getTabPressListener()();

    expect(injectJavaScript).not.toHaveBeenCalled();
  });
});
