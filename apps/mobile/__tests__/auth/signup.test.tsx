/**
 * signup.test.tsx
 * RNTL tests for apps/mobile/app/(auth)/signup.tsx
 *
 * Covers:
 *  1. email が空のとき API を呼ばずエラーを出す
 *  2. password 強度バリデーション — 8 文字未満でエラー
 *  2b. (#1574) 英字だけ・数字だけも止める。規則と文言は packages/shared の validatePassword と共通
 *  2c. (#1864) 72 バイト (GoTrue の bcrypt の上限) を超えるパスワードも止める
 *  3. identities.length === 0 の silent-success を検知してアラートを出す
 */

import React from 'react';
import { Alert, StyleSheet } from 'react-native';
import { act, render, fireEvent, waitFor } from '@testing-library/react-native';
import { APPLE_SIGN_IN_MESSAGES, PASSWORD_MAX_BYTES, PASSWORD_TOO_LONG_MESSAGE, SIGNUP_MINOR_NOTICE } from '@homegohan/shared';

// ---- Mocks ----

const mockSignUp = jest.fn();
const mockSignInWithOAuth = jest.fn();
const mockSignInWithIdToken = jest.fn();
const mockUpdateUser = jest.fn();
const mockGetUser = jest.fn();
const mockFrom = jest.fn();

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      signUp: (...args: any[]) => mockSignUp(...args),
      signInWithOAuth: (...args: any[]) => mockSignInWithOAuth(...args),
      signInWithIdToken: (...args: any[]) => mockSignInWithIdToken(...args),
      updateUser: (...args: any[]) => mockUpdateUser(...args),
      getUser: (...args: any[]) => mockGetUser(...args),
    },
    from: (...args: any[]) => mockFrom(...args),
  },
}));

const mockReplace = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: (...args: any[]) => mockReplace(...args), back: (...args: any[]) => mockBack(...args) },
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-linking', () => ({
  createURL: (path: string) => `homegohan://${path}`,
  useURL: () => null,
}));

jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: jest.fn().mockResolvedValue({ type: 'cancel' }),
}));

// ---- Sign in with Apple (docs/design/mobile/08-sign-in-with-apple.md §14.1) ----
// AppleAuthenticationButton だけを「props を写す偽物」にする (押す・高さを読むため)。列挙の値は文字列
const mockAppleButtonProps: Array<{ buttonType: string; buttonStyle: string; cornerRadius: number; style: { width: string; height: number }; onPress: () => void }> = [];
const mockSignInAsync = jest.fn();
const mockIsAvailableAsync = jest.fn();
jest.mock('expo-apple-authentication', () => {
  const ReactActual = require('react');
  const { Pressable } = require('react-native');
  return {
    isAvailableAsync: (...args: any[]) => mockIsAvailableAsync(...args),
    signInAsync: (...args: any[]) => mockSignInAsync(...args),
    AppleAuthenticationButton: (props: (typeof mockAppleButtonProps)[number]) => {
      mockAppleButtonProps.push(props);
      return ReactActual.createElement(Pressable, { testID: 'apple-authentication-button', style: props.style, onPress: props.onPress });
    },
    AppleAuthenticationButtonType: { SIGN_IN: 'SIGN_IN', CONTINUE: 'CONTINUE', SIGN_UP: 'SIGN_UP' },
    AppleAuthenticationButtonStyle: { WHITE: 'WHITE', WHITE_OUTLINE: 'WHITE_OUTLINE', BLACK: 'BLACK' },
    AppleAuthenticationScope: { FULL_NAME: 'FULL_NAME', EMAIL: 'EMAIL' },
  };
});
jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => 'raw-nonce'),
  digestStringAsync: jest.fn(async () => 'hashed-nonce'),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));
const mockApiPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: (...args: any[]) => mockApiPost(...args) }),
}));

jest.mock('react-native-svg', () => {
  const React = require('react');
  const Svg = ({ children }: any) => React.createElement('View', null, children);
  const Path = () => null;
  return { __esModule: true, default: Svg, Path };
});

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('../../src/theme', () => ({
  colors: {
    bg: '#fff', accent: '#f00', text: '#000', textMuted: '#888',
    textLight: '#666', card: '#fafafa', border: '#eee',
  },
  spacing: { sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { lg: 12 },
  shadows: { sm: {}, md: {} },
}));

import SignupScreen from '../../app/(auth)/signup';
import { AUTH_PROVIDER_BUTTON_MIN_HEIGHT } from '../../src/components/auth/AppleSignInButton';

const originalAppleFlag = process.env.EXPO_PUBLIC_APPLE_SIGN_IN;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockAppleButtonProps.length = 0;
  // Apple のボタンはスイッチ (EXPO_PUBLIC_APPLE_SIGN_IN) を on にしたテストだけが出す
  delete process.env.EXPO_PUBLIC_APPLE_SIGN_IN;
  mockIsAvailableAsync.mockResolvedValue(true);
  mockSignInAsync.mockResolvedValue({
    user: 'apple-user-1', identityToken: 'id-token-1', authorizationCode: 'auth-code-1', fullName: null, email: null,
  });
  mockSignInWithIdToken.mockResolvedValue({ data: { user: { user_metadata: {} } }, error: null });
  mockUpdateUser.mockResolvedValue({ error: null });
  mockApiPost.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (originalAppleFlag === undefined) delete process.env.EXPO_PUBLIC_APPLE_SIGN_IN;
  else process.env.EXPO_PUBLIC_APPLE_SIGN_IN = originalAppleFlag;
});

