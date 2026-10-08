/**
 * WebViewScreen.error.test.tsx
 * WebView の読み込み失敗時の表示と再読み込み (WebViewScreen / WebViewErrorView) のテスト (#1049 F7-15)
 *
 * 以前は、読み込みに失敗したときの表示が何も無かった。
 *  - オフライン・DNS 失敗・タイムアウトでは、ライブラリ既定の英語の文字が出るだけ
 *  - サーバーが 5xx を返すと、サーバーのエラーページがそのまま出る
 *  - どちらも、画面の中に再試行の手段が無い (タブの再タップで戻るしかない)
 * 今は、日本語の案内と「再読み込み」を出す。「再読み込み」は WebView の reload() ではなく、
 * 認証ブリッジの準備からやり直す (ブリッジの URL に使い捨ての値が入っていても、新しい URL で読み込むため)。
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// ── expo-router モック (WebView 以外の依存) ───────────────────────────────────
const mockNavigation = {
  addListener: jest.fn(() => jest.fn()),
  isFocused: jest.fn(() => false),
  setParams: jest.fn(),
  getParent: jest.fn(() => undefined),
};
const mockRouter = { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => false) };
jest.mock('expo-router', () => ({
  useNavigation: () => mockNavigation,
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-file-system', () => ({
  documentDirectory: '/tmp/',
  writeAsStringAsync: jest.fn(),
  EncodingType: { UTF8: 'utf8' },
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(() => Promise.resolve(false)),
  shareAsync: jest.fn(),
}));

// ── react-native-webview モック ───────────────────────────────────────────────
// 本物と同じく、読み込み失敗 (onError 相当) になると renderError の結果を重ねて出す。
// 作り直された (マウントされた) 回数と、直近の props を記録する。
let mockLastWebViewProps: Record<string, any> = {};
let mockWebViewMountCount = 0;
let mockFailWebViewLoad: ((error: { domain?: string; code: number; description: string } | null) => void) | null = null;

jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    WebView: (props: any) => {
      mockLastWebViewProps = props;
      const [nativeError, setNativeError] = React.useState(null);
      React.useEffect(() => {
        mockWebViewMountCount += 1;
        mockFailWebViewLoad = setNativeError;
      }, []);
      return (
        <View testID={props.testID ?? 'webview'}>
          {nativeError ? props.renderError(nativeError.domain, nativeError.code, nativeError.description) : null}
        </View>
      );
    },
  };
});

// ── supabase モック ───────────────────────────────────────────────────────────
jest.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn() } },
}));
import { supabase as mockSupabase } from '../../src/lib/supabase';
const mockGetSession = mockSupabase.auth.getSession as jest.Mock;

import { WebViewScreen } from '../../src/components/web/WebViewScreen';

function makeSession() {
  return {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    user: { id: 'user-uuid-1', email: 'test@example.com' },
    provider_token: null,
    provider_refresh_token: null,
  };
}

async function renderScreen() {
  const view = render(<WebViewScreen path="/menus/weekly" />);
  // セッションの確認 (init) が終わって WebView が出るまで待つ
  await waitFor(() => {
    expect(mockWebViewMountCount).toBe(1);
  });
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLastWebViewProps = {};
  mockWebViewMountCount = 0;
  mockFailWebViewLoad = null;
  mockGetSession.mockResolvedValue({ data: { session: makeSession() } });
});

describe('WebViewScreen — 読み込み失敗の表示 (端末側の失敗)', () => {
  it('通常は、エラー表示を出さない', async () => {
    await renderScreen();

    expect(screen.queryByTestId('webview-error')).toBeNull();
  });

  it('オフラインなどで読み込みに失敗すると、日本語の案内と「再読み込み」を出す', async () => {
    await renderScreen();

    act(() => {
      mockFailWebViewLoad?.({ domain: 'NSURLErrorDomain', code: -1009, description: 'The Internet connection appears to be offline.' });
    });

    expect(screen.getByTestId('webview-error')).toBeTruthy();
    expect(screen.getByText('画面を読み込めませんでした')).toBeTruthy();
    expect(screen.getByText(/通信に失敗しました。ネットワークの接続を確認して/)).toBeTruthy();
    expect(screen.getByText('再読み込み')).toBeTruthy();
  });

  it('「再読み込み」を押すと、セッションの確認からやり直して WebView を作り直す (reload() ではない)', async () => {
    await renderScreen();
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    act(() => {
      mockFailWebViewLoad?.({ domain: 'NSURLErrorDomain', code: -1001, description: 'The request timed out.' });
    });

    fireEvent.press(screen.getByTestId('webview-error-retry'));

    // 認証ブリッジの準備 (init) がもう一度走り、新しい WebView がマウントされる
    await waitFor(() => {
      expect(mockWebViewMountCount).toBe(2);
    });
    expect(mockGetSession).toHaveBeenCalledTimes(2);
    // 作り直した WebView にはエラー表示が残らない
    expect(screen.queryByTestId('webview-error')).toBeNull();
  });
});

describe('WebViewScreen — 読み込み失敗の表示 (サーバーが 5xx を返した)', () => {
  it('503 なら、ステータスを添えた案内と「再読み込み」を出す', async () => {
    await renderScreen();

    act(() => {
      mockLastWebViewProps.onHttpError({ nativeEvent: { statusCode: 503 } });
    });

    expect(screen.getByTestId('webview-error')).toBeTruthy();
    expect(screen.getByText(/サーバーに接続できませんでした \(エラー 503\)/)).toBeTruthy();
    expect(screen.getByText('再読み込み')).toBeTruthy();
  });

  it('500 台はすべて対象。404 や 403 など 4xx は、Web 側のページの案内に任せて何も出さない', async () => {
    await renderScreen();

    act(() => {
      mockLastWebViewProps.onHttpError({ nativeEvent: { statusCode: 404 } });
      mockLastWebViewProps.onHttpError({ nativeEvent: { statusCode: 403 } });
    });
    expect(screen.queryByTestId('webview-error')).toBeNull();

    act(() => {
      mockLastWebViewProps.onHttpError({ nativeEvent: { statusCode: 502 } });
    });
    expect(screen.getByText(/エラー 502/)).toBeTruthy();
  });

  it('新しい読み込みが始まったら (読み直しが成功したら)、失敗の表示を消す', async () => {
    await renderScreen();
    act(() => {
      mockLastWebViewProps.onHttpError({ nativeEvent: { statusCode: 503 } });
    });
    expect(screen.getByTestId('webview-error')).toBeTruthy();

    act(() => {
      mockLastWebViewProps.onLoadStart({ nativeEvent: { url: 'https://example.test/' } });
    });

    expect(screen.queryByTestId('webview-error')).toBeNull();
  });

  it('「再読み込み」を押すと、セッションの確認からやり直して WebView を作り直す', async () => {
    await renderScreen();
    act(() => {
      mockLastWebViewProps.onHttpError({ nativeEvent: { statusCode: 503 } });
    });

    fireEvent.press(screen.getByTestId('webview-error-retry'));

    await waitFor(() => {
      expect(mockWebViewMountCount).toBe(2);
    });
    expect(mockGetSession).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('webview-error')).toBeNull();
  });
});
