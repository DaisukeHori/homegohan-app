/**
 * login.test.tsx
 * RNTL tests for apps/mobile/app/(auth)/login.tsx
 *
 * Covers:
 *  1. email を lowercase に正規化して signInWithPassword を呼ぶ
 *  2. 空入力時はバリデーションエラーを出して API を呼ばない
 *  3. 30 秒 rate-limit が AsyncStorage から復元され UI に表示される
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// ---- Mocks (before any component imports) ----

// Supabase mock
const mockSignInWithPassword = jest.fn();
const mockGetUser = jest.fn();
const mockFrom = jest.fn();

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: any[]) => mockSignInWithPassword(...args),
      getUser: (...args: any[]) => mockGetUser(...args),
      signInWithOAuth: jest.fn().mockResolvedValue({ data: { url: null }, error: null }),
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
jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: jest.fn().mockResolvedValue({ type: 'cancel' }),
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
  // Re-apply spy since clearAllMocks resets mock implementations
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
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
