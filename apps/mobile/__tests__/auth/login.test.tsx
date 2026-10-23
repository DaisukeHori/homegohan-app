/**
 * login.test.tsx
 * RNTL tests for apps/mobile/app/(auth)/login.tsx
 *
 * Covers:
 *  1. email を lowercase に正規化して signInWithPassword を呼ぶ
 *  2. 空入力時はバリデーションエラーを出して API を呼ばない
 *  3. 30 秒 rate-limit が AsyncStorage から復元され UI に表示される
 *  4. (#1038 F7-08) Google ログイン: openAuthSessionAsync の result.url からその場でセッションにする
 *     (iOS の ASWebAuthenticationSession は URL を result.url にだけ返し、Linking には流さない)
 *  5. ログイン後の振り分け (#1122): admin / super_admin も一般ユーザーと同じ振り分けになり、
 *     廃止した管理者画面 (/admin) へは行かない
 */

import React from 'react';
import { Alert, StyleSheet } from 'react-native';
import { APPLE_SIGN_IN_MESSAGES } from '@homegohan/shared';
import { act, render, fireEvent, waitFor } from '@testing-library/react-native';

// ---- Mocks (before any component imports) ----

// Supabase mock
const mockSignInWithPassword = jest.fn();
const mockSignInWithOAuth = jest.fn();
const mockExchangeCodeForSession = jest.fn();
const mockSetSession = jest.fn();
const mockVerifyOtp = jest.fn();
const mockSignInWithIdToken = jest.fn();
const mockUpdateUser = jest.fn();
const mockGetUser = jest.fn();
const mockFrom = jest.fn();

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: any[]) => mockSignInWithPassword(...args),
      getUser: (...args: any[]) => mockGetUser(...args),
      signInWithOAuth: (...args: any[]) => mockSignInWithOAuth(...args),
      exchangeCodeForSession: (...args: any[]) => mockExchangeCodeForSession(...args),
      setSession: (...args: any[]) => mockSetSession(...args),
      verifyOtp: (...args: any[]) => mockVerifyOtp(...args),
      signInWithIdToken: (...args: any[]) => mockSignInWithIdToken(...args),
      updateUser: (...args: any[]) => mockUpdateUser(...args),
    },
    from: (...args: any[]) => mockFrom(...args),
  },
}));

// expo-router mock
const mockReplace = jest.fn();
const mockBack = jest.fn();
// ?next= を試すテストだけ差し替える (beforeEach で空に戻す)
let mockSearchParams: { next?: string } = {};
jest.mock('expo-router', () => ({
  router: { replace: (...args: any[]) => mockReplace(...args), back: (...args: any[]) => mockBack(...args) },
  Link: ({ children }: { children: React.ReactNode }) => children,
  useLocalSearchParams: () => mockSearchParams,
}));

// expo-linking mock
jest.mock('expo-linking', () => ({
  createURL: (path: string) => `homegohan://${path}`,
  useURL: () => null,
}));

// expo-web-browser mock
const mockOpenAuthSessionAsync = jest.fn();
jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: (...args: any[]) => mockOpenAuthSessionAsync(...args),
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

// react-native-svg mock
jest.mock('react-native-svg', () => {
  const React = require('react');
  const Svg = ({ children }: any) => React.createElement('View', null, children);
  const Path = () => null;
  return { __esModule: true, default: Svg, Path };
});

// @expo/vector-icons mock
jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

