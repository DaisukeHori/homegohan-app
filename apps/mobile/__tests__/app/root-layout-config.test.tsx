/**
 * root-layout-config.test.tsx
 * apps/mobile/app/_layout.tsx が、必須の環境変数が無いビルドで設定エラーの画面を出すことのテスト (#1182)
 *
 * 以前は、EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY が無くても、存在しない接続先 (placeholder) の
 * クライアントでアプリが起動し、ログイン画面が出るのにログインが失敗するだけだった (原因が分からない)。
 *
 *  - 環境変数がそろっていれば、従来どおり Provider と Stack を立ち上げる
 *  - 足りなければ、Provider を立ち上げず (Supabase を触らず)、設定エラーの画面を出す。
 *    足りない変数名を画面に出すのは開発ビルド (__DEV__) だけで、リリースビルドの利用者には見せない
 */

import React from 'react';
import { render } from '@testing-library/react-native';

// ── expo-router モック (layout を読み込むのに必要な最小限) ───────────────────
jest.mock('expo-router', () => {
  const React = require('react');
  const { View } = require('react-native');
  function Stack() {
    return React.createElement(View, { testID: 'stack' });
  }
  Stack.Screen = function StackScreen() {
    return null;
  };
  return { Stack, router: { replace: jest.fn() } };
});

// ── Provider のモック。描画されたかどうかを数える ────────────────────────────
const mockAuthProviderRendered = jest.fn();
jest.mock('../../src/providers/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => {
    mockAuthProviderRendered();
    return children;
  },
  useAuth: () => ({ session: null, user: null, isLoading: false }),
}));
jest.mock('../../src/providers/ProfileProvider', () => ({
  ProfileProvider: ({ children }: { children: React.ReactNode }) => children,
}));
// PostHog の Provider を消す変更が入っても、このテストが「モジュールが無い」で壊れないよう virtual にしている
jest.mock(
  '../../src/providers/PostHogProvider',
  () => ({
    PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
  }),
  { virtual: true },
);
jest.mock('../../src/lib/pushNotifications', () => ({ ensurePushTokenRegistered: jest.fn() }));
jest.mock('../../src/lib/error-report', () => ({ reportBoundaryError: jest.fn() }));
jest.mock('@expo-google-fonts/noto-sans-jp', () => ({
  NotoSansJP_400Regular: 1,
  NotoSansJP_500Medium: 2,
  NotoSansJP_700Bold: 3,
  useFonts: () => [true],
}));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(),
  hideAsync: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// process.env は差し替えず、同じオブジェクトを書き換えて戻す。jest-expo では `process.env.EXPO_PUBLIC_X` が
// expo/virtual/env 経由の参照に置き換わり、そこは読み込み時の process.env を握り続けるため
const ENV_NAMES = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

function renderRootLayout() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RootLayout = require('../../app/_layout').default;
  return render(<RootLayout />);
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const name of ENV_NAMES) ORIGINAL_ENV[name] = process.env[name];
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (ORIGINAL_ENV[name] === undefined) delete process.env[name];
    else process.env[name] = ORIGINAL_ENV[name];
  }
});

describe('RootLayout — 必須の環境変数 (#1182)', () => {
  it('環境変数がそろっていれば、従来どおり Provider と Stack を立ち上げる', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';

    const { getByTestId, queryByTestId } = renderRootLayout();

    expect(getByTestId('stack')).toBeTruthy();
    expect(queryByTestId('config-error-screen')).toBeNull();
    expect(mockAuthProviderRendered).toHaveBeenCalled();
  });

  it('両方無ければ、Provider を立ち上げず、設定エラーの画面を出す (開発ビルドは足りない変数名も出す)', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

    const { getByTestId, getByText, queryByTestId } = renderRootLayout();

    expect(getByTestId('config-error-screen')).toBeTruthy();
    expect(getByText('アプリの設定が不足しています')).toBeTruthy();
    expect(getByText('EXPO_PUBLIC_SUPABASE_URL')).toBeTruthy();
    expect(getByText('EXPO_PUBLIC_SUPABASE_ANON_KEY')).toBeTruthy();
    // Supabase を使う Provider も、画面を並べる Stack も立ち上げない
    expect(queryByTestId('stack')).toBeNull();
    expect(mockAuthProviderRendered).not.toHaveBeenCalled();
  });

  it('片方だけ無ければ、その変数名だけを出す', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = '';

    const { getByText, queryByText, queryByTestId } = renderRootLayout();

    expect(getByText('EXPO_PUBLIC_SUPABASE_ANON_KEY')).toBeTruthy();
    expect(queryByText('EXPO_PUBLIC_SUPABASE_URL')).toBeNull();
    expect(queryByTestId('stack')).toBeNull();
    expect(mockAuthProviderRendered).not.toHaveBeenCalled();
  });
  it('リリースビルド (__DEV__ が false) では、設定エラーの画面に変数名を出さない', () => {
    const globalWithDev = globalThis as typeof globalThis & { __DEV__: boolean };
    const originalDev = globalWithDev.__DEV__;
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    globalWithDev.__DEV__ = false;
    try {
      const { getByTestId, getByText, queryByText, queryByTestId } = renderRootLayout();

      expect(getByTestId('config-error-screen')).toBeTruthy();
      expect(getByText('アプリの設定が不足しています')).toBeTruthy();
      expect(queryByText(/EXPO_PUBLIC_SUPABASE_URL/)).toBeNull();
      expect(queryByText(/EXPO_PUBLIC_SUPABASE_ANON_KEY/)).toBeNull();
      expect(queryByTestId('config-error-missing')).toBeNull();
      expect(queryByTestId('stack')).toBeNull();
      expect(mockAuthProviderRendered).not.toHaveBeenCalled();
    } finally {
      globalWithDev.__DEV__ = originalDev;
    }
  });
});
