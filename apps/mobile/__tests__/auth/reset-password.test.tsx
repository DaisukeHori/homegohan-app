/**
 * reset-password.test.tsx
 * RNTL tests for apps/mobile/app/(auth)/auth/reset-password.tsx
 *
 * Covers (#1720 段 C: 更新は supabase.auth.updateUser ではなく POST /api/auth/password/reset。cross/16 §14.7・§16):
 *  1. パスワードが一致しないとき API を呼ばない
 *  2. パスワードが 8 文字未満のときエラーを出し、API を呼ばない
 *  3. 正常時に POST /api/auth/password/reset に { new_password } を送り、updateUser を呼ばない
 *  4. (#1038 F7-10) 更新後のサインアウトは、呼ぶ前のセッションの利用者 ID を共通のログアウト処理 (signOutWithCleanup) に渡す
 *     (supabase.auth.signOut() を直接呼ぶと、この端末の push token が user_push_tokens に残る)
 *  5. 422 (最近使ったパスワード) は本文の error を「更新失敗」で出し、サインアウトしない
 *  6. 403 AUTH_RECOVERY_SESSION_REQUIRED は本文の error を出し、サインアウトしない
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// ---- Mocks ----

const mockGetSession = jest.fn();
const mockUpdateUser = jest.fn();
const mockSignOut = jest.fn();
const mockExchangeCodeForSession = jest.fn();
const mockSetSession = jest.fn();
const mockApiPost = jest.fn();

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...args: any[]) => mockGetSession(...args),
      updateUser: (...args: any[]) => mockUpdateUser(...args),
      signOut: (...args: any[]) => mockSignOut(...args),
      exchangeCodeForSession: (...args: any[]) => mockExchangeCodeForSession(...args),
      setSession: (...args: any[]) => mockSetSession(...args),
    },
  },
}));

jest.mock('../../src/lib/api', () => ({ getApi: () => ({ post: (...args: any[]) => mockApiPost(...args) }) }));

const mockSignOutWithCleanup = jest.fn();
jest.mock('../../src/lib/signOut', () => ({
  signOutWithCleanup: (...args: any[]) => mockSignOutWithCleanup(...args),
}));

jest.mock('../../src/lib/deeplink', () => ({
  extractSupabaseLinkParams: () => ({ code: 'test-code' }),
}));

jest.mock('expo-linking', () => ({
  useURL: () => 'homegohan://auth/reset-password?code=test-code',
  createURL: (path: string) => `homegohan://${path}`,
}));

const mockReplace = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: (...args: any[]) => mockReplace(...args), back: (...args: any[]) => mockBack(...args) },
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('../../src/theme', () => ({
  colors: {
    bg: '#fff', accent: '#f00', text: '#000', textMuted: '#888',
    textLight: '#666', card: '#fafafa', border: '#eee',
    blue: '#00f', blueLight: '#e8f0ff',
    error: '#f00', errorLight: '#ffe8e8',
    success: '#0a0', successLight: '#e8ffe8',
  },
  spacing: { sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { lg: 12 },
  shadows: { sm: {}, md: {} },
}));

import ResetPasswordPage from '../../app/(auth)/auth/reset-password';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  // Simulate existing session so sessionReady = true immediately
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok', user: { id: 'user-reset-1' } } } });
  mockApiPost.mockResolvedValue({ ok: true });
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
  mockSignOutWithCleanup.mockResolvedValue({ error: null });
});

describe('ResetPasswordPage', () => {
  it('1. パスワードが一致しないとき API を呼ばない', async () => {
    const { getByPlaceholderText, getByText } = render(<ResetPasswordPage />);

    fireEvent.changeText(getByPlaceholderText('8文字以上'), 'Password1');
    fireEvent.changeText(getByPlaceholderText('もう一度入力'), 'Different1');
    fireEvent.press(getByText('パスワードを更新'));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith('入力エラー', 'パスワードが一致しません。');
    });
    expect(mockApiPost).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('2. パスワードが 8 文字未満のとき長さエラーを出し、API を呼ばない', async () => {
    const { getByPlaceholderText, getByText } = render(<ResetPasswordPage />);

    fireEvent.changeText(getByPlaceholderText('8文字以上'), 'short');
    fireEvent.changeText(getByPlaceholderText('もう一度入力'), 'short');
    fireEvent.press(getByText('パスワードを更新'));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith(
        '入力エラー',
        'パスワードは8文字以上にしてください。'
      );
    });
    expect(mockApiPost).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('3. 正常なパスワード入力で POST /api/auth/password/reset に { new_password } を送り、updateUser を呼ばない', async () => {
    mockSignOut.mockResolvedValue({});

    const { getByPlaceholderText, getByText } = render(<ResetPasswordPage />);

    // Wait for session to initialize
    await waitFor(() => {
      expect(mockGetSession).toHaveBeenCalled();
    });

    fireEvent.changeText(getByPlaceholderText('8文字以上'), 'NewPassword1');
    fireEvent.changeText(getByPlaceholderText('もう一度入力'), 'NewPassword1');
    fireEvent.press(getByText('パスワードを更新'));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith('/api/auth/password/reset', { new_password: 'NewPassword1' });
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('完了', expect.stringContaining('更新しました'));
  });

  it('4. 更新後のサインアウトは、呼ぶ前のセッションの利用者 ID を共通のログアウト処理に渡して行い、ログイン画面へ移る (supabase.auth.signOut を直接呼ばない)', async () => {
    const { getByPlaceholderText, getByText } = render(<ResetPasswordPage />);
    await waitFor(() => {
      expect(mockGetSession).toHaveBeenCalled();
    });

    fireEvent.changeText(getByPlaceholderText('8文字以上'), 'NewPassword1');
    fireEvent.changeText(getByPlaceholderText('もう一度入力'), 'NewPassword1');
    fireEvent.press(getByText('パスワードを更新'));

    await waitFor(() => {
      expect(mockSignOutWithCleanup).toHaveBeenCalledWith('user-reset-1');
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login');
    });
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('5. 422 のときは本文の error (最近使ったパスワード…) を「更新失敗」で出し、サインアウトしない', async () => {
    mockApiPost.mockRejectedValue(
      new Error(
        'HTTP 422 Unprocessable Entity: {"error":"最近使ったパスワードは使えません。別のパスワードにしてください。","code":"VALID_PASSWORD_HISTORY"}',
      ),
    );

    const { getByPlaceholderText, getByText } = render(<ResetPasswordPage />);
    await waitFor(() => {
      expect(mockGetSession).toHaveBeenCalled();
    });

    fireEvent.changeText(getByPlaceholderText('8文字以上'), 'NewPassword1');
    fireEvent.changeText(getByPlaceholderText('もう一度入力'), 'NewPassword1');
    fireEvent.press(getByText('パスワードを更新'));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith('更新失敗', '最近使ったパスワードは使えません。別のパスワードにしてください。');
    });
    expect(mockSignOutWithCleanup).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('6. 403 AUTH_RECOVERY_SESSION_REQUIRED のときは本文の error (再設定メールのリンクから…) を出し、サインアウトしない', async () => {
    mockApiPost.mockRejectedValue(
      new Error(
        'HTTP 403 Forbidden: {"error":"パスワードの再設定は、再設定メールのリンクから開き直してください。","code":"AUTH_RECOVERY_SESSION_REQUIRED"}',
      ),
    );

    const { getByPlaceholderText, getByText } = render(<ResetPasswordPage />);
    await waitFor(() => {
      expect(mockGetSession).toHaveBeenCalled();
    });

    fireEvent.changeText(getByPlaceholderText('8文字以上'), 'NewPassword1');
    fireEvent.changeText(getByPlaceholderText('もう一度入力'), 'NewPassword1');
    fireEvent.press(getByText('パスワードを更新'));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith('更新失敗', 'パスワードの再設定は、再設定メールのリンクから開き直してください。');
    });
    expect(mockSignOutWithCleanup).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
