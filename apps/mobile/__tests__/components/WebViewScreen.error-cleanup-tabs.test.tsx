/**
 * WebViewScreen の #1612 (#1049 の残り) のテスト
 *
 *   F7-15: 読み込みの失敗 (onError / renderError) とサーバーの 5xx (onHttpError) で、日本語の案内と「再読み込み」を出す。
 *          503 は重ねない (Web はメンテナンス中の画面を 503 で返すので、そのまま見せる)。
 *          再読み込みは WebView の reload() ではなく、認証ブリッジ (code の発行) からやり直す。
 *          タブ同士の移動で離れたタブの initialPath を消す
 *   F7-16: ネイティブのログアウトのあと、認証ブリッジ無しで開くときだけ、前の利用者の認証の Cookie を消す JS を注入する
 *   F7-22: tab-navigate の path は @homegohan/shared の NATIVE_APP_TABS の pathPrefix で引く。注入するタブの横取りの
 *          スクリプトと initialPath の検証も同じ表を使う
 */

import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NATIVE_APP_TABS, SERVICE_UNAVAILABLE_STATUS, USER_SCOPED_LOCAL_STORAGE_KEYS } from '@homegohan/shared';

const WEB_BASE_URL = 'https://homegohan-app.vercel.app';
process.env.EXPO_PUBLIC_WEB_URL = WEB_BASE_URL;

// ── expo-router モック (購読した listener を event ごとに保持する) ───────────
type Listener = () => void;
const mockListeners: Record<string, Listener[]> = {};
const mockRouter = {
  push: jest.fn(),
  back: jest.fn(),
  canGoBack: jest.fn(() => false),
};
const mockParentNavigation = { isFocused: jest.fn(() => true) };
const mockNavigation = {
  addListener: jest.fn((event: string, callback: Listener) => {
    (mockListeners[event] ??= []).push(callback);
    return () => {
      mockListeners[event] = (mockListeners[event] ?? []).filter((cb) => cb !== callback);
    };
  }),
  isFocused: jest.fn(() => false),
  setParams: jest.fn(),
  getState: jest.fn((): { type?: string } | undefined => ({ type: 'tab' })),
  getParent: jest.fn((): { isFocused: () => boolean } | undefined => mockParentNavigation),
};
let mockSearchParams: Record<string, unknown> = {};
jest.mock('expo-router', () => ({
  useNavigation: () => mockNavigation,
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockSearchParams,
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── react-native-webview モック (最後に描画した props を保持する) ─────────────
type WebViewProps = Record<string, any>;
let mockWebViewProps: WebViewProps = {};
let mockWebViewMounts = 0;
jest.mock('react-native-webview', () => {
  const ReactInMock = require('react');
  return {
    WebView: (props: Record<string, unknown>) => {
      mockWebViewProps = props;
      ReactInMock.useEffect(() => {
        mockWebViewMounts += 1;
      }, []);
      const { View } = require('react-native');
      return <View testID={(props.testID as string | undefined) ?? 'webview'} />;
    },
  };
});

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: '/tmp/cache/',
  documentDirectory: '/tmp/',
  writeAsStringAsync: jest.fn(() => Promise.resolve()),
  EncodingType: { UTF8: 'utf8' },
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(() => Promise.resolve(false)),
  shareAsync: jest.fn(),
}));

jest.mock('../../src/lib/supabase', () => ({
  SUPABASE_AUTH_STORAGE_KEY: 'sb-abcdef1234-auth-token',
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
  colors: { accent: '#FF6B35', accentDark: '#C4634C', text: '#2D2D2D', textLight: '#6B6B6B' },
}));

import { WebViewScreen } from '../../src/components/web/WebViewScreen';
import { WEB_VIEW_ERROR_TITLE, WEB_VIEW_RETRY_LABEL } from '../../src/components/web/WebViewErrorView';
import { SERVER_ERROR_STATUS_MIN, shouldCoverHttpStatus } from '../../src/components/web/useWebViewHttpFailure';
import {
  requestWebViewUserScopedStorageClear,
  resetWebViewUserStorageCleanupForTests,
} from '../../src/lib/webViewUserStorageCleanup';

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパー
// ─────────────────────────────────────────────────────────────────────────────
const FIRST_CODE = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo';
const SECOND_CODE = 'c2Vjb25kY29kZXNlY29uZGNvZGVzZWNvbmRjb2RlMTI';

