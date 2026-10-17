/**
 * T02: WebViewScreen RNTL 単体テスト
 * Issue #844 — RN↔Web 認証ブリッジテスト
 * Issue #1036 / #1158 — トークンを URL / 注入スクリプトに載せない code 方式へ変更
 *
 * カバレッジ:
 *   1. bridge URL 生成 (ワンタイム code。URL にトークンを載せない)
 *   2. mode=app 重複付与の抑制
 *   3. WebView にセッションを注入しない (localStorage 書込みスクリプトを廃止)
 *   4. セッション無し時の直接 URL 遷移
 *   5. header (#1037)
 *   6. ネイティブのログアウト・退会のあと、Web のページが読み込まれる前に利用者別の localStorage を消す (#1037)。
 *      掃除の JS は自アプリのオリジンでだけ動き、トークンを含まない (#1036)
 *
 * WebView のナビゲーション制限・postMessage の送信元検証・code 発行失敗時のフォールバック等は
 * WebViewScreen.bridge.test.tsx にある。
 */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

// ── 環境変数 ──────────────────────────────────────────────────────────────────
const WEB_BASE_URL = 'https://homegohan-app.vercel.app';
process.env.EXPO_PUBLIC_WEB_URL = WEB_BASE_URL;

// ── expo-router モック ────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  useNavigation: () => ({
    addListener: jest.fn(() => jest.fn()),
    isFocused: jest.fn(() => false),
  }),
  useRouter: () => ({
    push: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => false),
  }),
  useLocalSearchParams: () => ({}),
}));

// ── react-native-safe-area-context モック ─────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: any) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── react-native-webview モック ───────────────────────────────────────────────
// WebView の source.uri / injectedJavaScriptBeforeContentLoaded を capture する
const mockWebViewProps: Record<string, any> = {};
jest.mock('react-native-webview', () => ({
  WebView: (props: any) => {
    // テスト側から props を検査できるよう保持する
    Object.assign(mockWebViewProps, props);
    const { View } = require('react-native');
    return <View testID={props.testID ?? 'webview'} />;
  },
}));

// ── expo-file-system / expo-sharing モック ────────────────────────────────────
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/tmp/',
  writeAsStringAsync: jest.fn(),
  EncodingType: { UTF8: 'utf8' },
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(() => Promise.resolve(false)),
  shareAsync: jest.fn(),
}));

// ── supabase モック ───────────────────────────────────────────────────────────
// jest.mock のファクトリはホイストされるため、外部の変数を参照できない。
// 代わりに jest.fn() をファクトリ内で定義し、後から spyOn で差し替える。
jest.mock('../../src/lib/supabase', () => ({
  SUPABASE_AUTH_STORAGE_KEY: 'sb-abcdef1234-auth-token',
  supabase: {
    auth: {
      getSession: jest.fn(),
      refreshSession: jest.fn(),
    },
  },
}));

// モックされたモジュールを import してテスト内で参照する
import { supabase as mockSupabase } from '../../src/lib/supabase';
const mockGetSession = mockSupabase.auth.getSession as jest.Mock;

// ── テーマモック ──────────────────────────────────────────────────────────────
jest.mock('../../src/theme/colors', () => ({
  colors: { accent: '#FF6B35' },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { USER_SCOPED_LOCAL_STORAGE_KEYS } from '@homegohan/shared';

import { WebViewScreen } from '../../src/components/web/WebViewScreen';
import {
  requestWebViewUserScopedStorageClear,
  resetWebViewUserStorageCleanupForTests,
} from '../../src/lib/webViewUserStorageCleanup';

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパー
// ─────────────────────────────────────────────────────────────────────────────
function makeSession(overrides: Partial<{
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  user: object;
}> = {}) {
  return {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    user: { id: 'user-uuid-1', email: 'test@example.com' },
    provider_token: null,
    provider_refresh_token: null,
    ...overrides,
  };
}

// ワンタイム code 発行 API (POST /api/auth/native-bridge/code) のモック
const BRIDGE_CODE = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo';
const mockFetch = jest.fn();
const originalFetch = global.fetch;
afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(async () => {
  jest.clearAllMocks();
  // mockWebViewProps をクリア
  Object.keys(mockWebViewProps).forEach((k) => delete mockWebViewProps[k]);
  // 既定では code 発行に成功する
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ code: BRIDGE_CODE, expires_in: 60 }),
  });
  global.fetch = mockFetch as unknown as typeof fetch;
  // ネイティブのログアウトの印 (ケース 6) を、ほかのケースへ持ち越さない
  resetWebViewUserStorageCleanupForTests();
  await AsyncStorage.clear();
});

