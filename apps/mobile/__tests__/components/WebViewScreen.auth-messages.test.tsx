/**
 * WebViewScreen — Web からのログアウト・セッション失効の通知 (#1038 F7-04 / F7-05)
 *
 * WebView の onMessage に { type: 'sign-out' } / { type: 'session-expired' } が届いたとき、
 *   - sign-out        : ネイティブもログアウトして、ウェルカム画面へ戻る
 *   - session-expired : ネイティブのセッションを確かめたうえで、同じタブを新しい bridge で開き直す
 *                       (initialPath に使い捨ての値 _rb を付けて、WebViewScreen の「initialPath が変わったら bridge をやり直す」
 *                        仕組みに乗せる。WebViewScreen 本体の中身には手を入れない)
 * ことを、実際の WebViewScreen と useWebAuthMessages をつないで確かめる。処理そのものの細かい場合分けは
 * web-view-auth-messages.test.ts で確かめている。
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

const WEB_BASE_URL = 'https://homegohan-app.vercel.app';
process.env.EXPO_PUBLIC_WEB_URL = WEB_BASE_URL;
process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://abcdef1234.supabase.co';

// ── expo-router ───────────────────────────────────────────────────────────────
const mockSetParams = jest.fn();
const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockBack = jest.fn();
let mockRouteParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useNavigation: () => ({
    addListener: jest.fn(() => jest.fn()),
    isFocused: jest.fn(() => false),
    setParams: (...args: unknown[]) => mockSetParams(...args),
  }),
  useRouter: () => ({
    push: (...args: unknown[]) => mockPush(...args),
    back: (...args: unknown[]) => mockBack(...args),
    replace: (...args: unknown[]) => mockReplace(...args),
    canGoBack: () => false,
  }),
  useLocalSearchParams: () => mockRouteParams,
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: any) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// WebView の props (onMessage 等) を捕まえる
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
  writeAsStringAsync: jest.fn(),
  EncodingType: { UTF8: 'utf8' },
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(() => Promise.resolve(false)),
  shareAsync: jest.fn(),
}));

// ── supabase / ログアウト処理 ─────────────────────────────────────────────────
const mockGetSession = jest.fn();
const mockGetUser = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getUser: (...args: unknown[]) => mockGetUser(...args),
    },
  },
}));
const mockSignOutWithCleanup = jest.fn();
jest.mock('../../src/lib/signOut', () => ({
  signOutWithCleanup: (...args: unknown[]) => mockSignOutWithCleanup(...args),
}));

jest.mock('../../src/theme/colors', () => ({
  colors: { accent: '#FF6B35' },
}));

import { WebViewScreen } from '../../src/components/web/WebViewScreen';

// ── ヘルパー ──────────────────────────────────────────────────────────────────
const PAGE = `${WEB_BASE_URL}/settings`;

/** WebView の onMessage に、Web 側の postMessage 相当のイベントを流す */
function postFromWeb(message: unknown, url: string = PAGE) {
  mockWebViewProps.onMessage({ nativeEvent: { data: JSON.stringify(message), url } });
}

async function renderScreen(path = '/home') {
  render(<WebViewScreen path={path} />);
  await waitFor(() => expect(mockWebViewProps.source?.uri).toBeDefined());
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockWebViewProps).forEach((k) => delete mockWebViewProps[k]);
  mockRouteParams = {};
  mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mockSignOutWithCleanup.mockResolvedValue({ error: null });
});

describe('WebViewScreen — sign-out (#1038 F7-04)', () => {
  it('Web 側でログアウトされたら、ネイティブも共通のログアウト処理を行い、ウェルカム画面へ戻る', async () => {
    await renderScreen();

    postFromWeb({ type: 'sign-out' });

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(mockSignOutWithCleanup).toHaveBeenCalledWith('user-1');
  });

  it('外部ページから届いた sign-out は無視する', async () => {
    await renderScreen();

    postFromWeb({ type: 'sign-out' }, 'https://evil.example/phish');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockSignOutWithCleanup).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe('WebViewScreen — session-expired (#1038 F7-05)', () => {
  it('同じタブを、使い捨ての _rb を付けた initialPath で開き直させる (bridge をやり直す)', async () => {
    await renderScreen('/home');

    postFromWeb({ type: 'session-expired' });

    await waitFor(() => expect(mockSetParams).toHaveBeenCalledTimes(1));
    const [params] = mockSetParams.mock.calls[0];
    expect(params.initialPath).toMatch(/^\/home\?_rb=\d+$/);
    expect(mockSignOutWithCleanup).not.toHaveBeenCalled();
  });

  it('tab-navigate などで initialPath を持っているタブでは、そのパスを開き直す (クエリは保つ)', async () => {
    mockRouteParams = { initialPath: '/menus/weekly?mode=app&view=day' };
    await renderScreen('/menus');

    postFromWeb({ type: 'session-expired' });

    await waitFor(() => expect(mockSetParams).toHaveBeenCalledTimes(1));
    expect(mockSetParams.mock.calls[0][0].initialPath).toMatch(/^\/menus\/weekly\?mode=app&view=day&_rb=\d+$/);
  });

  it('壊れた initialPath (プロトコル相対 URL など) は基準にせず、タブの既定のパスを開き直す', async () => {
    mockRouteParams = { initialPath: '//evil.example/x' };
    await renderScreen('/home');

    postFromWeb({ type: 'session-expired' });

    await waitFor(() => expect(mockSetParams).toHaveBeenCalledTimes(1));
    expect(mockSetParams.mock.calls[0][0].initialPath).toMatch(/^\/home\?_rb=\d+$/);
  });

  it('ネイティブのセッションも失効していたら、開き直さずログアウトを揃える', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: Object.assign(new Error('gone'), { name: 'AuthApiError', status: 403, code: 'session_not_found' }),
    });
    await renderScreen();

    postFromWeb({ type: 'session-expired' });

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(mockSignOutWithCleanup).toHaveBeenCalledWith('user-1');
    expect(mockSetParams).not.toHaveBeenCalled();
  });

  it('続けて届いた session-expired は、タブごとの回数制限で 2 回目を開き直さない', async () => {
    await renderScreen('/home');

    postFromWeb({ type: 'session-expired' });
    await waitFor(() => expect(mockSetParams).toHaveBeenCalledTimes(1));
    postFromWeb({ type: 'session-expired' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockSetParams).toHaveBeenCalledTimes(1);
  });

  it('外部ページから届いた session-expired は無視する', async () => {
    await renderScreen();

    postFromWeb({ type: 'session-expired' }, 'https://evil.example/phish');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockSetParams).not.toHaveBeenCalled();
  });
});

describe('WebViewScreen — 既存のメッセージ (回帰)', () => {
  it('tab-navigate / navigate-back は従来どおり処理される', async () => {
    jest.useFakeTimers();
    try {
      await renderScreen();

      postFromWeb({ type: 'navigate-back' });
      expect(mockPush).toHaveBeenCalledWith('/(tabs)/home');

      postFromWeb({ type: 'tab-navigate', path: '/menus', fullPath: '/menus' });
      jest.runOnlyPendingTimers();
      expect(mockPush).toHaveBeenCalledWith('/(tabs)/menus');
    } finally {
      jest.useRealTimers();
    }
  });

  it('知らない type や壊れた JSON は何も起こさない', async () => {
    await renderScreen();

    postFromWeb({ type: 'something-else' });
    mockWebViewProps.onMessage({ nativeEvent: { data: '{not json', url: PAGE } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockSignOutWithCleanup).not.toHaveBeenCalled();
    expect(mockSetParams).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
