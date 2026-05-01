/**
 * forgot-password.test.tsx
 * RNTL tests for apps/mobile/app/(auth)/auth/forgot-password.tsx
 *
 * Covers:
 *  1. 空メールで API を呼ばずエラーを出す
 *  2. resetPasswordForEmail を正しい引数で呼ぶ
 *  3. Supabase エラー時に送信失敗アラートを出す
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// ---- Mocks ----

const mockResetPasswordForEmail = jest.fn();

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      resetPasswordForEmail: (...args: any[]) => mockResetPasswordForEmail(...args),
    },
  },
}));

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  router: { back: (...args: any[]) => mockBack(...args) },
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-linking', () => ({
  createURL: (path: string) => `homegohan://${path}`,
  useURL: () => null,
}));

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

import ForgotPasswordPage from '../../app/(auth)/auth/forgot-password';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

describe('ForgotPasswordPage', () => {
  it('1. 空メールで API を呼ばずエラーアラートを出す', async () => {
    const { getByText } = render(<ForgotPasswordPage />);

    fireEvent.press(getByText('送信'));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith(
        '入力エラー',
        'メールアドレスを入力してください。'
      );
    });
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('2. resetPasswordForEmail を正しい引数で呼ぶ', async () => {
    mockResetPasswordForEmail.mockResolvedValue({ error: null });
    const { getByPlaceholderText, getByText } = render(<ForgotPasswordPage />);

    fireEvent.changeText(getByPlaceholderText('email@example.com'), 'reset@example.com');
    fireEvent.press(getByText('送信'));

    await waitFor(() => {
      expect(mockResetPasswordForEmail).toHaveBeenCalledWith(
        'reset@example.com',
        expect.objectContaining({ redirectTo: expect.stringContaining('reset-password') })
      );
    });
    expect(Alert.alert).toHaveBeenCalledWith('送信しました', expect.any(String));
  });

  it('3. Supabase エラー時に送信失敗アラートを出す', async () => {
    mockResetPasswordForEmail.mockResolvedValue({
      error: { message: 'Rate limit exceeded' },
    });
    const { getByPlaceholderText, getByText } = render(<ForgotPasswordPage />);

    fireEvent.changeText(getByPlaceholderText('email@example.com'), 'fail@example.com');
    fireEvent.press(getByText('送信'));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith('送信失敗', 'Rate limit exceeded');
    });
  });
});