/** ログイン後の振り分け (routeAfterSignIn) が読む user_profiles のモック */
function setupProfile(profile: Record<string, unknown> | null) {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-apple' } } });
  const singleMock = jest.fn().mockResolvedValue({ data: profile });
  const eqMock = jest.fn().mockReturnValue({ single: singleMock });
  const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
  mockFrom.mockReturnValue({ select: selectMock });
}

describe('SignupScreen', () => {
  it('1. email が空のとき API を呼ばずエラーアラートを出す', async () => {
    const { getByText } = render(<SignupScreen />);

    // email・password 未入力のまま送信
    fireEvent.press(getByText('アカウント作成'));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith(
        '入力エラー',
        'メールアドレスとパスワードを入力してください。'
      );
    });
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it('2. パスワードが 8 文字未満のとき強度エラーを出す', async () => {
    const { getByPlaceholderText, getByText } = render(<SignupScreen />);

    fireEvent.changeText(getByPlaceholderText('email@example.com'), 'test@example.com');
    fireEvent.changeText(getByPlaceholderText('8文字以上・英字と数字を含む'), 'abc1');
    fireEvent.press(getByText('アカウント作成'));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith(
        '入力エラー',
        'パスワードは8文字以上で入力してください'
      );
    });
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it.each([
    ['数字だけ', '12345678', 'パスワードには英字を含めてください'],
    ['英字だけ', 'abcdefgh', 'パスワードには数字を含めてください'],
  ])('2b. %s (8 文字以上) のパスワードは、再設定・Web と同じ文言で止める (#1574)', async (_label, weak, message) => {
    const { getByPlaceholderText, getByText } = render(<SignupScreen />);

    fireEvent.changeText(getByPlaceholderText('email@example.com'), 'test@example.com');
    fireEvent.changeText(getByPlaceholderText('8文字以上・英字と数字を含む'), weak);
    fireEvent.press(getByText('アカウント作成'));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith('入力エラー', message);
    });
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it.each([
    ['半角 73 文字', `a1${'x'.repeat(PASSWORD_MAX_BYTES - 1)}`],
    ['日本語を含む 26 文字 (74 バイト)', `a1${'あ'.repeat(24)}`],
  ])('2c. 72 バイトを超えるパスワード (%s) は、Web と同じ「長すぎる」の文言で止め、signUp を呼ばない (#1864)', async (_label, tooLong) => {
    const { getByPlaceholderText, getByText } = render(<SignupScreen />);

    fireEvent.changeText(getByPlaceholderText('email@example.com'), 'test@example.com');
    fireEvent.changeText(getByPlaceholderText('8文字以上・英字と数字を含む'), tooLong);
    fireEvent.press(getByText('アカウント作成'));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith('入力エラー', PASSWORD_TOO_LONG_MESSAGE);
    });
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it('3. identities が空配列のとき重複メールアラートを出す', async () => {
    mockSignUp.mockResolvedValue({
      data: { user: { identities: [] } },
      error: null,
    });

    const { getByPlaceholderText, getByText } = render(<SignupScreen />);

    fireEvent.changeText(getByPlaceholderText('email@example.com'), 'dup@example.com');
    fireEvent.changeText(getByPlaceholderText('8文字以上・英字と数字を含む'), 'Password1');
    fireEvent.press(getByText('アカウント作成'));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith(
        '登録できませんでした',
        expect.stringContaining('既に登録されています'),
        expect.any(Array)
      );
    });
  });

  it('#1173 T-EM2: 18 歳未満の方はご自身では登録できない旨の注記 (SIGNUP_MINOR_NOTICE) を出す', () => {
    const { getByTestId, getByText } = render(<SignupScreen />);

    expect(getByTestId('signup-minor-notice')).toBeTruthy();
    expect(getByText(SIGNUP_MINOR_NOTICE)).toBeTruthy();
  });
});

