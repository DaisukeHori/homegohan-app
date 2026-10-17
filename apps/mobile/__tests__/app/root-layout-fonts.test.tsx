/**
 * root-layout-fonts.test.tsx — app/_layout.tsx の字形 (Noto Sans JP) の読み込み (#588)
 *
 *  - 字形の読み込みが終わるまでは何も描かず、スプラッシュを出したままにする
 *  - 読み込めたら、スプラッシュを閉じて画面を描き、共通の部品 (Text) に字形を当てさせる
 *  - 読み込みに失敗しても止めない: スプラッシュを閉じて、システムの字形で画面を描く (端末のログに残す)
 *  - 読み込むのは Regular / Medium / Bold の 3 つ (src/theme/fontSources.ts) で、実行時に読み込む (useFonts)
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import type { TextStyle } from 'react-native';
import { render, screen } from '@testing-library/react-native';

// ── 字形の読み込み (expo-font の useFonts) は、テストごとに結果を差し替える ─────────────
const mockUseFonts = jest.fn();
jest.mock('expo-font', () => ({ useFonts: (...args: unknown[]) => mockUseFonts(...args) }));
jest.mock('../../src/theme/fontSources', () => ({
  notoSansJpFontSources: {
    NotoSansJP_400Regular: 'regular-ttf',
    NotoSansJP_500Medium: 'medium-ttf',
    NotoSansJP_700Bold: 'bold-ttf',
  },
}));

const mockPreventAutoHideAsync = jest.fn();
const mockHideAsync = jest.fn();
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: () => mockPreventAutoHideAsync(),
  hideAsync: () => mockHideAsync(),
}));

// ── 画面の代わりに、共通の部品の Text を 1 つ描く Stack ──────────────────────────
jest.mock('expo-router', () => {
  const React = require('react');
  const { View } = require('react-native');
  const { Text } = require('../../src/components/ui/Text');
  function Stack() {
    return React.createElement(
      View,
      { testID: 'stack' },
      React.createElement(Text, { testID: 'screen-title', style: { fontWeight: '700' } }, '献立'),
    );
  }
  Stack.Screen = function StackScreen() {
    return null;
  };
  return { Stack, router: { replace: jest.fn() } };
});

jest.mock('../../src/providers/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ session: null, user: null, isLoading: false }),
}));
jest.mock('../../src/providers/LegalConsentProvider', () => ({
  LegalConsentProvider: ({ children }: { children: React.ReactNode }) => children,
  useLegalConsent: () => ({ state: 'clear', status: null, refresh: jest.fn() }),
}));
jest.mock('../../src/components/legal/LegalConsentGate', () => ({ LegalConsentGate: () => null }));
jest.mock('../../src/providers/ProfileProvider', () => ({
  ProfileProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../src/lib/pushNotifications', () => ({ ensurePushTokenRegistered: jest.fn() }));
jest.mock('../../src/components/NotificationRouter', () => ({ NotificationRouter: () => null }));
jest.mock('../../src/lib/error-report', () => ({ reportBoundaryError: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const ENV_NAMES = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY', 'EXPO_PUBLIC_API_BASE_URL'] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

function renderRootLayout() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RootLayout = require('../../app/_layout').default;
  return render(<RootLayout />);
}

function titleStyle(): TextStyle {
  return StyleSheet.flatten(screen.getByTestId('screen-title').props.style as TextStyle) ?? {};
}

beforeEach(() => {
  mockUseFonts.mockReset();
  mockHideAsync.mockReset();
  for (const name of ENV_NAMES) ORIGINAL_ENV[name] = process.env[name];
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://abcdefgh.supabase.co';
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.com';
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (ORIGINAL_ENV[name] === undefined) delete process.env[name];
    else process.env[name] = ORIGINAL_ENV[name];
  }
});

describe('RootLayout — 字形 (Noto Sans JP) の読み込み (#588)', () => {
  it('読み込む前 (モジュールの読み込み時) に、スプラッシュを自動で閉じないようにしている', () => {
    mockPreventAutoHideAsync.mockClear();
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../app/_layout');
    });
    expect(mockPreventAutoHideAsync).toHaveBeenCalledTimes(1);
  });

  it('Regular / Medium / Bold の 3 つを useFonts で実行時に読み込む', () => {
    mockUseFonts.mockReturnValue([true, null]);
    renderRootLayout();
    expect(mockUseFonts).toHaveBeenCalledWith({
      NotoSansJP_400Regular: 'regular-ttf',
      NotoSansJP_500Medium: 'medium-ttf',
      NotoSansJP_700Bold: 'bold-ttf',
    });
  });

  it('読み込み中は何も描かず、スプラッシュを閉じない', () => {
    mockUseFonts.mockReturnValue([false, null]);
    const { toJSON } = renderRootLayout();
    expect(toJSON()).toBeNull();
    expect(screen.queryByTestId('stack')).toBeNull();
    expect(mockHideAsync).not.toHaveBeenCalled();
  });

  it('読み込めたら、スプラッシュを閉じて画面を描き、画面の文字に Noto Sans JP の字形が当たる', () => {
    mockUseFonts.mockReturnValue([true, null]);
    renderRootLayout();
    expect(screen.getByTestId('stack')).toBeTruthy();
    expect(mockHideAsync).toHaveBeenCalledTimes(1);
    const style = titleStyle();
    expect(style.fontFamily).toBe('NotoSansJP_700Bold');
    expect(style).not.toHaveProperty('fontWeight');
  });

  it('読み込み中から読み込めたに変わったら、そこでスプラッシュを閉じて画面を描く', () => {
    mockUseFonts.mockReturnValue([false, null]);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RootLayout = require('../../app/_layout').default;
    const { rerender } = render(<RootLayout />);
    expect(mockHideAsync).not.toHaveBeenCalled();

    mockUseFonts.mockReturnValue([true, null]);
    rerender(<RootLayout />);
    expect(screen.getByTestId('stack')).toBeTruthy();
    expect(mockHideAsync).toHaveBeenCalledTimes(1);
  });

  it('読み込みに失敗しても止めない: スプラッシュを閉じ、システムの字形 (fontWeight のまま) で画面を描き、端末のログに残す', () => {
    mockUseFonts.mockReturnValue([false, new Error('font download failed')]);
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      renderRootLayout();
      expect(screen.getByTestId('stack')).toBeTruthy();
      expect(mockHideAsync).toHaveBeenCalledTimes(1);
      const style = titleStyle();
      expect(style).not.toHaveProperty('fontFamily');
      expect(style.fontWeight).toBe('700');
      expect(consoleWarn.mock.calls.map((call) => String(call[0]))).toContainEqual(
        expect.stringContaining('font download failed'),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('必須の環境変数が無いときの設定エラーの画面も、読み込めたら Noto Sans JP の字形で描く', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    mockUseFonts.mockReturnValue([true, null]);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderRootLayout();
      const title = screen.getByText('アプリの設定が不足しています');
      const style = StyleSheet.flatten(title.props.style as TextStyle) ?? {};
      expect(style.fontFamily).toMatch(/^NotoSansJP_/);
      expect(style).not.toHaveProperty('fontWeight');
    } finally {
      consoleError.mockRestore();
    }
  });
});