// theme mock
jest.mock('../../src/theme', () => ({
  colors: {
    bg: '#fff', accent: '#f00', text: '#000', textMuted: '#888',
    textLight: '#666', card: '#fafafa', border: '#eee',
  },
  spacing: { sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { lg: 12 },
  shadows: { sm: {}, md: {} },
}));

// ---- Component import (after mocks) ----
import LoginScreen from '../../app/(auth)/login';

// ---- AsyncStorage reference (mocked globally in jest.setup.js) ----
import AsyncStorage from '@react-native-async-storage/async-storage';
import { resetAuthLinkResultsForTests } from '../../src/lib/authLink';
import { AUTH_PROVIDER_BUTTON_MIN_HEIGHT } from '../../src/components/auth/AppleSignInButton';

// ---- Helpers ----

/** user_profiles から返す行 (ログイン後の振り分けに使う列) */
type ProfileRow = {
  roles: string[];
  onboarding_started_at: string | null;
  onboarding_completed_at: string | null;
};

function setupSuccessfulLogin(profile: Partial<ProfileRow> = {}) {
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  mockSignInWithPassword.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-1' } } });

  const selectMock = jest.fn();
  const eqMock = jest.fn();
  const singleMock = jest.fn().mockResolvedValue({
    data: { roles: [], onboarding_completed_at: null, onboarding_started_at: null, ...profile },
  });
  selectMock.mockReturnValue({ eq: eqMock });
  eqMock.mockReturnValue({ single: singleMock });
  mockFrom.mockReturnValue({ select: selectMock });
}

/** メールとパスワードを入れてログインボタンを押し、ログイン後の振り分け (router.replace) まで待つ */
async function loginAndWaitForRouting() {
  const { getByPlaceholderText, getAllByText } = render(<LoginScreen />);
  fireEvent.changeText(getByPlaceholderText('email@example.com'), 'user@example.com');
  fireEvent.changeText(getByPlaceholderText('パスワード'), 'password123');
  // "ログイン" appears as title + button; press the last occurrence (button)
  const loginEls = getAllByText('ログイン');
  fireEvent.press(loginEls[loginEls.length - 1]);

  await waitFor(() => {
    expect(mockReplace).toHaveBeenCalled();
  });
}

const originalAppleFlag = process.env.EXPO_PUBLIC_APPLE_SIGN_IN;

beforeEach(() => {
  jest.clearAllMocks();
  resetAuthLinkResultsForTests();
  mockSearchParams = {};
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
  // Re-apply spy since clearAllMocks resets mock implementations
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  mockOpenAuthSessionAsync.mockResolvedValue({ type: 'cancel' });
  mockSignInWithOAuth.mockResolvedValue({ data: { url: 'https://accounts.example/oauth' }, error: null });
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
  mockSetSession.mockResolvedValue({ error: null });
  mockVerifyOtp.mockResolvedValue({ error: null });
});

afterEach(() => {
  if (originalAppleFlag === undefined) delete process.env.EXPO_PUBLIC_APPLE_SIGN_IN;
  else process.env.EXPO_PUBLIC_APPLE_SIGN_IN = originalAppleFlag;
});

// ---- Tests ----

describe('LoginScreen', () => {
  it('1. email を toLowerCase に正規化して signInWithPassword を呼ぶ', async () => {
    setupSuccessfulLogin();
    const { getByPlaceholderText, getAllByText } = render(<LoginScreen />);

    fireEvent.changeText(getByPlaceholderText('email@example.com'), 'User@Example.COM');
    fireEvent.changeText(getByPlaceholderText('パスワード'), 'password123');
    // "ログイン" appears as title + button; press the last occurrence (button)
    const loginEls = getAllByText('ログイン');
    fireEvent.press(loginEls[loginEls.length - 1]);

    await waitFor(() => {
      expect(mockSignInWithPassword).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'password123',
      });
    });
  });

  it('2. email・password が空のとき API を呼ばずアラートを出す', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    const { getAllByText } = render(<LoginScreen />);

    const loginEls = getAllByText('ログイン');
    fireEvent.press(loginEls[loginEls.length - 1]);

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith(
        '入力エラー',
        'メールアドレスとパスワードを入力してください。'
      );
    });
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it('3. AsyncStorage に残り制限時間がある場合、ボタンにカウントダウンが表示される', async () => {
    // 25 秒前に失敗した扱い (残り ~5 秒)
    const fiveSecondsAgo = Date.now() - (30_000 - 5_000);
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(String(fiveSecondsAgo));

    const { findByText } = render(<LoginScreen />);

    // "再試行まで N 秒" テキストが表示されること
    const btn = await findByText(/再試行まで \d+ 秒/);
    expect(btn).toBeTruthy();

    // ボタンを押しても API は呼ばれない
    fireEvent.press(btn);
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });
});


// ---- #1038 F7-08: Google ログイン (OAuth コールバック URL の処理) ----

/** プロフィール取得 (振り分け用) のモック。引数で onboarding 状態を変える */
function setupProfile(profile: Record<string, unknown> | null) {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-google' } } });
  const singleMock = jest.fn().mockResolvedValue({ data: profile });
  const eqMock = jest.fn().mockReturnValue({ single: singleMock });
  const selectMock = jest.fn().mockReturnValue({ eq: eqMock });
  mockFrom.mockReturnValue({ select: selectMock });
}

async function pressGoogleLogin(api: ReturnType<typeof render>) {
  fireEvent.press(api.getByText('Googleでログイン'));
}