function makeSession() {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    user: { id: 'user-uuid-1', email: 'test@example.com' },
  };
}

function codeResponse(code: string) {
  return { ok: true, status: 200, json: async () => ({ code, expires_in: 60 }) };
}

const mockFetch = jest.fn();
const originalFetch = global.fetch;
afterAll(() => {
  global.fetch = originalFetch;
});

async function renderScreen(path = '/home') {
  const utils = render(<WebViewScreen path={path} testID="webview-home" />);
  await waitFor(() => {
    expect(mockWebViewProps.source?.uri).toBeDefined();
  });
  return utils;
}

const uriOf = (): string => mockWebViewProps.source.uri;

beforeEach(async () => {
  jest.clearAllMocks();
  mockWebViewProps = {};
  mockWebViewMounts = 0;
  for (const key of Object.keys(mockListeners)) delete mockListeners[key];
  mockSearchParams = {};
  mockNavigation.getState.mockReturnValue({ type: 'tab' });
  mockNavigation.getParent.mockReturnValue(mockParentNavigation);
  mockParentNavigation.isFocused.mockReturnValue(true);
  mockGetSession.mockResolvedValue({ data: { session: makeSession() } });
  mockRefreshSession.mockResolvedValue({ data: { session: null }, error: null });
  mockFetch.mockReset();
  mockFetch.mockResolvedValueOnce(codeResponse(FIRST_CODE)).mockResolvedValue(codeResponse(SECOND_CODE));
  global.fetch = mockFetch as unknown as typeof fetch;
  resetWebViewUserStorageCleanupForTests();
  await AsyncStorage.clear();
});

// ─────────────────────────────────────────────────────────────────────────────
// F7-15: 読み込みの失敗の案内と再読み込み
// ─────────────────────────────────────────────────────────────────────────────
describe('読み込みの失敗 (オフライン・DNS・接続など) の案内 (renderError)', () => {
  it('renderError は日本語の案内と「再読み込み」を出す (ライブラリの英語の既定の画面にしない)', async () => {
    await renderScreen();
    expect(typeof mockWebViewProps.renderError).toBe('function');
    expect(typeof mockWebViewProps.onError).toBe('function');

    const errorView = render(mockWebViewProps.renderError('NSURLErrorDomain', -1009, 'The Internet connection appears to be offline.'));

    expect(errorView.getByText(WEB_VIEW_ERROR_TITLE)).toBeTruthy();
    expect(errorView.getByTestId('webview-error-message').props.children).toContain('通信に失敗しました');
    expect(errorView.getByLabelText(WEB_VIEW_RETRY_LABEL)).toBeTruthy();
    expect(errorView.queryByText(/offline/)).toBeNull();
  });

  it('「再読み込み」は WebView を作り直し、認証ブリッジの code を取り直して新しい URL で開く (使い切った code の URL を読み直さない)', async () => {
    await renderScreen();
    expect(uriOf()).toContain(`code=${FIRST_CODE}`);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockWebViewMounts).toBe(1);

    const errorView = render(mockWebViewProps.renderError('NSURLErrorDomain', -1009, 'offline'));
    await act(async () => {
      fireEvent.press(errorView.getByTestId('webview-error-retry'));
    });

    await waitFor(() => {
      expect(uriOf()).toContain(`code=${SECOND_CODE}`);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockWebViewMounts).toBe(2);
  });
});

