/**
 * #1165: ログイン・新規登録・パスワード再設定の画面に Turnstile をつないだ結果の RNTL 単体テスト
 * (apps/mobile/app/(auth)/login.tsx, signup.tsx, auth/forgot-password.tsx)
 *
 * 確かめること (3 画面とも):
 *   - サイトキー未設定 (Turnstile 無効): 何も足さない。ボタンは押せて、Supabase へは
 *     今までと同じ引数 (captchaToken も options も付けない) で呼ぶ
 *   - サイトキーあり: トークンが無い間は送信ボタンが無効 (「トークン無し → 送信ボタン無効」)
 *   - トークンは、Supabase の正しい場所に付けて渡す
 *       signInWithPassword / signUp : options.captchaToken
 *       resetPasswordForEmail       : 第 2 引数の直下の captchaToken (options の中に入れても Supabase には届かない)
 *   - 送信したらトークンを捨てて WebView を作り直し、新しいトークンが届くまで送信できない (トークンは 1 回しか使えない)
 *   - 入力の検証 (パスワード強度) で弾いたときは、使っていないトークンを捨てない
 *   - Supabase が CAPTCHA の確認を断ったら、英語の生のエラー文ではなく日本語の文言を出す。
 *     ログインでは、パスワード違いと違ってクールダウン (30 秒) を付けない
 *
 * 既存の login / signup / forgot-password のテストは、サイトキー未設定のまま動くので、
 * 「Turnstile を入れても今までの動きは変わらない」ことの確認にもなっている。
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// ---- Mocks (before any component imports) ----

const mockSignInWithPassword = jest.fn();
const mockGetUser = jest.fn();
const mockFrom = jest.fn();
const mockSignUp = jest.fn();
const mockResetPasswordForEmail = jest.fn();

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: any[]) => mockSignInWithPassword(...args),
      getUser: (...args: any[]) => mockGetUser(...args),
      signInWithOAuth: jest.fn().mockResolvedValue({ data: { url: null }, error: null }),
      signUp: (...args: any[]) => mockSignUp(...args),
      resetPasswordForEmail: (...args: any[]) => mockResetPasswordForEmail(...args),
    },
    from: (...args: any[]) => mockFrom(...args),
  },
}));

const mockReplace = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: (...args: any[]) => mockReplace(...args), back: (...args: any[]) => mockBack(...args) },
  Link: ({ children }: { children: React.ReactNode }) => children,
  useLocalSearchParams: () => ({}),
}));

jest.mock('expo-linking', () => ({
  createURL: (path: string) => `homegohan://${path}`,
  useURL: () => null,
}));

jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: jest.fn().mockResolvedValue({ type: 'cancel' }),
}));

jest.mock('react-native-svg', () => {
  const ReactInner = require('react');
  const Svg = ({ children }: any) => ReactInner.createElement('View', null, children);
  const Path = () => null;
  return { __esModule: true, default: Svg, Path };
});

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('../../src/theme', () => ({
  colors: {
    bg: '#fff', accent: '#f00', text: '#000', textMuted: '#888',
    textLight: '#666', card: '#fafafa', border: '#eee', error: '#f44', errorLight: '#fee',
  },
  spacing: { sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { lg: 12 },
  shadows: { sm: {}, md: {} },
}));

// WebView の props を捕まえて、テストから onMessage を呼べるようにする。
// key が変わって作り直されたら、マウントの回数が増える (mockMounts)。
let mockWebViewProps: Record<string, any> = {};
let mockMounts = 0;
jest.mock('react-native-webview', () => ({
  WebView: (props: any) => {
    const ReactInner = require('react');
    const { View: ViewInner } = require('react-native');
    mockWebViewProps = props;
    ReactInner.useEffect(() => {
      mockMounts += 1;
    }, []);
    return <ViewInner testID={props.testID ?? 'webview'} />;
  },
}));

// ---- Component import (after mocks) ----
import LoginScreen from '../../app/(auth)/login';
import SignupScreen from '../../app/(auth)/signup';
import ForgotPasswordPage from '../../app/(auth)/auth/forgot-password';
import { CAPTCHA_FAILED_MESSAGE } from '../../src/lib/turnstile';

import AsyncStorage from '@react-native-async-storage/async-storage';

const SITE_KEY = '1x00000000000000000000AA';
const CAPTCHA_ERROR = { code: 'captcha_failed', status: 400, message: 'captcha verification process failed' };

/** WebView の中のスクリプトから、アプリへ postMessage が届いたことにする */
function postFromWebView(message: unknown) {
  act(() => {
    mockWebViewProps.onMessage({ nativeEvent: { data: JSON.stringify(message) } });
  });
}

