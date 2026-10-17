/**
 * WebViewScreen — 規約の同意の画面の配線 (#1442 設計書 cross/13b §6.6.15。T-WV1〜T-WV3)
 *
 *   - Web の同意画面 (/legal-consent) が同意を記録できた直後に送る { type: 'legal-consent-accepted' } を受け、
 *     LegalConsentProvider に知らせる (送り元が自オリジンのときだけ)
 *   - props の afterSignOut を渡した画面では、Web からの sign-out の後にウェルカムへ移る代わりにそれを呼ぶ
 *   - afterSignOut を渡しても、運営の MFA の確認 (mfa-verify-required。#1808) の配線は落とさない
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

// 確認画面の中身は NativeMfaVerifyModal.test.tsx で確かめる。ここでは出る・閉じる・開き直すだけを見る
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
import {
  resetLegalConsentListenersForTests,
  subscribeLegalConsentEvents,
  type LegalConsentEvent,
} from '../../src/lib/legal-consent';

// ── ヘルパー ──────────────────────────────────────────────────────────────────
const CONSENT_PAGE = `${WEB_BASE_URL}/legal-consent?mode=app`;

/** WebView の onMessage に、Web 側の postMessage 相当のイベントを流す */
function postFromWeb(message: unknown, url: string = CONSENT_PAGE) {
  mockWebViewProps.onMessage({ nativeEvent: { data: JSON.stringify(message), url } });
}

async function renderScreen(element: React.ReactElement) {
  const utils = render(element);
  await waitFor(() => expect(mockWebViewProps.source?.uri).toBeDefined());
  return utils;
}

let events: LegalConsentEvent[];

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockWebViewProps).forEach((k) => delete mockWebViewProps[k]);
  mockRouteParams = {};
  resetLegalConsentListenersForTests();
  events = [];
  subscribeLegalConsentEvents((event) => events.push(event));
  mockGetSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' }, access_token: 'access-1' } } });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mockSignOutWithCleanup.mockResolvedValue({ error: null });
});

afterEach(() => {
  resetLegalConsentListenersForTests();
});

describe('WebViewScreen — legal-consent-accepted (#1442 T-WV1)', () => {
  it('自オリジンから { type: "legal-consent-accepted" } が届いたら購読者に accepted を知らせる', async () => {
    await renderScreen(<WebViewScreen path="/legal-consent" />);

    postFromWeb({ type: 'legal-consent-accepted' });

    expect(events).toEqual(['accepted']);
    // 認証のメッセージではないので、ログアウトも読み込み直しもしない
    expect(mockSignOutWithCleanup).not.toHaveBeenCalled();
    expect(mockSetParams).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('他オリジンからは知らせない', async () => {
    await renderScreen(<WebViewScreen path="/legal-consent" />);

    postFromWeb({ type: 'legal-consent-accepted' }, 'https://evil.example/phish');
    postFromWeb({ type: 'legal-consent-accepted' }, 'https://homegohan-app.vercel.app.evil.example/legal-consent');

    expect(events).toEqual([]);
  });

  it('知らない type は何もしない', async () => {
    await renderScreen(<WebViewScreen path="/legal-consent" />);

    postFromWeb({ type: 'legal-consent-accepted-x' });
    postFromWeb({ type: 'something-else' });

    expect(events).toEqual([]);
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe('WebViewScreen — afterSignOut (#1442 T-WV2)', () => {
  it('afterSignOut を渡した WebViewScreen に自オリジンから sign-out が届くと、signOutWithCleanup の後に afterSignOut を 1 回呼び、router.replace("/") を呼ばない', async () => {
    const afterSignOut = jest.fn();
    await renderScreen(<WebViewScreen path="/legal-consent" afterSignOut={afterSignOut} />);

    postFromWeb({ type: 'sign-out' });

    await waitFor(() => expect(afterSignOut).toHaveBeenCalledTimes(1));
    expect(mockSignOutWithCleanup).toHaveBeenCalledWith('user-1', { accessToken: 'access-1' });
    expect(mockSignOutWithCleanup.mock.invocationCallOrder[0]).toBeLessThan(afterSignOut.mock.invocationCallOrder[0]);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('渡さなければ今までどおり router.replace("/")', async () => {
    await renderScreen(<WebViewScreen path="/home" />);

    postFromWeb({ type: 'sign-out' }, `${WEB_BASE_URL}/settings`);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
    expect(mockSignOutWithCleanup).toHaveBeenCalledWith('user-1', { accessToken: 'access-1' });
  });

  it('外部ページから届いた sign-out は afterSignOut も呼ばない', async () => {
    const afterSignOut = jest.fn();
    await renderScreen(<WebViewScreen path="/legal-consent" afterSignOut={afterSignOut} />);

    postFromWeb({ type: 'sign-out' }, 'https://evil.example/phish');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(afterSignOut).not.toHaveBeenCalled();
    expect(mockSignOutWithCleanup).not.toHaveBeenCalled();
  });
});

describe('WebViewScreen — afterSignOut を渡しても MFA の確認は落とさない (#1442 T-WV3 / #1808)', () => {
  const VERIFY_PAGE = `${WEB_BASE_URL}/settings/security/mfa/verify?next=%2Fadmin`;

  it('mfa-verify-required が届くと NativeMfaVerifyModal を描き、onVerified で閉じて _rb を付けた initialPath で開き直す。afterSignOut は呼ばない', async () => {
    const afterSignOut = jest.fn();
    const utils = await renderScreen(<WebViewScreen path="/legal-consent" afterSignOut={afterSignOut} />);

    await act(async () => {
      postFromWeb({ type: 'mfa-verify-required' }, VERIFY_PAGE);
    });
    await waitFor(() => expect(utils.getByTestId('native-mfa-verify-modal')).toBeTruthy());
    expect(mockSetParams).not.toHaveBeenCalled();

    fireEvent.press(utils.getByTestId('mock-native-mfa-verified'));

    expect(utils.queryByTestId('native-mfa-verify-modal')).toBeNull();
    expect(mockSetParams).toHaveBeenCalledTimes(1);
    expect(mockSetParams.mock.calls[0][0].initialPath).toMatch(/^\/legal-consent\?_rb=\d+$/);
    expect(afterSignOut).not.toHaveBeenCalled();
    expect(mockSignOutWithCleanup).not.toHaveBeenCalled();
  });
});
