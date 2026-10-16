/**
 * navigator-font-styles.test.tsx — ライブラリが中で描く文字 (タブの見出し・native-stack の見出しと戻るボタン) も
 * Noto Sans JP の字形で描く (#588)
 *
 * react-navigation のタブの見出しと native-stack のヘッダは、共通の部品 (src/components/ui/Text.tsx) を通らず
 * ライブラリが中で Text を描く。layout が screenOptions に渡す style を、useFontStyle / useFontFaceStyle で
 * 字形に置き換えていることを、layout を描いて screenOptions を取り出して確かめる。
 *  - 字形を読み込めた (FontsReadyProvider ready): fontFamily が Noto Sans JP の字形名で、fontWeight は無い
 *    (Android は fontWeight だけでは太字の字形を選ばず、字形名と両方あると疑似太字で描くため)
 *  - 読み込めていない (ready=false・Provider の外): fontFamily は無く、太さは fontWeight で残る
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import { render } from '@testing-library/react-native';

import { FontsReadyProvider } from '../../src/components/ui/Text';

type ScreenOptions = Record<string, unknown>;

// ── expo-router のモック: Stack / Tabs に渡された screenOptions を取り出す ──────────────
const mockCaptured: { stack: ScreenOptions | null; tabs: ScreenOptions | null } = { stack: null, tabs: null };
jest.mock('expo-router', () => {
  const React = require('react');
  const { View } = require('react-native');
  function Stack({ screenOptions }: { screenOptions?: ScreenOptions }) {
    mockCaptured.stack = screenOptions ?? null;
    return React.createElement(View, { testID: 'stack' });
  }
  Stack.Screen = function StackScreen() {
    return null;
  };
  function Tabs({ screenOptions, children }: { screenOptions?: ScreenOptions; children?: React.ReactNode }) {
    mockCaptured.tabs = screenOptions ?? null;
    return React.createElement(View, { testID: 'tabs' }, children);
  }
  Tabs.Screen = function TabsScreen() {
    return null;
  };
  return {
    Stack,
    Tabs,
    Redirect: () => null,
    router: { replace: jest.fn(), push: jest.fn() },
  };
});

// ── layout が import する周辺モジュールのモック ─────────────────────────────
jest.mock('../../src/lib/error-report', () => ({ reportBoundaryError: jest.fn() }));
jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => ({ session: { user: { id: 'user-1' } }, isLoading: false }),
}));
jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({
    isLoading: false,
    profile: { onboardingCompletedAt: '2024-01-01', onboardingStartedAt: null },
  }),
}));
jest.mock('../../src/components/ai/AIFloatingFab', () => ({ AIFloatingFab: () => null }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

import PublicLayout from '../../app/(public)/_layout';
import TabsLayout from '../../app/(tabs)/_layout';

type FontsState = 'ready' | 'failed' | 'outside-provider';

function renderWithFonts(element: React.ReactElement, state: FontsState) {
  mockCaptured.stack = null;
  mockCaptured.tabs = null;
  if (state === 'outside-provider') return render(element);
  return render(<FontsReadyProvider ready={state === 'ready'}>{element}</FontsReadyProvider>);
}

function flat(style: unknown): TextStyle {
  return StyleSheet.flatten(style as StyleProp<TextStyle>) ?? {};
}

function optionStyle(options: ScreenOptions | null, key: string): TextStyle {
  expect(options).not.toBeNull();
  expect(options).toHaveProperty(key);
  return flat((options as ScreenOptions)[key]);
}

describe('(tabs)/_layout のタブの見出し (tabBarLabelStyle)', () => {
  it('字形を読み込めたとき: Bold の字形で描き、fontWeight は外す (大きさはそのまま)', () => {
    renderWithFonts(<TabsLayout />, 'ready');
    const style = optionStyle(mockCaptured.tabs, 'tabBarLabelStyle');
    expect(style.fontFamily).toBe('NotoSansJP_700Bold');
    expect(style).not.toHaveProperty('fontWeight');
    expect(style.fontSize).toBe(11);
  });

  it.each<FontsState>(['failed', 'outside-provider'])(
    '字形を読み込めていないとき (%s): システムの字形のまま fontWeight 600 で描く',
    (state) => {
      renderWithFonts(<TabsLayout />, state);
      const style = optionStyle(mockCaptured.tabs, 'tabBarLabelStyle');
      expect(style).not.toHaveProperty('fontFamily');
      expect(style.fontWeight).toBe('600');
      expect(style.fontSize).toBe(11);
    },
  );
});

describe('(public)/_layout の native-stack のヘッダ (/about・/terms・/privacy)', () => {
  it('ヘッダを出す区画である (見出しと戻るボタンの文字を native-stack が描く)', () => {
    renderWithFonts(<PublicLayout />, 'ready');
    expect(mockCaptured.stack).toHaveProperty('headerShown', true);
  });

  it('字形を読み込めたとき: 見出しは Bold・戻るボタンの文字は Regular の字形で、fontWeight は無い', () => {
    renderWithFonts(<PublicLayout />, 'ready');
    const title = optionStyle(mockCaptured.stack, 'headerTitleStyle');
    expect(title).toEqual({ fontFamily: 'NotoSansJP_700Bold' });
    const backTitle = optionStyle(mockCaptured.stack, 'headerBackTitleStyle');
    expect(backTitle).toEqual({ fontFamily: 'NotoSansJP_400Regular' });
  });

  it.each<FontsState>(['failed', 'outside-provider'])(
    '字形を読み込めていないとき (%s): 字形名を渡さず、見出しの太さは fontWeight 600 で残す',
    (state) => {
      renderWithFonts(<PublicLayout />, state);
      const title = optionStyle(mockCaptured.stack, 'headerTitleStyle');
      expect(title).toEqual({ fontWeight: '600' });
      const backTitle = optionStyle(mockCaptured.stack, 'headerBackTitleStyle');
      expect(backTitle).toEqual({});
    },
  );
});
