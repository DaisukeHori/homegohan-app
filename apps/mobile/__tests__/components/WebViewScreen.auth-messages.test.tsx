/**
 * WebViewScreen — Web からのログアウト・セッション失効の通知 (#1038 F7-04 / F7-05)
 *
 * WebView の onMessage に { type: 'sign-out' } / { type: 'session-expired' } が届いたとき、
 *   - sign-out        : ネイティブもログアウトして、ウェルカム画面へ戻る
 *   - session-expired : ネイティブのセッションを確かめたうえで、同じ画面 (タブ、タブ以外の /settings/ai-consent) を新しい bridge で開き直す
 *                       (いま開いているパス = WebViewScreen が initialPath を検証したあとの effectivePath に使い捨ての値 _rb を付けて
 *                        initialPath に入れ、WebViewScreen の「initialPath が変わったら bridge をやり直す」仕組みに乗せる)
 *   - mfa-verify-required : ネイティブの確認画面 (NativeMfaVerifyModal) を出し、確認が済んだら閉じて、いま開いているパスを
 *                           _rb を付けて開き直す (回数制限を通さない。#1707 段 D・docs/design/cross/12-operator-mfa.md §16.4.5)
 * ことを、実際の WebViewScreen と useWebAuthMessages をつないで確かめる。処理そのものの細かい場合分けは
 * web-view-auth-messages.test.ts で確かめている。
 */

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

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

