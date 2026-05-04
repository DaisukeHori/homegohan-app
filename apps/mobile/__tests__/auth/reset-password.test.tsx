/**
 * reset-password.test.tsx
 * RNTL tests for apps/mobile/app/(auth)/auth/reset-password.tsx
 *
 * Covers:
 *  1. パスワードが一致しないとき updateUser を呼ばない
 *  2. パスワードが 8 文字未満のときエラーを出す
 *  3. 正常時に updateUser を呼ぶ
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
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
  mockExchangeCodeForSession.mockResolvedValue({ error: null });
});

describe('ResetPasswordPage', () => {
  it('1. パスワードが一致しないとき updateUser を呼ばない', async () => {
    const { getByPlaceholderText, getByText } = render(<ResetPasswordPage />);

    fireEvent.changeText(getByPlaceholderText('8文字以上'), 'Password1');
    fireEvent.changeText(getByPlaceholderText('もう一度入力'), 'Different1');
    fireEvent.press(getByText('パスワードを更新'));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith('入力エラー', 'パスワードが一致しません。');
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('2. パスワードが 8 文字未満のとき長さエラーを出す', async () => {
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
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('3. 正常なパスワード入力で updateUser を呼ぶ', async () => {
    mockUpdateUser.mockResolvedValue({ error: null });
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
      expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'NewPassword1' });
    });
    expect(Alert.alert).toHaveBeenCalledWith('完了', expect.stringContaining('更新しました'));
  });
});