describe('LoginScreen — Google ログイン (#1038 F7-08)', () => {
  it('4-1. iOS: openAuthSessionAsync が result.url で返したコールバックから code を取り出して交換し、/auth/verify へ遷移しない', async () => {
    setupProfile({ roles: [], onboarding_completed_at: '2026-01-01T00:00:00Z', onboarding_started_at: '2026-01-01T00:00:00Z' });
    mockOpenAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'homegohan:///auth/verify?code=pkce-code-1' });
    const api = render(<LoginScreen />);

    await pressGoogleLogin(api);

    await waitFor(() => expect(mockExchangeCodeForSession).toHaveBeenCalledWith('pkce-code-1'));
    // 交換できたらホームへ。URL を取れない verify 画面には渡さない
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home'));
    expect(mockReplace).not.toHaveBeenCalledWith('/auth/verify');
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('4-2. implicit フローの #access_token=...&refresh_token=... は setSession で設定する', async () => {
    setupProfile({ roles: [], onboarding_completed_at: '2026-01-01T00:00:00Z', onboarding_started_at: null });
    mockOpenAuthSessionAsync.mockResolvedValue({
      type: 'success',
      url: 'homegohan:///auth/verify#access_token=at-1&refresh_token=rt-1&token_type=bearer',
    });
    const api = render(<LoginScreen />);

    await pressGoogleLogin(api);

    await waitFor(() => expect(mockSetSession).toHaveBeenCalledWith({ access_token: 'at-1', refresh_token: 'rt-1' }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home'));
  });

  it('4-3. 初回ログイン (オンボーディング未開始) はウェルカムへ、管理者もホームへ (/admin へは行かない) — メール・パスワードのログインと同じ振り分け', async () => {
    setupProfile({ roles: [], onboarding_completed_at: null, onboarding_started_at: null });
    mockOpenAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'homegohan:///auth/verify?code=c1' });
    const api = render(<LoginScreen />);
    await pressGoogleLogin(api);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/onboarding/welcome'));

    mockReplace.mockClear();
    resetAuthLinkResultsForTests();
    setupProfile({ roles: ['admin'], onboarding_completed_at: '2026-01-01T00:00:00Z', onboarding_started_at: null });
    mockOpenAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'homegohan:///auth/verify?code=c2' });
    await pressGoogleLogin(api);
    // #1122: アプリの管理者画面は廃止した。admin も他の人と同じ振り分け (オンボーディング完了済みならホーム)
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home'));
    expect(mockReplace).not.toHaveBeenCalledWith('/admin');
  });

  it('4-4. コールバックに code も token も無ければ、成功扱いにせずエラーを出す (セッションが無いまま画面遷移しない)', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'homegohan:///auth/verify' });
    const api = render(<LoginScreen />);

    await pressGoogleLogin(api);

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith('Googleログイン失敗', 'ログイン情報を受け取れませんでした。もう一度お試しください。'),
    );
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('4-5. コールバックが error を運んできたら、その説明を出してセッション処理はしない', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({
      type: 'success',
      url: 'homegohan:///auth/verify?error=access_denied&error_description=User+cancelled',
    });
    const api = render(<LoginScreen />);

    await pressGoogleLogin(api);

    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Googleログイン失敗', 'User cancelled'));
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('4-6. code の交換に失敗したらエラーを出し、遷移しない', async () => {
    mockExchangeCodeForSession.mockResolvedValue({ error: new Error('invalid flow state') });
    mockOpenAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'homegohan:///auth/verify?code=bad' });
    const api = render(<LoginScreen />);

    await pressGoogleLogin(api);

    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Googleログイン失敗', 'invalid flow state'));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('4-7. ブラウザを閉じた (cancel / dismiss) ときは何もしない', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({ type: 'dismiss' });
    const api = render(<LoginScreen />);

    await pressGoogleLogin(api);

    await waitFor(() => expect(mockOpenAuthSessionAsync).toHaveBeenCalled());
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('4-8. 認証用 URL を作れなかったときはエラーを出す', async () => {
    mockSignInWithOAuth.mockResolvedValue({ data: { url: null }, error: null });
    const api = render(<LoginScreen />);

    await pressGoogleLogin(api);

    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Googleログイン失敗', 'OAuth URL が取得できませんでした。'));
    expect(mockOpenAuthSessionAsync).not.toHaveBeenCalled();
  });
});

