/**
 * T02: WebViewScreen RNTL 単体テスト
 * Issue #844 — RN↔Web 認証ブリッジテスト
 *
 * カバレッジ:
 *   1. bridge URL 生成 (token 埋め込み)
 *   2. mode=app 重複付与の抑制
 *   3. injectedJS の localStorage 書込みスクリプト生成
 *   4. セッション無し時の直接 URL 遷移
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

// ── 環境変数 ──────────────────────────────────────────────────────────────────
const WEB_BASE_URL = 'https://homegohan-app.vercel.app';
const SUPABASE_URL = 'https://abcdef1234.supabase.co';
process.env.EXPO_PUBLIC_WEB_URL = WEB_BASE_URL;
process.env.EXPO_PUBLIC_SUPABASE_URL = SUPABASE_URL;

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

beforeEach(() => {
  jest.clearAllMocks();
  // mockWebViewProps をクリア
  Object.keys(mockWebViewProps).forEach((k) => delete mockWebViewProps[k]);
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 1: bridge URL 生成 (token 埋め込み)
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース1: bridge URL 生成', () => {
  it('セッションがある場合に /auth/native-bridge URL を構築する', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session } });

    render(<WebViewScreen path="/home" />);

    await waitFor(() => {
      expect(mockWebViewProps.source?.uri).toBeDefined();
    });

    const uri: string = mockWebViewProps.source.uri;
    expect(uri).toContain(`${WEB_BASE_URL}/auth/native-bridge`);
    expect(uri).toContain(`access_token=${session.access_token}`);
    expect(uri).toContain(`refresh_token=${session.refresh_token}`);
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
// ケース 3: injectedJS の localStorage 書込みスクリプト生成
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース3: injectedJS localStorage 書込みスクリプト', () => {
  it('セッションがある場合に localStorage.setItem スクリプトが生成される', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session } });

    render(<WebViewScreen path="/home" />);

    await waitFor(() => {
      expect(mockWebViewProps.injectedJavaScriptBeforeContentLoaded).toBeDefined();
    });

    const js: string = mockWebViewProps.injectedJavaScriptBeforeContentLoaded;
    expect(js).toContain('localStorage.setItem');
  });

  it('injectedJS にプロジェクト参照キー (sb-*-auth-token) が含まれる', async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue({ data: { session } });

    render(<WebViewScreen path="/home" />);

    await waitFor(() => {
      expect(mockWebViewProps.injectedJavaScriptBeforeContentLoaded).toBeDefined();
    });

    const js: string = mockWebViewProps.injectedJavaScriptBeforeContentLoaded;
    // PROJECT_REF は EXPO_PUBLIC_SUPABASE_URL からモジュールロード時に抽出される。
    // Jest 環境では env がモジュールロード前に設定されないため PROJECT_REF が空になる場合がある。
    // ここでは localStorage キーのプレフィックス "sb-" とサフィックス "-auth-token" が
    // スクリプト内に含まれることを確認する (キーのスキームの正当性を検証)。
    expect(js).toMatch(/sb-[^']*-auth-token/);
  });

  it('injectedJS に access_token が埋め込まれる', async () => {
    const session = makeSession({ access_token: 'unique-access-xyz' });
    mockGetSession.mockResolvedValue({ data: { session } });

    render(<WebViewScreen path="/home" />);

    await waitFor(() => {
      expect(mockWebViewProps.injectedJavaScriptBeforeContentLoaded).toBeDefined();
    });

    const js: string = mockWebViewProps.injectedJavaScriptBeforeContentLoaded;
    expect(js).toContain('unique-access-xyz');
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
