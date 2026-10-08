/**
 * WebViewScreen のタブ間移動 (tab-navigate) のテスト (#1049 F7-22)
 *
 * タブ間のリンクは、WebView の中で 2 か所がインターセプトして tab-navigate メッセージを送ってくる。
 *   - ネイティブが WebView に注入するスクリプト
 *   - Web の NativeAppTabRouter
 * 以前は 2 つが別々のタブ一覧を持っていて (ネイティブは '/meals'、Web は '/meals/new')、
 * Web が送る path ('/meals/new') がネイティブの一覧に無く、メッセージが読み捨てられていた。
 * 今はどちらも @homegohan/shared の NATIVE_APP_TABS を見る。
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

import { NATIVE_APP_TABS } from '@homegohan/shared';

const WEB_BASE_URL = 'https://homegohan-app.vercel.app';
process.env.EXPO_PUBLIC_WEB_URL = WEB_BASE_URL;

// ── expo-router モック ────────────────────────────────────────────────────────
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useNavigation: () => ({
    addListener: jest.fn(() => jest.fn()),
    isFocused: jest.fn(() => false),
  }),
  useRouter: () => ({
    push: (...args: unknown[]) => mockPush(...args),
    back: jest.fn(),
    canGoBack: jest.fn(() => false),
  }),
  useLocalSearchParams: () => ({}),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: any) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// WebView の props (onMessage / injectedJavaScript) を取り出せるようにする
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

jest.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) } },
}));

jest.mock('../../src/theme/colors', () => ({
  colors: { accent: '#FF6B35' },
}));

import { WebViewScreen } from '../../src/components/web/WebViewScreen';

/** WebView からのメッセージを onMessage に流す */
function receive(message: unknown) {
  mockWebViewProps.onMessage({
    nativeEvent: { data: JSON.stringify(message), url: `${WEB_BASE_URL}/home` },
  });
}

async function renderScreen() {
  render(<WebViewScreen path="/home" />);
  await waitFor(() => {
    expect(mockWebViewProps.onMessage).toBeDefined();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockWebViewProps).forEach((k) => delete mockWebViewProps[k]);
});

describe('tab-navigate メッセージの受け取り', () => {
  it("Web 側 (NativeAppTabRouter) が '/meals/new' のようにタブ配下のパスを送ってきても、meals タブとして扱う", async () => {
    await renderScreen();

    receive({ type: 'tab-navigate', path: '/meals/new', fullPath: '/meals/new' });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/(tabs)/meals',
      params: { initialPath: '/meals/new' },
    });
  });

  it('タブの prefix そのものが来た場合 (注入スクリプトの形) も同じタブで、クエリは initialPath に残す', async () => {
    await renderScreen();

    receive({ type: 'tab-navigate', path: '/meals', fullPath: '/meals/new?from=home' });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/(tabs)/meals',
      params: { initialPath: '/meals/new?from=home' },
    });
  });

  it('fullPath が prefix と同じなら、タブを切り替えるだけ (initialPath を付けない)', async () => {
    await renderScreen();

    receive({ type: 'tab-navigate', path: '/menus', fullPath: '/menus' });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/menus');
  });

  it('表の全タブについて、prefix を送ればそのタブのルートへ切り替わる', async () => {
    await renderScreen();

    for (const tab of NATIVE_APP_TABS) {
      mockPush.mockClear();
      receive({ type: 'tab-navigate', path: tab.pathPrefix, fullPath: tab.pathPrefix });
      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(tab.route);
      });
    }
  });

  it('タブに属さない path・不正な path は無視する (例外も出さない)', async () => {
    await renderScreen();

    receive({ type: 'tab-navigate', path: '/family', fullPath: '/family' });
    receive({ type: 'tab-navigate', path: '/homepage', fullPath: '/homepage' });
    receive({ type: 'tab-navigate', path: 123, fullPath: '/home' });
    receive({ type: 'tab-navigate', fullPath: '/home' });

    // setTimeout(0) で push される実装なので、少し待ってから何も呼ばれていないことを確かめる
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('WebView に注入するタブ判定スクリプト', () => {
  it('タブの一覧は NATIVE_APP_TABS の pathPrefix と同じ (Web 側と同じ表)', async () => {
    await renderScreen();

    const script: string = mockWebViewProps.injectedJavaScript;
    const match = /var TAB_PATHS = (\[.*?\]);/.exec(script);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toEqual(NATIVE_APP_TABS.map((tab) => tab.pathPrefix));
  });
});
