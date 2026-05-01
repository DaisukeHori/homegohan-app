/**
 * signup.test.tsx
 * RNTL tests for apps/mobile/app/(auth)/signup.tsx
 *
 * Covers:
 *  1. email が空のとき API を呼ばずエラーを出す
 *  2. password 強度バリデーション — 8 文字未満でエラー
 *  3. identities.length === 0 の silent-success を検知してアラートを出す
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// ---- Mocks ----

const mockSignUp = jest.fn();
const mockSignInWithOAuth = jest.fn();

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      signUp: (...args: any[]) => mockSignUp(...args),
      signInWithOAuth: (...args: any[]) => mockSignInWithOAuth(...args),
    },
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

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

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
        'パスワードは8文字以上にしてください。'
      );
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
});