describe('サーバーの 5xx の案内 (onHttpError)', () => {
  const httpError = (statusCode: number) =>
    act(() => {
      mockWebViewProps.onHttpError({ nativeEvent: { statusCode, url: `${WEB_BASE_URL}/home` } });
    });
  const loadEnd = (nativeEvent: Record<string, unknown> = { url: `${WEB_BASE_URL}/home` }) =>
    act(() => {
      mockWebViewProps.onLoadEnd({ nativeEvent });
    });

  it.each([500, 502, 504])('%s (503 以外の 5xx) を受けたら、WebView の上に案内と「再読み込み」を重ね、ステータスを文に出す', async (statusCode) => {
    const screen = await renderScreen();
    expect(screen.queryByTestId('webview-error')).toBeNull();

    await httpError(statusCode);

    expect(screen.getByText(WEB_VIEW_ERROR_TITLE)).toBeTruthy();
    expect(screen.getByTestId('webview-error-message').props.children).toContain(`エラー ${statusCode}`);
    // ヘッダーや WebView を消さずに重ねる
    expect(screen.getByTestId('webview-home')).toBeTruthy();
  });

  it('503 (メンテナンス中の画面など) では案内を重ねず、Web が返したページをそのまま見せる', async () => {
    const screen = await renderScreen();

    // onHttpError の直後も、その読み込みの onLoadEnd の後も、案内は出ない
    await httpError(SERVICE_UNAVAILABLE_STATUS);
    expect(screen.queryByTestId('webview-error')).toBeNull();
    await loadEnd();
    expect(screen.queryByTestId('webview-error')).toBeNull();
    expect(screen.getByTestId('webview-home')).toBeTruthy();
  });

  it('500 の案内が出ている間に、タブの再タップなどで読み直した先が 503 (メンテナンス中) なら、案内を消してそのページを見せる', async () => {
    const screen = await renderScreen();

    await httpError(500);
    await loadEnd();
    expect(screen.getByTestId('webview-error')).toBeTruthy();

    await httpError(SERVICE_UNAVAILABLE_STATUS);
    await loadEnd();
    expect(screen.queryByTestId('webview-error')).toBeNull();
  });

  it('案内を重ねるかの判定 (shouldCoverHttpStatus): 503 以外の 5xx だけ', () => {
    expect(shouldCoverHttpStatus(SERVER_ERROR_STATUS_MIN)).toBe(true);
    expect(shouldCoverHttpStatus(502)).toBe(true);
    expect(shouldCoverHttpStatus(504)).toBe(true);
    expect(shouldCoverHttpStatus(SERVICE_UNAVAILABLE_STATUS)).toBe(false);
    expect(shouldCoverHttpStatus(SERVER_ERROR_STATUS_MIN - 1)).toBe(false);
    expect(shouldCoverHttpStatus(404)).toBe(false);
  });

  it.each([400, 401, 403, 404, 499])('%s (4xx) では案内を出さない (Web のページが案内を出す)', async (statusCode) => {
    const screen = await renderScreen();
    await httpError(statusCode);
    expect(screen.queryByTestId('webview-error')).toBeNull();
  });

  it('Android の順 (onHttpError → onLoadEnd): 5xx を受けた読み込みの onLoadEnd では消さず、次の 5xx でない読み込みの onLoadEnd で消す', async () => {
    const screen = await renderScreen();

    await httpError(502);
    await loadEnd();
    expect(screen.getByTestId('webview-error')).toBeTruthy();

    await loadEnd();
    expect(screen.queryByTestId('webview-error')).toBeNull();
  });

  it('iOS のページの中の移動 (navigationType を持つ onLoadEnd) では消さない', async () => {
    const screen = await renderScreen();

    await httpError(500);
    await loadEnd();
    await loadEnd({ url: `${WEB_BASE_URL}/home`, navigationType: 'other' });
    expect(screen.getByTestId('webview-error')).toBeTruthy();
  });

  it('読み込みそのものが失敗したら (onError) 5xx の案内は消す (renderError の案内と二重に出さない)', async () => {
    const screen = await renderScreen();

    await httpError(500);
    await act(() => {
      mockWebViewProps.onError({ nativeEvent: { code: -1009, description: 'offline', url: `${WEB_BASE_URL}/home` } });
    });
    expect(screen.queryByTestId('webview-error')).toBeNull();
  });

  it('5xx の案内の「再読み込み」も、認証ブリッジからやり直し、案内を消す', async () => {
    const screen = await renderScreen();
    await httpError(500);

    await act(async () => {
      fireEvent.press(screen.getByTestId('webview-error-retry'));
    });

    await waitFor(() => {
      expect(uriOf()).toContain(`code=${SECOND_CODE}`);
    });
    expect(screen.queryByTestId('webview-error')).toBeNull();
    expect(mockWebViewMounts).toBe(2);
  });

  it('再読み込みでも header (マイページの歯車など) は残る', async () => {
    const screen = render(<WebViewScreen path="/profile" header={<Text testID="profile-header">歯車</Text>} />);
    await waitFor(() => expect(mockWebViewProps.source?.uri).toBeDefined());
    await httpError(500);
    expect(screen.getByTestId('profile-header')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('webview-error-retry'));
    });
    await waitFor(() => expect(uriOf()).toContain(`code=${SECOND_CODE}`));
    expect(screen.getByTestId('profile-header')).toBeTruthy();
  });
});

