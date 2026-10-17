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
// Stack は子を描き、Stack.Screen は受けた props を記録する (#1442 T-RL1: 同意画面の route の宣言を確かめる)
const mockStackScreens: Array<Record<string, unknown>> = [];
jest.mock('expo-router', () => {
  const React = require('react');
  const { View } = require('react-native');
  function Stack({ children }: { children?: React.ReactNode }) {
    return React.createElement(View, { testID: 'stack' }, children);
  }
  Stack.Screen = function StackScreen(props: Record<string, unknown>) {
    mockStackScreens.push(props);
    return null;
  };
  return { Stack, router: { replace: jest.fn() } };
});

// ── Provider のモック。描画されたかどうかを数える ────────────────────────────
// Provider の入れ子 (#1442 T-RL1) は React の context で確かめる: AuthProvider は子を mockAuthContext の値 true で包み、
// LegalConsentProvider はそれを読んで記録してから子を mockLegalConsentContext の値 true で包み、ProfileProvider はそれを記録する
const mockAuthProviderRendered = jest.fn();
const mockAuthContext = require('react').createContext(false);
const mockLegalConsentContext = require('react').createContext(false);
const mockLegalConsentProviderInsideAuth: boolean[] = [];
const mockProfileProviderInsideLegalConsent: boolean[] = [];
const mockLegalConsentGateRendered = jest.fn();
// #1861: AccountFrozenProvider は AuthProvider の中・LegalConsentProvider の外 (同意のゲートが凍結の状態を読む)
const mockAccountFrozenContext = require('react').createContext(false);
const mockAccountFrozenProviderInsideAuth: boolean[] = [];
const mockLegalConsentProviderInsideAccountFrozen: boolean[] = [];
const mockAccountFrozenGateRendered = jest.fn();
jest.mock('../../src/providers/AccountFrozenProvider', () => ({
  AccountFrozenProvider: ({ children }: { children: React.ReactNode }) => {
    const React = require('react');
    mockAccountFrozenProviderInsideAuth.push(React.useContext(mockAuthContext));
    return React.createElement(mockAccountFrozenContext.Provider, { value: true }, children);
  },
  useAccountFrozen: () => ({ state: 'clear', refresh: jest.fn() }),
}));
jest.mock('../../src/components/AccountFrozenGate', () => ({
  AccountFrozenGate: () => {
    mockAccountFrozenGateRendered();
    return null;
  },
}));
jest.mock('../../src/providers/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => {
    mockAuthProviderRendered();
    const React = require('react');
    return React.createElement(mockAuthContext.Provider, { value: true }, children);
  },
  useAuth: () => ({ session: null, user: null, isLoading: false }),
}));
jest.mock('../../src/providers/LegalConsentProvider', () => ({
  LegalConsentProvider: ({ children }: { children: React.ReactNode }) => {
    const React = require('react');
    mockLegalConsentProviderInsideAuth.push(React.useContext(mockAuthContext));
    mockLegalConsentProviderInsideAccountFrozen.push(React.useContext(mockAccountFrozenContext));
    return React.createElement(mockLegalConsentContext.Provider, { value: true }, children);
  },
  useLegalConsent: () => ({ state: 'clear', status: null, refresh: jest.fn() }),
}));
jest.mock('../../src/components/legal/LegalConsentGate', () => ({
  LegalConsentGate: () => {
    mockLegalConsentGateRendered();
    return null;
  },
}));
jest.mock('../../src/providers/ProfileProvider', () => ({
  ProfileProvider: ({ children }: { children: React.ReactNode }) => {
    const React = require('react');
    mockProfileProviderInsideLegalConsent.push(React.useContext(mockLegalConsentContext));
    return children;
  },
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
// 通知の受け取り口 (#1049 F7-11) は __tests__/components/NotificationRouter.test.tsx で確かめる
jest.mock('../../src/components/NotificationRouter', () => ({ NotificationRouter: () => null }));
jest.mock('../../src/lib/error-report', () => ({ reportBoundaryError: jest.fn() }));
// 字形 (Noto Sans JP) は読み込み済みとして扱う。読み込み中・失敗の扱いは __tests__/app/root-layout-fonts.test.tsx (#588)
jest.mock('expo-font', () => ({ useFonts: () => [true, null] }));
jest.mock('../../src/theme/fontSources', () => ({ notoSansJpFontSources: {} }));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(),
  hideAsync: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// process.env は差し替えず、同じオブジェクトを書き換えて戻す。jest-expo では `process.env.EXPO_PUBLIC_X` が
// expo/virtual/env 経由の参照に置き換わり、そこは読み込み時の process.env を握り続けるため
const ENV_NAMES = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY', 'EXPO_PUBLIC_API_BASE_URL'] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

function renderRootLayout() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RootLayout = require('../../app/_layout').default;
  return render(<RootLayout />);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStackScreens.length = 0;
  mockLegalConsentProviderInsideAuth.length = 0;
  mockProfileProviderInsideLegalConsent.length = 0;
  mockAccountFrozenProviderInsideAuth.length = 0;
  mockLegalConsentProviderInsideAccountFrozen.length = 0;
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
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';

    const { getByTestId, queryByTestId } = renderRootLayout();

    expect(getByTestId('stack')).toBeTruthy();
    expect(queryByTestId('config-error-screen')).toBeNull();
    expect(mockAuthProviderRendered).toHaveBeenCalled();
  });

  it('両方無ければ、Provider を立ち上げず、設定エラーの画面を出す (開発ビルドは足りない変数名も出す)', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';

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
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';

    const { getByText, queryByText, queryByTestId } = renderRootLayout();

    expect(getByText('EXPO_PUBLIC_SUPABASE_ANON_KEY')).toBeTruthy();
    expect(queryByText('EXPO_PUBLIC_SUPABASE_URL')).toBeNull();
    expect(queryByText('EXPO_PUBLIC_API_BASE_URL')).toBeNull();
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

  it.each(['', '   ', undefined])(
    'EXPO_PUBLIC_API_BASE_URL が %j なら、Supabase がそろっていても設定エラーの画面を出し、端末のログに変数名を残す (#1434)',
    (value) => {
      process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';
      if (value === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
      else process.env.EXPO_PUBLIC_API_BASE_URL = value;
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { getByTestId, getByText, queryByText, queryByTestId } = renderRootLayout();

        expect(getByTestId('config-error-screen')).toBeTruthy();
        expect(getByText('EXPO_PUBLIC_API_BASE_URL')).toBeTruthy();
        expect(queryByText('EXPO_PUBLIC_SUPABASE_URL')).toBeNull();
        expect(queryByTestId('stack')).toBeNull();
        expect(mockAuthProviderRendered).not.toHaveBeenCalled();
        // リリースビルドの画面には名前を出さないので、端末のログに残す
        expect(consoleError.mock.calls.map((call) => String(call[0]))).toContainEqual(
          expect.stringContaining('[mobile] Missing env: EXPO_PUBLIC_API_BASE_URL'),
        );
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  it('環境変数がそろっていれば、端末のログに設定エラーを残さない', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderRootLayout();

      expect(consoleError.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('[mobile] Missing env');
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('RootLayout — 規約の同意のゲート (#1442 T-RL1)', () => {
  it('LegalConsentProvider が AuthProvider の中・ProfileProvider の外にあり、LegalConsentGate が描かれ、Stack.Screen "legal-consent" が gestureEnabled: false で宣言されていて、その name が LEGAL_CONSENT_SCREEN_ROUTE_NAME と同じ', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';

    renderRootLayout();

    // LegalConsentProvider は AuthProvider の中、ProfileProvider は LegalConsentProvider の中
    expect(mockLegalConsentProviderInsideAuth.length).toBeGreaterThan(0);
    expect(mockLegalConsentProviderInsideAuth.every((inside) => inside === true)).toBe(true);
    expect(mockProfileProviderInsideLegalConsent.length).toBeGreaterThan(0);
    expect(mockProfileProviderInsideLegalConsent.every((inside) => inside === true)).toBe(true);
    // ゲートが描かれる
    expect(mockLegalConsentGateRendered).toHaveBeenCalled();
    // 同意画面の route の宣言
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LEGAL_CONSENT_SCREEN_ROUTE_NAME } = require('../../src/lib/legal-consent');
    const consentScreens = mockStackScreens.filter((props) => props.name === 'legal-consent');
    expect(consentScreens.length).toBeGreaterThan(0);
    for (const props of consentScreens) {
      expect(props.options).toEqual({ gestureEnabled: false });
    }
    expect(LEGAL_CONSENT_SCREEN_ROUTE_NAME).toBe('legal-consent');
  });
});

describe('RootLayout — アカウントの凍結のゲート (#1861)', () => {
  it('AccountFrozenProvider が AuthProvider の中・LegalConsentProvider の外にあり、AccountFrozenGate が描かれ、Stack.Screen "frozen" が gestureEnabled: false で宣言されていて、その name が FROZEN_SCREEN_ROUTE_NAME と同じ', () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';

    renderRootLayout();

    expect(mockAccountFrozenProviderInsideAuth.length).toBeGreaterThan(0);
    expect(mockAccountFrozenProviderInsideAuth.every((inside) => inside === true)).toBe(true);
    expect(mockLegalConsentProviderInsideAccountFrozen.length).toBeGreaterThan(0);
    expect(mockLegalConsentProviderInsideAccountFrozen.every((inside) => inside === true)).toBe(true);
    expect(mockAccountFrozenGateRendered).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { FROZEN_SCREEN_ROUTE_NAME } = require('../../src/lib/account-frozen');
    const frozenScreens = mockStackScreens.filter((props) => props.name === FROZEN_SCREEN_ROUTE_NAME);
    expect(frozenScreens.length).toBeGreaterThan(0);
    for (const props of frozenScreens) {
      expect(props.options).toEqual({ gestureEnabled: false });
    }
    expect(FROZEN_SCREEN_ROUTE_NAME).toBe('frozen');
  });
});
