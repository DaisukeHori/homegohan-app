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
 *
 * WebView のナビゲーション制限・postMessage の送信元検証・code 発行失敗時のフォールバック等は
 * WebViewScreen.bridge.test.tsx にある。
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

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
jest.mock('expo-file-system', () => ({
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

import { WebViewScreen } from '../../src/components/web/WebViewScreen';

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

beforeEach(() => {
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
});

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
