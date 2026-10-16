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
 *
 * 公開ページ ((public)/_layout) は native-stack のヘッダを出さない (#1822)。見出しと戻る操作は PublicPage の
 * 自前のヘッダが描く。今はヘッダを出す区画が無いので、ヘッダの文字に渡す useFontFaceStyle の値は、
 * hook を直接描いて確かめる (font-family-guard の 5 つ目が、ヘッダを出す区画にこの hook を求めるため)。
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import { render } from '@testing-library/react-native';

import { FontsReadyProvider, useFontFaceStyle } from '../../src/components/ui/Text';
import type { FontFaceStyle } from '../../src/components/ui/Text';

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

describe('(public)/_layout の native-stack のヘッダ (/about・/terms・/privacy) (#1822)', () => {
  it.each<FontsState>(['ready', 'failed', 'outside-provider'])(
    'ヘッダを出さない (%s)。見出しと戻る操作は PublicPage の自前のヘッダが描くので、2 段にならない',
    (state) => {
      renderWithFonts(<PublicLayout />, state);
      expect(mockCaptured.stack).toEqual({ headerShown: false });
    },
  );

  it('ヘッダを出さないので、native-stack が描く見出し・戻るボタンの文字の style を渡さない', () => {
    renderWithFonts(<PublicLayout />, 'ready');
    expect(mockCaptured.stack).not.toHaveProperty('headerTitleStyle');
    expect(mockCaptured.stack).not.toHaveProperty('headerBackTitleStyle');
  });
});

describe('useFontFaceStyle (ヘッダを出す区画が headerTitleStyle / headerBackTitleStyle に渡す値)', () => {
  /** iOS のナビゲーションバーの見出しの既定 (semibold) の太さ */
  const SEMIBOLD = '600';

  function faceStyleOf(fontWeight: FontFaceStyle['fontWeight'], state: FontsState): FontFaceStyle {
    const captured: { style: FontFaceStyle | null } = { style: null };
    function Probe() {
      captured.style = useFontFaceStyle(fontWeight);
      return null;
    }
    renderWithFonts(<Probe />, state);
    expect(captured.style).not.toBeNull();
    return captured.style as FontFaceStyle;
  }

  it('字形を読み込めたとき: 600 は Bold・省くと Regular の字形で、fontWeight は無い', () => {
    expect(faceStyleOf(SEMIBOLD, 'ready')).toEqual({ fontFamily: 'NotoSansJP_700Bold' });
    expect(faceStyleOf(undefined, 'ready')).toEqual({ fontFamily: 'NotoSansJP_400Regular' });
  });

  it.each<FontsState>(['failed', 'outside-provider'])(
    '字形を読み込めていないとき (%s): 字形名を渡さず、太さは fontWeight で残す (省くと空)',
    (state) => {
      expect(faceStyleOf(SEMIBOLD, state)).toEqual({ fontWeight: SEMIBOLD });
      expect(faceStyleOf(undefined, state)).toEqual({});
    },
  );
});
