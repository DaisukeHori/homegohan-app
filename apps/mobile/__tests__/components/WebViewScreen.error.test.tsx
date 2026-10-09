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

  // onLoadStart と onHttpError が来る順序は OS で逆 (react-native-webview 13.13.5)。
  //   iOS:     onLoadStart → onHttpError → onLoadEnd
  //   Android: onHttpError → onLoadStart → onLoadEnd (onLoadStart は doUpdateVisitedHistory = ページの確定で発火するため)
  // どちらの順でも、5xx の案内が出たまま残ること (Android で消えて、サーバーのエラーページがそのまま見えないこと)。
  const PAGE = 'https://example.test/menus/weekly';

  it('iOS の順 (onLoadStart → onHttpError → onLoadEnd) で、5xx の案内が出て、読み込みが終わっても残る', async () => {
    await renderScreen();

    act(() => {
      mockLastWebViewProps.onLoadStart?.({ nativeEvent: { url: PAGE, navigationType: 'other' } });
      mockLastWebViewProps.onHttpError({ nativeEvent: { statusCode: 503, url: PAGE } });
    });
    expect(screen.getByText(/サーバーに接続できませんでした \(エラー 503\)/)).toBeTruthy();

    act(() => {
      mockLastWebViewProps.onLoadEnd({ nativeEvent: { url: PAGE } });
    });
    expect(screen.getByText(/サーバーに接続できませんでした \(エラー 503\)/)).toBeTruthy();
    expect(screen.getByText('再読み込み')).toBeTruthy();
  });

  it('Android の順 (onHttpError → onLoadStart → onLoadEnd) でも、5xx の案内が出て、残る (同じ読み込みの onLoadStart で消えない)', async () => {
    await renderScreen();

    act(() => {
      mockLastWebViewProps.onHttpError({ nativeEvent: { statusCode: 503, url: PAGE } });
    });
    expect(screen.getByText(/エラー 503/)).toBeTruthy();

    // 同じ読み込みのページの確定 (Android の onLoadStart)
    act(() => {
      mockLastWebViewProps.onLoadStart?.({ nativeEvent: { url: PAGE } });
    });
    expect(screen.getByText(/エラー 503/)).toBeTruthy();

    act(() => {
      mockLastWebViewProps.onLoadEnd({ nativeEvent: { url: PAGE } });
    });
    expect(screen.getByText(/エラー 503/)).toBeTruthy();
    expect(screen.getByText('再読み込み')).toBeTruthy();
  });

  it('5xx の読み込みが終わったあとに、5xx を受けない読み直しが終わったら (成功したら)、失敗の案内を消す', async () => {
    await renderScreen();
    act(() => {
      mockLastWebViewProps.onHttpError({ nativeEvent: { statusCode: 503, url: PAGE } });
      mockLastWebViewProps.onLoadEnd({ nativeEvent: { url: PAGE } });
    });
    expect(screen.getByTestId('webview-error')).toBeTruthy();

    // タブの再タップ (location.replace) などによる読み直し。成功すると、HTTP エラー無しで onLoadStart と onLoadEnd だけが来る
    act(() => {
      mockLastWebViewProps.onLoadStart?.({ nativeEvent: { url: PAGE } });
    });
    // 読み込んでいる間は、案内を出したまま
    expect(screen.getByTestId('webview-error')).toBeTruthy();

    act(() => {
      mockLastWebViewProps.onLoadEnd({ nativeEvent: { url: PAGE } });
    });
    expect(screen.queryByTestId('webview-error')).toBeNull();
  });

  it('読み直しもまた 5xx なら、案内は残り続ける (ステータスは新しい方になる)', async () => {
    await renderScreen();
    act(() => {
      mockLastWebViewProps.onHttpError({ nativeEvent: { statusCode: 503, url: PAGE } });
      mockLastWebViewProps.onLoadStart?.({ nativeEvent: { url: PAGE } });
      mockLastWebViewProps.onLoadEnd({ nativeEvent: { url: PAGE } });
    });

    // 2 回目 (Android の順)
    act(() => {
      mockLastWebViewProps.onHttpError({ nativeEvent: { statusCode: 502, url: PAGE } });
      mockLastWebViewProps.onLoadStart?.({ nativeEvent: { url: PAGE } });
      mockLastWebViewProps.onLoadEnd({ nativeEvent: { url: PAGE } });
    });

    expect(screen.getByText(/エラー 502/)).toBeTruthy();
    expect(screen.queryByText(/エラー 503/)).toBeNull();
  });

  it('iOS が history の書き換え (ページ内の移動) のたびに送る onLoadEnd では、5xx の案内を消さない', async () => {
    await renderScreen();
    act(() => {
      mockLastWebViewProps.onLoadStart?.({ nativeEvent: { url: PAGE, navigationType: 'other' } });
      mockLastWebViewProps.onHttpError({ nativeEvent: { statusCode: 500, url: PAGE } });
      mockLastWebViewProps.onLoadEnd({ nativeEvent: { url: PAGE } });
    });

    // エラーページ自身の history.replaceState / pushState / 戻る。読み込みの終わりではない (navigationType を持つ)
    act(() => {
      mockLastWebViewProps.onLoadEnd({ nativeEvent: { url: PAGE, navigationType: 'other' } });
      mockLastWebViewProps.onLoadEnd({ nativeEvent: { url: PAGE, navigationType: 'backforward' } });
    });

    expect(screen.getByText(/エラー 500/)).toBeTruthy();
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