// ---- Sign in with Apple (docs/design/mobile/08-sign-in-with-apple.md §10.1・§14.1) ----
// Apple の流れ (signInWithApple) と振り分け (routeAfterSignIn) は実物を通し、その先の expo-apple-authentication・supabase・API をモックにする。

describe('SignupScreen — Apple で登録 (スイッチ EXPO_PUBLIC_APPLE_SIGN_IN)', () => {
  it('4. スイッチ on: Apple で登録 (signup-apple-button) が Google の前にある。押すと signInWithApple → routeAfterSignIn (?next= は無い)', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'on';
    setupProfile({ onboarding_completed_at: null, onboarding_started_at: null });
    const api = render(<SignupScreen />);

    expect(await api.findByTestId('signup-apple-button')).toBeTruthy();
    const tree = JSON.stringify(api.toJSON());
    expect(tree.indexOf('signup-apple-button')).toBeLessThan(tree.indexOf('signup-google-button'));
    // 種類は登録 (SIGN_UP)
    expect(mockAppleButtonProps[mockAppleButtonProps.length - 1].buttonType).toBe('SIGN_UP');

    fireEvent.press(api.getByTestId('apple-authentication-button'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/onboarding/welcome'));
    expect(mockSignInWithIdToken).toHaveBeenCalledWith({ provider: 'apple', token: 'id-token-1', nonce: 'raw-nonce' });
    expect(mockApiPost).toHaveBeenCalledWith('/api/auth/apple/authorization', { authorization_code: 'auth-code-1' });
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('4b. 初期設定が済んでいる人が Apple で入ったらホームへ (ログイン画面と同じ振り分け)', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'on';
    setupProfile({ onboarding_completed_at: '2026-01-02T00:00:00Z', onboarding_started_at: '2026-01-01T00:00:00Z' });
    const api = render(<SignupScreen />);

    fireEvent.press(await api.findByTestId('apple-authentication-button'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home'));
  });

  it('4c. cancelled (シートを閉じた) はアラートを出さず画面に留まる', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'on';
    mockSignInAsync.mockRejectedValue({ code: 'ERR_REQUEST_CANCELED' });
    const api = render(<SignupScreen />);

    fireEvent.press(await api.findByTestId('apple-authentication-button'));

    await waitFor(() => expect(mockSignInAsync).toHaveBeenCalled());
    await waitFor(() => expect(api.getByTestId('signup-apple-button').props.pointerEvents).toBe('auto'));
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('5. failed は Alert("Apple登録失敗", 文)・遷移しない', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'on';
    mockSignInWithIdToken.mockResolvedValue({ data: { user: null }, error: { name: 'AuthApiError', message: 'nonce mismatch' } });
    const api = render(<SignupScreen />);

    fireEvent.press(await api.findByTestId('apple-authentication-button'));

    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Apple登録失敗', APPLE_SIGN_IN_MESSAGES.failed));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('6. スイッチ無し (未設定・off): Apple で登録のボタンが無く、Apple の端末確認もしない。Google のボタンは今までどおり', async () => {
    const api = render(<SignupScreen />);
    await act(async () => {});
    expect(api.queryByTestId('signup-apple-button')).toBeNull();
    expect(api.getByTestId('signup-google-button')).toBeTruthy();

    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'off';
    api.unmount();
    const off = render(<SignupScreen />);
    await act(async () => {});
    expect(off.queryByTestId('signup-apple-button')).toBeNull();
    expect(mockIsAvailableAsync).not.toHaveBeenCalled();
  });

  it('7. Apple で登録のボタンの高さは Google で登録のボタンと同じ (login の 5-7 と同じ検査。S-33)', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'on';
    const api = render(<SignupScreen />);
    await api.findByTestId('signup-apple-button');
    const latestHeight = () => mockAppleButtonProps[mockAppleButtonProps.length - 1].style.height;
    const googleMinHeight = () => {
      const style = api.getByTestId('signup-google-button').props.style;
      return StyleSheet.flatten(typeof style === 'function' ? style({ pressed: false }) : style).minHeight;
    };

    expect(googleMinHeight()).toBe(AUTH_PROVIDER_BUTTON_MIN_HEIGHT);
    expect(latestHeight()).toBe(AUTH_PROVIDER_BUTTON_MIN_HEIGHT);

    fireEvent(api.getByTestId('signup-google-button'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 70 } } });
    await waitFor(() => expect(latestHeight()).toBe(70));

    fireEvent(api.getByTestId('signup-google-button'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: AUTH_PROVIDER_BUTTON_MIN_HEIGHT } } });
    await waitFor(() => expect(latestHeight()).toBe(AUTH_PROVIDER_BUTTON_MIN_HEIGHT));
  });
});