// ---- 5. ログイン後の振り分け (#1122) ----
//
// アプリの管理者画面 ((admin)) は廃止した (運営作業は Web に一本化)。
// 以前は admin / super_admin ロールのユーザーだけ、ログイン後に router.replace('/admin') で管理者画面へ送っていた。
// いまは roles を見ず、全員が同じ振り分け (?next= → ホーム / オンボーディング再開 / ウェルカム) になる。

const ROLE_CASES = [
  { label: '一般ユーザー', roles: ['user'] },
  { label: 'admin', roles: ['user', 'admin'] },
  { label: 'super_admin', roles: ['user', 'super_admin'] },
  { label: 'admin と super_admin の両方', roles: ['user', 'admin', 'super_admin'] },
];

describe.each(ROLE_CASES)('ログイン後の振り分け: $label', ({ roles }) => {
  it('オンボーディング完了済みならホームへ。/admin へは行かない', async () => {
    setupSuccessfulLogin({
      roles,
      onboarding_started_at: '2026-01-01T00:00:00Z',
      onboarding_completed_at: '2026-01-02T00:00:00Z',
    });
    await loginAndWaitForRouting();

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home');
    expect(mockReplace).not.toHaveBeenCalledWith('/admin');
  });

  it('オンボーディングが途中なら再開ページへ', async () => {
    setupSuccessfulLogin({ roles, onboarding_started_at: '2026-01-01T00:00:00Z', onboarding_completed_at: null });
    await loginAndWaitForRouting();

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/resume');
  });

  it('オンボーディング未開始ならウェルカムへ', async () => {
    setupSuccessfulLogin({ roles, onboarding_started_at: null, onboarding_completed_at: null });
    await loginAndWaitForRouting();

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/onboarding/welcome');
  });

  it('?next= があれば、オンボーディングの状態にかかわらずそのパスへ戻る', async () => {
    mockSearchParams = { next: '/meals/new' };
    setupSuccessfulLogin({ roles, onboarding_started_at: null, onboarding_completed_at: null });
    await loginAndWaitForRouting();

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/meals/new');
  });
});

describe('ログイン後の振り分け: ?next= の安全確認', () => {
  it('/ で始まらない next (外部 URL など) は無視して、通常の振り分けにする', async () => {
    mockSearchParams = { next: 'https://evil.example.com/' };
    setupSuccessfulLogin({
      roles: ['user', 'admin'],
      onboarding_started_at: '2026-01-01T00:00:00Z',
      onboarding_completed_at: '2026-01-02T00:00:00Z',
    });
    await loginAndWaitForRouting();

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home');
  });
});


// ---- 5-x. Sign in with Apple (docs/design/mobile/08-sign-in-with-apple.md §10.1・§14.1) ----
// Apple の流れ (signInWithApple) と振り分け (routeAfterSignIn) は実物を通し、その先の expo-apple-authentication・supabase・API をモックにする。