jest.mock('expo-file-system/legacy', () => ({
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
  SUPABASE_AUTH_STORAGE_KEY: 'sb-abcdef1234-auth-token',
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

// 確認画面の中身 (AAL の判定と 6 桁) は NativeMfaVerifyModal.test.tsx / MfaVerifyGate.test.tsx で確かめる。
// ここでは WebViewScreen が出す・閉じる・確認の後に開き直すことだけを見るので、onVerified / onClose を押せる部品に差し替える
jest.mock('../../src/components/NativeMfaVerifyModal', () => {
  const { Pressable, Text, View } = require('react-native');
  return {
    NativeMfaVerifyModal: ({ onVerified, onClose }: { onVerified: () => void; onClose: () => void }) => (
      <View testID="native-mfa-verify-modal">
        <Pressable testID="mock-native-mfa-verified" onPress={() => onVerified()}>
          <Text>verified</Text>
        </Pressable>
        <Pressable testID="native-mfa-verify-close" onPress={() => onClose()}>
          <Text>close</Text>
        </Pressable>
      </View>
    ),
  };
});

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
  mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' }, access_token: 'access-1' } } });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mockSignOutWithCleanup.mockResolvedValue({ error: null });
});

describe('WebViewScreen — sign-out (#1038 F7-04)', () => {
  it('Web 側でログアウトされたら、ネイティブも共通のログアウト処理を行い、ウェルカム画面へ戻る', async () => {
    await renderScreen();

    postFromWeb({ type: 'sign-out' });

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(mockSignOutWithCleanup).toHaveBeenCalledWith('user-1', { accessToken: 'access-1' });
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

  // expo-router の setParams がルートのパラメータを書き換えて再描画するのを、テストの中で再現する
  function applySetParamsOnce() {
    mockSetParams.mockImplementationOnce((next: Record<string, string>) => {
      mockRouteParams = { ...mockRouteParams, ...next };
    });
  }

  // タブ以外の画面 (main の #1451: app/settings/ai-consent.tsx)。ここで再 bridge が効かないと、Web 側は refresh_token を
  // 持たないので access_token の期限で同意画面のセッションが切れ、利用者は同意できなくなる
  it('タブ以外の画面 (/settings/ai-consent) でも _rb を付けて開き直し、WebView の URL が差し替わる', async () => {
    applySetParamsOnce();
    const { rerender } = render(<WebViewScreen path="/settings/ai-consent" />);
    await waitFor(() => expect(mockWebViewProps.source?.uri).toBe(`${WEB_BASE_URL}/settings/ai-consent?mode=app`));

    postFromWeb({ type: 'session-expired' });
    await waitFor(() => expect(mockSetParams).toHaveBeenCalledTimes(1));
    const { initialPath } = mockSetParams.mock.calls[0][0];
    expect(initialPath).toMatch(/^\/settings\/ai-consent\?_rb=\d+$/);

    rerender(<WebViewScreen path="/settings/ai-consent" />);
    await waitFor(() => expect(mockWebViewProps.source.uri).toBe(`${WEB_BASE_URL}${initialPath}&mode=app`));
  });

  // deep link の initialPath は WebViewScreen の検証で弾かれるとタブの既定のパスに戻る。
  // 弾かれた値を基準に _rb を付けると、また既定のパスに戻されて URL が変わらず、開き直しが起きない
  it('検証で弾かれた initialPath (deep link の認証ブリッジ) を持つタブは、いま開いているタブのパスで開き直す', async () => {
    mockRouteParams = { initialPath: '/auth/native-bridge?code=ATTACKERCODE&next=%2Fhome' };
    applySetParamsOnce();
    const { rerender } = render(<WebViewScreen path="/home" />);
    await waitFor(() => expect(mockWebViewProps.source?.uri).toBe(`${WEB_BASE_URL}/home?mode=app`));

    postFromWeb({ type: 'session-expired' });
    await waitFor(() => expect(mockSetParams).toHaveBeenCalledTimes(1));
    const { initialPath } = mockSetParams.mock.calls[0][0];
    expect(initialPath).toMatch(/^\/home\?_rb=\d+$/);

    rerender(<WebViewScreen path="/home" />);
    await waitFor(() => expect(mockWebViewProps.source.uri).toBe(`${WEB_BASE_URL}${initialPath}&mode=app`));
  });

  it('2 回目の再 bridge は前の _rb を付け替える (付け足さない)', async () => {
    mockRouteParams = { initialPath: '/home?_rb=1' };
    await renderScreen('/home');

    postFromWeb({ type: 'session-expired' });
    await waitFor(() => expect(mockSetParams).toHaveBeenCalledTimes(1));
    expect(mockSetParams.mock.calls[0][0].initialPath).toMatch(/^\/home\?_rb=\d+$/);
    expect(mockSetParams.mock.calls[0][0].initialPath).not.toBe('/home?_rb=1');
  });

  it('ネイティブのセッションも失効していたら、開き直さずログアウトを揃える', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: Object.assign(new Error('gone'), { name: 'AuthApiError', status: 403, code: 'session_not_found' }),
    });
    await renderScreen();

    postFromWeb({ type: 'session-expired' });

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(mockSignOutWithCleanup).toHaveBeenCalledWith('user-1', { accessToken: 'access-1' });
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

describe('WebViewScreen — mfa-verify-required (#1707 段 D。cross/12 §16.4.5)', () => {
  const VERIFY_PAGE = `${WEB_BASE_URL}/settings/security/mfa/verify?next=%2Fadmin`;

  it('要求が無いときは確認画面を描かない', async () => {
    const utils = render(<WebViewScreen path="/home" />);
    await waitFor(() => expect(mockWebViewProps.source?.uri).toBeDefined());

    expect(utils.queryByTestId('native-mfa-verify-modal')).toBeNull();
  });

  it('mfa-verify-required で NativeMfaVerifyModal を出し、onVerified で閉じて _rb を付けた initialPath で開き直す', async () => {
    const utils = render(<WebViewScreen path="/home" />);
    await waitFor(() => expect(mockWebViewProps.source?.uri).toBeDefined());
    // 開くときの bridge (getSessionForBridge) が呼んだ分を数えない
    mockGetSession.mockClear();
    mockGetUser.mockClear();

    await act(async () => {
      postFromWeb({ type: 'mfa-verify-required' }, VERIFY_PAGE);
    });
    await waitFor(() => expect(utils.getByTestId('native-mfa-verify-modal')).toBeTruthy());
    // 確認が済むまでは開き直さない (Web のセッションの確認・ログアウトもしない)
    expect(mockSetParams).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();

    fireEvent.press(utils.getByTestId('mock-native-mfa-verified'));

    expect(utils.queryByTestId('native-mfa-verify-modal')).toBeNull();
    expect(mockSetParams).toHaveBeenCalledTimes(1);
    expect(mockSetParams.mock.calls[0][0].initialPath).toMatch(/^\/home\?_rb=\d+$/);
    expect(mockSignOutWithCleanup).not.toHaveBeenCalled();
  });

  it('直前に session-expired で開き直していても、回数制限を通さずに開き直す', async () => {
    const utils = render(<WebViewScreen path="/home" />);
    await waitFor(() => expect(mockWebViewProps.source?.uri).toBeDefined());

    postFromWeb({ type: 'session-expired' });
    await waitFor(() => expect(mockSetParams).toHaveBeenCalledTimes(1));
    // 回数制限 (10 秒以上の間隔) の内なので、続けて届いた session-expired は開き直さない
    postFromWeb({ type: 'session-expired' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockSetParams).toHaveBeenCalledTimes(1);

    await act(async () => {
      postFromWeb({ type: 'mfa-verify-required' }, VERIFY_PAGE);
    });
    await waitFor(() => expect(utils.getByTestId('native-mfa-verify-modal')).toBeTruthy());
    fireEvent.press(utils.getByTestId('mock-native-mfa-verified'));

    expect(mockSetParams).toHaveBeenCalledTimes(2);
    expect(mockSetParams.mock.calls[1][0].initialPath).toMatch(/^\/home\?_rb=\d+$/);
  });

  it('tab-navigate などで initialPath を持っているタブでは、verify の画面の next ではなく、そのタブのいまのパスを開き直す', async () => {
    mockRouteParams = { initialPath: '/menus/weekly?mode=app&view=day' };
    const utils = render(<WebViewScreen path="/menus" />);
    await waitFor(() => expect(mockWebViewProps.source?.uri).toBeDefined());

    await act(async () => {
      postFromWeb({ type: 'mfa-verify-required' }, VERIFY_PAGE);
    });
    await waitFor(() => expect(utils.getByTestId('native-mfa-verify-modal')).toBeTruthy());
    fireEvent.press(utils.getByTestId('mock-native-mfa-verified'));

    expect(mockSetParams).toHaveBeenCalledTimes(1);
    expect(mockSetParams.mock.calls[0][0].initialPath).toMatch(/^\/menus\/weekly\?mode=app&view=day&_rb=\d+$/);
  });

  it('[閉じる] で閉じ、開き直さない', async () => {
    const utils = render(<WebViewScreen path="/home" />);
    await waitFor(() => expect(mockWebViewProps.source?.uri).toBeDefined());

    await act(async () => {
      postFromWeb({ type: 'mfa-verify-required' }, VERIFY_PAGE);
    });
    await waitFor(() => expect(utils.getByTestId('native-mfa-verify-modal')).toBeTruthy());

    fireEvent.press(utils.getByTestId('native-mfa-verify-close'));

    expect(utils.queryByTestId('native-mfa-verify-modal')).toBeNull();
    expect(mockSetParams).not.toHaveBeenCalled();
  });

  it.each([
    ['外部ページ', 'https://evil.example/phish'],
    ['前方一致でしかないホスト', 'https://homegohan-app.vercel.app.evil.example/settings/security/mfa/verify'],
  ])('%s からの mfa-verify-required は何も出さない', async (_label, url) => {
    const utils = render(<WebViewScreen path="/home" />);
    await waitFor(() => expect(mockWebViewProps.source?.uri).toBeDefined());

    await act(async () => {
      postFromWeb({ type: 'mfa-verify-required' }, url);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(utils.queryByTestId('native-mfa-verify-modal')).toBeNull();
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
