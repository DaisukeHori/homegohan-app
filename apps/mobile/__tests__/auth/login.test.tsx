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
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// ---- Mocks (before any component imports) ----

// Supabase mock
const mockSignInWithPassword = jest.fn();
const mockSignInWithOAuth = jest.fn();
const mockExchangeCodeForSession = jest.fn();
const mockSetSession = jest.fn();
const mockVerifyOtp = jest.fn();
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
    },
    from: (...args: any[]) => mockFrom(...args),
  },
}));

// expo-router mock
const mockReplace = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: (...args: any[]) => mockReplace(...args), back: (...args: any[]) => mockBack(...args) },
  Link: ({ children }: { children: React.ReactNode }) => children,
  useLocalSearchParams: () => ({}),
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

// ---- Helpers ----

function setupSuccessfulLogin() {
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  mockSignInWithPassword.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-1' } } });

  const selectMock = jest.fn();
  const eqMock = jest.fn();
  const singleMock = jest.fn().mockResolvedValue({
    data: { roles: [], onboarding_completed_at: null, onboarding_started_at: null },
  });
  selectMock.mockReturnValue({ eq: eqMock });
  eqMock.mockReturnValue({ single: singleMock });
  mockFrom.mockReturnValue({ select: selectMock });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAuthLinkResultsForTests();
  // Re-apply spy since clearAllMocks resets mock implementations
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  mockOpenAuthSessionAsync.mockResolvedValue({ type: 'cancel' });
  mockSignInWithOAuth.mockResolvedValue({ data: { url: 'https://accounts.example/oauth' }, error: null });
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
  mockSetSession.mockResolvedValue({ error: null });
  mockVerifyOtp.mockResolvedValue({ error: null });
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

  it('4-3. 初回ログイン (オンボーディング未開始) はウェルカムへ、管理者は /admin へ — メール・パスワードのログインと同じ振り分け', async () => {
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
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/admin'));
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