describe('LoginScreen — Apple でログイン (スイッチ EXPO_PUBLIC_APPLE_SIGN_IN)', () => {
  const COMPLETED = { roles: [], onboarding_completed_at: '2026-01-01T00:00:00Z', onboarding_started_at: '2026-01-01T00:00:00Z' };

  it('5-1. スイッチ on・iOS: Apple のボタン (login-apple-button) が Google のボタンの前にある', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'on';
    const api = render(<LoginScreen />);

    expect(await api.findByTestId('login-apple-button')).toBeTruthy();
    const tree = JSON.stringify(api.toJSON());
    expect(tree.indexOf('login-apple-button')).toBeGreaterThan(-1);
    expect(tree.indexOf('login-apple-button')).toBeLessThan(tree.indexOf('login-google-button'));
    // 種類はログイン (SIGN_IN)
    expect(mockAppleButtonProps[mockAppleButtonProps.length - 1].buttonType).toBe('SIGN_IN');
  });

  it('5-2. 押すと signInWithApple → signed_in → routeAfterSignIn (ホームへ)。認可コードもサーバへ渡す', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'on';
    setupProfile(COMPLETED);
    const api = render(<LoginScreen />);

    fireEvent.press(await api.findByTestId('apple-authentication-button'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home'));
    expect(mockSignInAsync).toHaveBeenCalledTimes(1);
    expect(mockSignInWithIdToken).toHaveBeenCalledWith({ provider: 'apple', token: 'id-token-1', nonce: 'raw-nonce' });
    expect(mockApiPost).toHaveBeenCalledWith('/api/auth/apple/authorization', { authorization_code: 'auth-code-1' });
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('5-3. cancelled (シートを閉じた) はアラートを出さず画面に留まる。ボタンはまた押せる', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'on';
    mockSignInAsync.mockRejectedValue({ code: 'ERR_REQUEST_CANCELED' });
    const api = render(<LoginScreen />);

    fireEvent.press(await api.findByTestId('apple-authentication-button'));

    await waitFor(() => expect(mockSignInAsync).toHaveBeenCalled());
    await waitFor(() => expect(api.getByTestId('login-apple-button').props.pointerEvents).toBe('auto'));
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(mockSignInWithIdToken).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('5-4. failed は Alert("Appleログイン失敗", 文)・遷移しない', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'on';
    mockSignInWithIdToken.mockResolvedValue({ data: { user: null }, error: { name: 'AuthApiError', message: 'provider is not enabled' } });
    const api = render(<LoginScreen />);

    fireEvent.press(await api.findByTestId('apple-authentication-button'));

    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Appleログイン失敗', APPLE_SIGN_IN_MESSAGES.failed));
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it('5-5. スイッチ無し (未設定・off): Apple のボタンが無く、Apple の端末確認もしない。Google のボタンは今までどおり', async () => {
    const api = render(<LoginScreen />);
    await act(async () => {});
    expect(api.queryByTestId('login-apple-button')).toBeNull();
    expect(api.getByTestId('login-google-button')).toBeTruthy();

    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'off';
    api.unmount();
    const off = render(<LoginScreen />);
    await act(async () => {});
    expect(off.queryByTestId('login-apple-button')).toBeNull();
    expect(mockIsAvailableAsync).not.toHaveBeenCalled();
  });

  it('5-6. ?next= は Apple でも効く', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'on';
    mockSearchParams = { next: '/meals/new' };
    setupProfile({ roles: [], onboarding_completed_at: null, onboarding_started_at: null });
    const api = render(<LoginScreen />);

    fireEvent.press(await api.findByTestId('apple-authentication-button'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/meals/new'));
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it('5-7. Apple のボタンの高さは Google のボタンと同じ: Google の minHeight は AUTH_PROVIDER_BUTTON_MIN_HEIGHT、Apple の高さは初め AUTH_PROVIDER_BUTTON_MIN_HEIGHT、Google の onLayout (高さ 70) のあとは 70 (S-33)', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'on';
    const api = render(<LoginScreen />);
    await api.findByTestId('login-apple-button');
    const latestHeight = () => mockAppleButtonProps[mockAppleButtonProps.length - 1].style.height;
    const googleMinHeight = () => {
      const style = api.getByTestId('login-google-button').props.style;
      // Pressable の style は関数 (pressed) か配列か値。画面の定義は関数
      return StyleSheet.flatten(typeof style === 'function' ? style({ pressed: false }) : style).minHeight;
    };

    expect(googleMinHeight()).toBe(AUTH_PROVIDER_BUTTON_MIN_HEIGHT);
    expect(latestHeight()).toBe(AUTH_PROVIDER_BUTTON_MIN_HEIGHT);

    fireEvent(api.getByTestId('login-google-button'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 70 } } });
    await waitFor(() => expect(latestHeight()).toBe(70));

    // 文字の大きさを標準に戻したら、下限に戻る
    fireEvent(api.getByTestId('login-google-button'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 320, height: AUTH_PROVIDER_BUTTON_MIN_HEIGHT } } });
    await waitFor(() => expect(latestHeight()).toBe(AUTH_PROVIDER_BUTTON_MIN_HEIGHT));
  });

  it('5-8. Apple のサインイン中は Apple のボタンを押せない (isSubmitting。Google・メールと同じ)', async () => {
    process.env.EXPO_PUBLIC_APPLE_SIGN_IN = 'on';
    let finishSheet: (value: unknown) => void = () => {};
    mockSignInAsync.mockReturnValue(new Promise((resolve) => { finishSheet = resolve; }));
    const api = render(<LoginScreen />);

    fireEvent.press(await api.findByTestId('apple-authentication-button'));

    await waitFor(() => expect(api.getByTestId('login-apple-button').props.pointerEvents).toBe('none'));
    await act(async () => { finishSheet({ user: 'u', identityToken: null, authorizationCode: null, fullName: null, email: null }); });
    // identityToken が無い → failed (noIdentityToken) → ボタンは戻る
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Appleログイン失敗', APPLE_SIGN_IN_MESSAGES.noIdentityToken));
    await waitFor(() => expect(api.getByTestId('login-apple-button').props.pointerEvents).toBe('auto'));
  });
});
