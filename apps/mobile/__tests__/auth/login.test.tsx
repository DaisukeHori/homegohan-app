/**
 * login.test.tsx
 * RNTL tests for apps/mobile/app/(auth)/login.tsx
 *
 * Covers:
 *  1. email を lowercase に正規化して signInWithPassword を呼ぶ
 *  2. 空入力時はバリデーションエラーを出して API を呼ばない
 *  3. 30 秒 rate-limit が AsyncStorage から復元され UI に表示される
 *  4. ログイン後の振り分け (#1122): admin / super_admin も一般ユーザーと同じ振り分けになり、
 *     廃止した管理者画面 (/admin) へは行かない
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

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams = {};
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

// ---- 4. ログイン後の振り分け (#1122) ----
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