describe('タブを離れたときの initialPath の消去', () => {
  const blur = () =>
    act(() => {
      for (const callback of mockListeners.blur ?? []) callback();
    });

  it('別のタブへ移ったら (タブのナビゲーターの中・親の画面が手前のまま)、initialPath を消す', async () => {
    mockSearchParams = { initialPath: '/menus/weekly?modal=shopping' };
    await renderScreen('/menus/weekly');

    await blur();

    expect(mockNavigation.setParams).toHaveBeenCalledWith({ initialPath: undefined });
  });

  it('タブの上にネイティブの画面を重ねたとき (親の画面が手前でない) は消さない (戻ったときにページを保つ)', async () => {
    mockSearchParams = { initialPath: '/menus/weekly?modal=shopping' };
    mockParentNavigation.isFocused.mockReturnValue(false);
    await renderScreen('/menus/weekly');

    await blur();

    expect(mockNavigation.setParams).not.toHaveBeenCalled();
  });

  it('タブ以外の画面 (スタックの中の WebViewScreen) では消さない', async () => {
    mockSearchParams = { initialPath: '/settings/ai-consent?_rb=1' };
    mockNavigation.getState.mockReturnValue({ type: 'stack' });
    await renderScreen('/settings/ai-consent');

    await blur();

    expect(mockNavigation.setParams).not.toHaveBeenCalled();
  });

  it('親の画面・ナビゲーターの状態が分からないときは消さない (今までどおりに倒す)', async () => {
    mockSearchParams = { initialPath: '/menus/weekly?modal=shopping' };
    mockNavigation.getParent.mockReturnValue(undefined);
    await renderScreen('/menus/weekly');
    await blur();

    mockNavigation.getParent.mockReturnValue(mockParentNavigation);
    mockNavigation.getState.mockReturnValue(undefined);
    await blur();

    expect(mockNavigation.setParams).not.toHaveBeenCalled();
  });

  it('initialPath が無いタブは blur を購読しない (消すものが無い)', async () => {
    await renderScreen('/home');
    expect(mockListeners.blur ?? []).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F7-16: ログアウトのあと、ブリッジ無しで開くときだけ認証の Cookie を消す
// ─────────────────────────────────────────────────────────────────────────────
describe('ネイティブのログアウトのあとの Cookie の掃除 (#1612 F7-16)', () => {
  class FakeLocalStorage {
    readonly items = new Map<string, string>();
    getItem(key: string) {
      return this.items.get(key) ?? null;
    }
    setItem(key: string, value: string) {
      this.items.set(key, value);
    }
    removeItem(key: string) {
      this.items.delete(key);
    }
    get length() {
      return this.items.size;
    }
    key(index: number) {
      return [...this.items.keys()][index] ?? null;
    }
  }

  /** 注入された JS を、自アプリのオリジンのページの上で走らせ、残った Cookie の名前と localStorage を返す */
  function runInjectedScript(cookies: string[]) {
    const jar = new Map<string, string>(cookies.map((name) => [name, 'previous-user']));
    const storage = new FakeLocalStorage();
    for (const key of USER_SCOPED_LOCAL_STORAGE_KEYS) storage.setItem(key, 'previous-user');
    const fakeDocument = {
      get cookie() {
        return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      },
      set cookie(raw: string) {
        const [pair, ...attributes] = raw.split(';').map((part) => part.trim());
        if (attributes.some((attr) => /^max-age=0$/i.test(attr)) && attributes.some((attr) => attr === 'Path=/')) {
          jar.delete(pair.split('=')[0]);
        }
      },
    };
    const fakeWindow = {
      localStorage: storage,
      location: { origin: WEB_BASE_URL },
      dispatchEvent: () => true,
    };
    // eslint-disable-next-line no-new-func -- 注入する JS の文字列を実際に評価して挙動を確かめるため
    new Function('window', 'Event', 'document', mockWebViewProps.injectedJavaScriptBeforeContentLoaded)(
      fakeWindow,
      class {},
      fakeDocument,
    );
    return { cookies: [...jar.keys()].sort(), storage };
  }

  const PREVIOUS_COOKIES = ['sb-abcdef1234-auth-token.0', 'sb-abcdef1234-auth-token.1', 'is_native_app'];

  it('認証ブリッジ無しで開くとき (ログアウトのあとの未ログインなど) は、前の利用者の認証の Cookie を消す', async () => {
    await requestWebViewUserScopedStorageClear();
    mockGetSession.mockResolvedValue({ data: { session: null } });

    await renderScreen();
    expect(uriOf()).not.toContain('code=');

    const { cookies, storage } = runInjectedScript(PREVIOUS_COOKIES);
    expect(cookies).toEqual(['is_native_app']);
    expect(USER_SCOPED_LOCAL_STORAGE_KEYS.filter((key) => storage.getItem(key) !== null)).toEqual([]);
  });

  it('code の発行に失敗して直接 URL で開くときも消す', async () => {
    await requestWebViewUserScopedStorageClear();
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));

    await renderScreen();
    expect(uriOf()).not.toContain('code=');

    expect(runInjectedScript(PREVIOUS_COOKIES).cookies).toEqual(['is_native_app']);
  });

  it('認証ブリッジで開くときは Cookie を消さない (ブリッジがいま張った新しい利用者の Cookie を消さない)。localStorage は消す', async () => {
    await requestWebViewUserScopedStorageClear();

    await renderScreen();
    expect(uriOf()).toContain(`code=${FIRST_CODE}`);

    const { cookies, storage } = runInjectedScript(PREVIOUS_COOKIES);
    expect(cookies).toEqual([...PREVIOUS_COOKIES].sort());
    expect(USER_SCOPED_LOCAL_STORAGE_KEYS.filter((key) => storage.getItem(key) !== null)).toEqual([]);
  });

  it('一度もログアウトしていない端末では何も注入しない', async () => {
    await renderScreen();
    expect(mockWebViewProps.injectedJavaScriptBeforeContentLoaded).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F7-22: タブの表 (NATIVE_APP_TABS)
// ─────────────────────────────────────────────────────────────────────────────
describe('タブの表 (@homegohan/shared の NATIVE_APP_TABS) で tab-navigate を引く (#1612 F7-22)', () => {
  const message = (payload: unknown) =>
    mockWebViewProps.onMessage({ nativeEvent: { url: `${WEB_BASE_URL}/home?mode=app`, data: JSON.stringify(payload) } });
  const flushTimers = () => act(async () => new Promise((resolve) => setTimeout(resolve, 5)));

  it.each(NATIVE_APP_TABS.map((tab) => [tab.name, tab] as const))(
    '%s のタブ: path が表の pathPrefix なら、そのタブのルートへ移る',
    async (_name, tab) => {
      await renderScreen('/home');
      message({ type: 'tab-navigate', path: tab.pathPrefix, fullPath: tab.rootPath });
      await flushTimers();

      if (tab.rootPath === tab.pathPrefix) {
        expect(mockRouter.push).toHaveBeenCalledWith(tab.route);
      } else {
        expect(mockRouter.push).toHaveBeenCalledWith({ pathname: tab.route, params: { initialPath: tab.rootPath } });
      }
    },
  );

  it("Web が以前の一覧で送っていた '/meals/new' (prefix でない path) は受け付けない。今の Web は '/meals' を送る", async () => {
    await renderScreen('/home');
    message({ type: 'tab-navigate', path: '/meals/new', fullPath: '/meals/new' });
    message({ type: 'tab-navigate', path: { toString: () => '/meals' }, fullPath: '/meals/new' });
    await flushTimers();
    expect(mockRouter.push).not.toHaveBeenCalled();

    message({ type: 'tab-navigate', path: '/meals', fullPath: '/meals/new' });
    await flushTimers();
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/(tabs)/meals', params: { initialPath: '/meals/new' } });
  });

  it('注入するタブの横取りのスクリプトは、表の pathPrefix を並べる', async () => {
    await renderScreen('/home');
    expect(mockWebViewProps.injectedJavaScript).toContain(
      `var TAB_PATHS = ${JSON.stringify(NATIVE_APP_TABS.map((tab) => tab.pathPrefix))};`,
    );
  });

  it('initialPath の検証も表の prefix を使う (食事の詳細 /meals/<id> を meals のタブの画面で受け付ける)', async () => {
    mockSearchParams = { initialPath: '/meals/3f2c1c3e-aaaa-bbbb-cccc-1234567890ab' };
    await renderScreen('/meals/new');
    expect(decodeURIComponent(uriOf())).toContain('/meals/3f2c1c3e-aaaa-bbbb-cccc-1234567890ab');
  });
});