/** 注入する JS を、localStorage を持つ偽の window (origin のページ) の上で走らせ、走ったあとの localStorage を返す */
function runInjectedJS(
  js: string,
  initial: Record<string, string>,
  origin: string = WEB_BASE_URL,
): Map<string, string> {
  const items = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (key: string) => (items.has(key) ? (items.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      items.set(key, String(value));
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
  const fakeWindow = { localStorage, dispatchEvent: () => true, location: { origin } };
  // eslint-disable-next-line no-new-func -- 注入する JS の文字列を実際に評価して挙動を確かめるため
  new Function('window', 'Event', js)(fakeWindow, class {});
  return items;
}

/** 前の利用者が残した、利用者別のキーの値 (一覧のすべてのキー) */
function previousUserItems(): Record<string, string> {
  return Object.fromEntries(USER_SCOPED_LOCAL_STORAGE_KEYS.map((key) => [key, 'previous-user']));
}

// ─────────────────────────────────────────────────────────────────────────────
// ケース 1: bridge URL 生成 (ワンタイム code)
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース1: bridge URL 生成', () => {
  it('セッションがある場合に code 付きの /auth/native-bridge URL を構築する', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session } });

    render(<WebViewScreen path="/home" />);

    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    const uri: string = mockWebViewProps.source.uri;
    expect(uri).toContain(`${WEB_BASE_URL}/auth/native-bridge`);
    expect(new URL(uri).searchParams.get('code')).toBe(BRIDGE_CODE);
  });

  it('bridge URL に access_token / refresh_token を載せない (#1036)', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session } });

    render(<WebViewScreen path="/home" />);

    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    const uri: string = mockWebViewProps.source.uri;
    expect(uri).not.toContain('access_token');
    expect(uri).not.toContain('refresh_token');
    expect(uri).not.toContain(session.access_token);
    expect(uri).not.toContain(session.refresh_token);
  });

  it('bridge URL の next パラメータに mode=app が含まれる', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session } });

    render(<WebViewScreen path="/home" />);

    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    const uri: string = mockWebViewProps.source.uri;
    const urlObj = new URL(uri);
    const next = decodeURIComponent(urlObj.searchParams.get('next') ?? '');
    expect(next).toContain('mode=app');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 2: mode=app 重複付与の抑制
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース2: mode=app 重複付与の抑制', () => {
  it('path に既に mode=app が含まれていても重複して付与しない', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session } });

    render(<WebViewScreen path="/home?mode=app" />);

    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    const uri: string = mockWebViewProps.source.uri;
    const urlObj = new URL(uri);
    const next = decodeURIComponent(urlObj.searchParams.get('next') ?? '');
    // mode=app が 2 回以上出現しないこと
    const modeAppCount = (next.match(/mode=app/g) ?? []).length;
    expect(modeAppCount).toBe(1);
  });

  it('セッションなし直接 URL でも mode=app が重複しない', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });

    render(<WebViewScreen path="/menus?mode=app" />);

    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    const uri: string = mockWebViewProps.source.uri;
    const modeAppCount = (uri.match(/mode=app/g) ?? []).length;
    expect(modeAppCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 3: WebView にセッションを注入しない (#1036)
//   旧実装は injectedJavaScriptBeforeContentLoaded で sb-*-auth-token を localStorage に書き込んでいた。
//   Web のクライアントは Cookie を読むため不要で、しかも全オリジンで実行されていた。
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース3: WebView にセッションを注入しない', () => {
  it('セッションがあっても injectedJavaScriptBeforeContentLoaded を渡さない', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session } });

    render(<WebViewScreen path="/home" />);

    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    expect(mockWebViewProps.injectedJavaScriptBeforeContentLoaded).toBeUndefined();
  });

  it('注入スクリプトに localStorage への書込みやプロジェクト参照キー (sb-*-auth-token) が無い', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session } });

    render(<WebViewScreen path="/home" />);

    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    const js: string = mockWebViewProps.injectedJavaScript ?? '';
    expect(js).not.toContain('localStorage');
    expect(js).not.toMatch(/sb-[^'"]*-auth-token/);
  });

  it('source・注入スクリプトのどこにも access_token / refresh_token / user が現れない', async () => {
    const session = makeSession({ access_token: 'unique-access-xyz', refresh_token: 'unique-refresh-xyz' });
    mockGetSession.mockResolvedValue({ data: { session } });

    render(<WebViewScreen path="/home" />);

    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    const serialized = JSON.stringify({
      source: mockWebViewProps.source,
      injectedJavaScript: mockWebViewProps.injectedJavaScript,
      injectedJavaScriptBeforeContentLoaded: mockWebViewProps.injectedJavaScriptBeforeContentLoaded,
    });
    expect(serialized).not.toContain('unique-access-xyz');
    expect(serialized).not.toContain('unique-refresh-xyz');
    expect(serialized).not.toContain('test@example.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 4: セッション無し時の直接 URL 遷移
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース4: セッション無し時の直接 URL 遷移', () => {
  it('セッションなし時は native-bridge を経由せず直接 URL を使う', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });

    render(<WebViewScreen path="/home" />);

    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    const uri: string = mockWebViewProps.source.uri;
    expect(uri).not.toContain('/auth/native-bridge');
    expect(uri).toContain(`${WEB_BASE_URL}/home`);
    expect(uri).toContain('mode=app');
  });

  it('セッションなし時は injectedJavaScriptBeforeContentLoaded が空または undefined', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });

    render(<WebViewScreen path="/home" />);

    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    // 空文字 or undefined のどちらも許容 (falsy)
    const js = mockWebViewProps.injectedJavaScriptBeforeContentLoaded;
    expect(js === undefined || js === '' || js === null).toBe(true);
  });

  it('セッションなし + path にクエリあり時も mode=app が付与される', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });

    render(<WebViewScreen path="/profile?tab=settings" />);

    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    const uri: string = mockWebViewProps.source.uri;
    expect(uri).toContain('mode=app');
    expect(uri).toContain('tab=settings');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 5: header (Issue #1037 — マイページの歯車からネイティブの設定画面へ)
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース5: header (Issue #1037)', () => {
  const { Pressable, Text } = require('react-native');

  it('header が未指定の場合は何も足さない', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });

    const { queryByTestId } = render(<WebViewScreen path="/home" />);

    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    expect(queryByTestId('test-header')).toBeNull();
  });

  it('header は WebView の読み込み前 (ローディング中) から表示され、押せる', async () => {
    let resolveSession: ((value: unknown) => void) | undefined;
    mockGetSession.mockImplementation(() => new Promise((resolve) => { resolveSession = resolve; }));
    const onPress = jest.fn();

    const { getByTestId } = render(
      <WebViewScreen
        path="/profile"
        testID="webview-profile"
        header={<Pressable testID="test-header" onPress={onPress}><Text>設定</Text></Pressable>}
      />,
    );

    // セッションの取得が終わっていない (uri がまだ無い) 間も出ている
    expect(mockWebViewProps.source?.uri).toBeUndefined();
    fireEvent.press(getByTestId('test-header'));
    expect(onPress).toHaveBeenCalledTimes(1);

    resolveSession?.({ data: { session: null } });
    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    // 読み込み後も同じ部品が出続ける
    expect(getByTestId('test-header')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 6: ネイティブのログアウト・退会のあとの localStorage の掃除 (#1037)
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース6: ネイティブのログアウトのあと、Web のページの前に利用者別の localStorage を消す (#1037)', () => {
  it('ログアウトのあとに開く WebView (ログイン中) は、利用者別のキーを消し、セッションのキーには触れない (セッションは Cookie)', async () => {
    await requestWebViewUserScopedStorageClear();
    mockGetSession.mockResolvedValue({
      data: { session: makeSession({ access_token: 'unique-access-c6', refresh_token: 'unique-refresh-c6' }) },
    });

    render(<WebViewScreen path="/home" />);
    await waitFor(() => {
      expect(mockWebViewProps.injectedJavaScriptBeforeContentLoaded).toBeDefined();
    });

    // 掃除と code 方式の bridge が両方入る (どちらも消さない)
    expect(mockWebViewProps.source.uri).toContain(`/auth/native-bridge?code=${BRIDGE_CODE}`);
    const js: string = mockWebViewProps.injectedJavaScriptBeforeContentLoaded;
    // 掃除の JS にトークンは載らない (#1036)
    expect(js).not.toContain('unique-access-c6');
    expect(js).not.toContain('unique-refresh-c6');

    const after = runInjectedJS(js, { ...previousUserItems(), 'sb-abcdef1234-auth-token': 'old-session' });

    expect(USER_SCOPED_LOCAL_STORAGE_KEYS.filter((key) => after.has(key))).toEqual([]);
    // 掃除はセッションのキーを読み書きしない (セッションを localStorage に書かなくなった #1036 のあとも、消しも書きもしない)
    expect(after.get('sb-abcdef1234-auth-token')).toBe('old-session');
  });

  it('ログアウトのあとに開く WebView (未ログイン) でも、利用者別のキーを消す', async () => {
    await requestWebViewUserScopedStorageClear();
    mockGetSession.mockResolvedValue({ data: { session: null } });

    render(<WebViewScreen path="/home" />);
    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    const js: string = mockWebViewProps.injectedJavaScriptBeforeContentLoaded;
    expect(js).toEqual(expect.any(String));
    const after = runInjectedJS(js, previousUserItems());
    expect(USER_SCOPED_LOCAL_STORAGE_KEYS.filter((key) => after.has(key))).toEqual([]);
  });

  it('掃除の JS は自アプリのオリジン以外のページでは何もしない (外部サイトの localStorage を消さない・書かない) (#1036)', async () => {
    await requestWebViewUserScopedStorageClear();
    mockGetSession.mockResolvedValue({ data: { session: makeSession() } });

    render(<WebViewScreen path="/home" />);
    await waitFor(() => {
      expect(mockWebViewProps.injectedJavaScriptBeforeContentLoaded).toBeDefined();
    });

    const js: string = mockWebViewProps.injectedJavaScriptBeforeContentLoaded;
    for (const foreignOrigin of ['https://evil.example', 'https://homegohan-app.vercel.app.evil.com', 'null']) {
      const after = runInjectedJS(js, previousUserItems(), foreignOrigin);
      // 何も消さず、済んだ掃除の印も書かない (= 渡したままの中身)
      expect(Object.fromEntries(after)).toEqual(previousUserItems());
    }
    // 同じ JS が自オリジンでは消す (ガードが常に止めているのではないことの確認)
    const own = runInjectedJS(js, previousUserItems(), WEB_BASE_URL);
    expect(USER_SCOPED_LOCAL_STORAGE_KEYS.filter((key) => own.has(key))).toEqual([]);
  });

  it('一度もログアウトしていなければ、読み込み前の注入はしない (ログイン中の利用者の値を残す)', async () => {
    mockGetSession.mockResolvedValue({ data: { session: makeSession() } });

    render(<WebViewScreen path="/home" />);
    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    expect(mockWebViewProps.injectedJavaScriptBeforeContentLoaded).toBeUndefined();
  });
});