const originalSiteKey = process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockWebViewProps = {};
  mockMounts = 0;
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  mockSignInWithPassword.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({ data: { user: null } });
  mockSignUp.mockResolvedValue({ data: { user: { identities: [{}] } }, error: null });
  mockResetPasswordForEmail.mockResolvedValue({ error: null });
});

afterEach(() => {
  if (originalSiteKey === undefined) delete process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
  else process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = originalSiteKey;
});

// ──────────────────────────────────────────────────────────────────────────────
describe('ログイン (login.tsx)', () => {
  function fillLogin(screen: ReturnType<typeof render>) {
    fireEvent.changeText(screen.getByTestId('email-input'), 'User@Example.COM');
    fireEvent.changeText(screen.getByTestId('password-input'), 'password123');
  }

  describe('Turnstile 無効 (サイトキー未設定)', () => {
    beforeEach(() => {
      delete process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
    });

    it('ウィジェットを出さず、ボタンは押せて、signInWithPassword へ今までと同じ引数 (options なし) で渡す', async () => {
      const screen = render(<LoginScreen />);
      expect(screen.queryByTestId('turnstile')).toBeNull();
      expect(mockMounts).toBe(0);
      expect(screen.getByTestId('login-button')).toBeEnabled();
      fillLogin(screen);

      fireEvent.press(screen.getByTestId('login-button'));

      await waitFor(() => expect(mockSignInWithPassword).toHaveBeenCalledTimes(1));
      const [credentials] = mockSignInWithPassword.mock.calls[0];
      expect(credentials).toEqual({ email: 'user@example.com', password: 'password123' });
      // options というキー自体が無いこと (undefined を入れただけではない)
      expect(Object.keys(credentials)).toEqual(['email', 'password']);
    });
  });

  describe('Turnstile 有効 (サイトキーあり)', () => {
    beforeEach(() => {
      process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = SITE_KEY;
    });

    it('トークンが無い間はボタンが無効で、押しても Supabase を呼ばない', async () => {
      const screen = render(<LoginScreen />);
      fillLogin(screen);

      expect(mockMounts).toBe(1);
      expect(screen.getByTestId('login-button')).toBeDisabled();
      fireEvent.press(screen.getByTestId('login-button'));

      await act(async () => {});
      expect(mockSignInWithPassword).not.toHaveBeenCalled();
    });

    it('トークンが届くと送信できて、options.captchaToken に付けて渡す。送信後はトークンを捨てて取り直す', async () => {
      const screen = render(<LoginScreen />);
      fillLogin(screen);
      postFromWebView({ type: 'token', token: 'tok-login-1' });
      expect(screen.getByTestId('login-button')).toBeEnabled();

      fireEvent.press(screen.getByTestId('login-button'));

      await waitFor(() => expect(mockSignInWithPassword).toHaveBeenCalledTimes(1));
      expect(mockSignInWithPassword).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'password123',
        options: { captchaToken: 'tok-login-1' },
      });
      // トークンは 1 回しか使えない: WebView を作り直し、新しいトークンが届くまで送信できない
      expect(mockMounts).toBe(2);
      expect(screen.getByTestId('login-button')).toBeDisabled();
      postFromWebView({ type: 'token', token: 'tok-login-2' });
      expect(screen.getByTestId('login-button')).toBeEnabled();
    });

    it('Supabase が CAPTCHA の確認を断ったら日本語の文言を出し、パスワード違いのクールダウン (30 秒) は付けない', async () => {
      mockSignInWithPassword.mockResolvedValue({ error: CAPTCHA_ERROR });
      const screen = render(<LoginScreen />);
      fillLogin(screen);
      postFromWebView({ type: 'token', token: 'tok-login-1' });

      fireEvent.press(screen.getByTestId('login-button'));

      await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('ログイン失敗', CAPTCHA_FAILED_MESSAGE));
      expect(screen.getByText(CAPTCHA_FAILED_MESSAGE)).toBeTruthy();
      expect(screen.queryByText(/captcha verification process failed/)).toBeNull();
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      expect(screen.queryByTestId('login-rate-limit-banner')).toBeNull();
      expect(mockMounts).toBe(2);
    });

    it('パスワード違いは今までどおりの文言とクールダウンで、トークンは使い切りとして捨てる', async () => {
      mockSignInWithPassword.mockResolvedValue({
        error: { status: 400, message: 'Invalid login credentials' },
      });
      const screen = render(<LoginScreen />);
      fillLogin(screen);
      postFromWebView({ type: 'token', token: 'tok-login-1' });

      fireEvent.press(screen.getByTestId('login-button'));

      await waitFor(() =>
        expect(Alert.alert).toHaveBeenCalledWith('ログイン失敗', 'メールアドレスまたはパスワードが正しくありません。'),
      );
      expect(AsyncStorage.setItem).toHaveBeenCalledWith('auth_last_fail_ts', expect.any(String));
      expect(screen.getByTestId('login-rate-limit-banner')).toBeTruthy();
      expect(mockMounts).toBe(2);
    });

    it('メールアドレスとパスワードが空のときは、使っていないトークンを捨てない', async () => {
      const screen = render(<LoginScreen />);
      postFromWebView({ type: 'token', token: 'tok-login-1' });

      fireEvent.press(screen.getByTestId('login-button'));

      await waitFor(() =>
        expect(Alert.alert).toHaveBeenCalledWith('入力エラー', 'メールアドレスとパスワードを入力してください。'),
      );
      expect(mockSignInWithPassword).not.toHaveBeenCalled();
      expect(mockMounts).toBe(1); // WebView は作り直していない
      expect(screen.getByTestId('login-button')).toBeEnabled();
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe('新規登録 (signup.tsx)', () => {
  function fillSignup(screen: ReturnType<typeof render>, password = 'Password1') {
    fireEvent.changeText(screen.getByTestId('signup-email-input'), 'New@Example.com');
    fireEvent.changeText(screen.getByTestId('signup-password-input'), password);
  }

  describe('Turnstile 無効 (サイトキー未設定)', () => {
    beforeEach(() => {
      delete process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
    });

    it('ウィジェットを出さず、signUp へ今までと同じ引数 (options は emailRedirectTo だけ) で渡す', async () => {
      const screen = render(<SignupScreen />);
      expect(screen.queryByTestId('turnstile')).toBeNull();
      expect(screen.getByTestId('signup-button')).toBeEnabled();
      fillSignup(screen);

      fireEvent.press(screen.getByTestId('signup-button'));

      await waitFor(() => expect(mockSignUp).toHaveBeenCalledTimes(1));
      const [credentials] = mockSignUp.mock.calls[0];
      expect(credentials).toEqual({
        email: 'new@example.com',
        password: 'Password1',
        options: { emailRedirectTo: 'homegohan:///auth/verify' },
      });
      expect(Object.keys(credentials.options)).toEqual(['emailRedirectTo']);
    });
  });

  describe('Turnstile 有効 (サイトキーあり)', () => {
    beforeEach(() => {
      process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = SITE_KEY;
    });

    it('トークンが無い間はボタンが無効で、押しても Supabase を呼ばない', async () => {
      const screen = render(<SignupScreen />);
      fillSignup(screen);

      expect(screen.getByTestId('signup-button')).toBeDisabled();
      fireEvent.press(screen.getByTestId('signup-button'));

      await act(async () => {});
      expect(mockSignUp).not.toHaveBeenCalled();
    });

    it('トークンが届くと、options.captchaToken (emailRedirectTo と同じ階層) に付けて渡し、送信後はトークンを取り直す', async () => {
      const screen = render(<SignupScreen />);
      fillSignup(screen);
      postFromWebView({ type: 'token', token: 'tok-signup-1' });
      expect(screen.getByTestId('signup-button')).toBeEnabled();

      fireEvent.press(screen.getByTestId('signup-button'));

      await waitFor(() => expect(mockSignUp).toHaveBeenCalledTimes(1));
      expect(mockSignUp).toHaveBeenCalledWith({
        email: 'new@example.com',
        password: 'Password1',
        options: { emailRedirectTo: 'homegohan:///auth/verify', captchaToken: 'tok-signup-1' },
      });
      expect(mockMounts).toBe(2);
    });

    it('パスワードの強度で弾いたときは、使っていないトークンを捨てない', async () => {
      const screen = render(<SignupScreen />);
      fillSignup(screen, 'abc1');
      postFromWebView({ type: 'token', token: 'tok-signup-1' });

      fireEvent.press(screen.getByTestId('signup-button'));

      await waitFor(() =>
        expect(Alert.alert).toHaveBeenCalledWith('入力エラー', 'パスワードは8文字以上にしてください。'),
      );
      expect(mockSignUp).not.toHaveBeenCalled();
      expect(mockMounts).toBe(1); // WebView は作り直していない
      expect(screen.getByTestId('signup-button')).toBeEnabled();
    });

    it('Supabase が CAPTCHA の確認を断ったら、英語の生のエラー文ではなく日本語の文言を出す', async () => {
      mockSignUp.mockResolvedValue({ data: { user: null }, error: CAPTCHA_ERROR });
      const screen = render(<SignupScreen />);
      fillSignup(screen);
      postFromWebView({ type: 'token', token: 'tok-signup-1' });

      fireEvent.press(screen.getByTestId('signup-button'));

      await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('登録失敗', CAPTCHA_FAILED_MESSAGE));
      expect(screen.getByText(CAPTCHA_FAILED_MESSAGE)).toBeTruthy();
      expect(screen.queryByText(/captcha verification process failed/)).toBeNull();
      expect(screen.getByTestId('signup-button')).toBeDisabled(); // 新しいトークンが届くまで
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe('パスワード再設定 (auth/forgot-password.tsx)', () => {
  describe('Turnstile 無効 (サイトキー未設定)', () => {
    beforeEach(() => {
      delete process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
    });

    it('ウィジェットを出さず、resetPasswordForEmail へ今までと同じ引数 (redirectTo だけ) で渡す', async () => {
      const screen = render(<ForgotPasswordPage />);
      expect(screen.queryByTestId('turnstile')).toBeNull();
      expect(screen.getByTestId('forgot-submit-button')).toBeEnabled();
      fireEvent.changeText(screen.getByTestId('forgot-email-input'), 'reset@example.com');

      fireEvent.press(screen.getByTestId('forgot-submit-button'));

      await waitFor(() => expect(mockResetPasswordForEmail).toHaveBeenCalledTimes(1));
      const [email, options] = mockResetPasswordForEmail.mock.calls[0];
      expect(email).toBe('reset@example.com');
      expect(options).toEqual({ redirectTo: 'homegohan:///auth/reset-password' });
      expect(Object.keys(options)).toEqual(['redirectTo']);
    });
  });

  describe('Turnstile 有効 (サイトキーあり)', () => {
    beforeEach(() => {
      process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = SITE_KEY;
    });

    it('トークンが無い間はボタンが無効で、押しても Supabase を呼ばない', async () => {
      const screen = render(<ForgotPasswordPage />);
      fireEvent.changeText(screen.getByTestId('forgot-email-input'), 'reset@example.com');

      expect(screen.getByTestId('forgot-submit-button')).toBeDisabled();
      fireEvent.press(screen.getByTestId('forgot-submit-button'));

      await act(async () => {});
      expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
    });

    it('captchaToken は第 2 引数の直下 (redirectTo と同じ階層) に渡す。options の中には入れない', async () => {
      const screen = render(<ForgotPasswordPage />);
      fireEvent.changeText(screen.getByTestId('forgot-email-input'), 'reset@example.com');
      postFromWebView({ type: 'token', token: 'tok-reset-1' });
      expect(screen.getByTestId('forgot-submit-button')).toBeEnabled();

      fireEvent.press(screen.getByTestId('forgot-submit-button'));

      await waitFor(() => expect(mockResetPasswordForEmail).toHaveBeenCalledTimes(1));
      const [email, options] = mockResetPasswordForEmail.mock.calls[0];
      expect(email).toBe('reset@example.com');
      expect(options).toEqual({ redirectTo: 'homegohan:///auth/reset-password', captchaToken: 'tok-reset-1' });
      // supabase-js は options.options.captchaToken を読まない。入れると黙って無視されて CAPTCHA を通らなくなる
      expect(options).not.toHaveProperty('options');
      expect(mockMounts).toBe(2); // トークンを使ったので、WebView を作り直した
      expect(screen.getByTestId('forgot-submit-button')).toBeDisabled();
    });

    it('メールアドレスが空のときは、使っていないトークンを捨てない', async () => {
      const screen = render(<ForgotPasswordPage />);
      postFromWebView({ type: 'token', token: 'tok-reset-1' });

      fireEvent.press(screen.getByTestId('forgot-submit-button'));

      await waitFor(() =>
        expect(Alert.alert).toHaveBeenCalledWith('入力エラー', 'メールアドレスを入力してください。'),
      );
      expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
      expect(mockMounts).toBe(1); // WebView は作り直していない
    });

    it('Supabase が CAPTCHA の確認を断ったら、英語の生のエラー文ではなく日本語の文言を出す', async () => {
      mockResetPasswordForEmail.mockResolvedValue({ error: CAPTCHA_ERROR });
      const screen = render(<ForgotPasswordPage />);
      fireEvent.changeText(screen.getByTestId('forgot-email-input'), 'reset@example.com');
      postFromWebView({ type: 'token', token: 'tok-reset-1' });

      fireEvent.press(screen.getByTestId('forgot-submit-button'));

      await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('送信失敗', CAPTCHA_FAILED_MESSAGE));
      expect(Alert.alert).not.toHaveBeenCalledWith('送信失敗', 'captcha verification process failed');
    });
  });
});
