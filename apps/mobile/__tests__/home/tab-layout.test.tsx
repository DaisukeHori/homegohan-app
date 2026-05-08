/**
 * tab-layout.test.tsx
 * タブナビゲーション (_layout.tsx) のユニットテスト
 *
 * テスト対象:
 *  - タブの本数 (6本)
 *  - 各タブのアイコン・タイトル
 *    - home → icon: "home"
 *    - menus → icon: "book-outline"
 *    - meals → icon: "scan" (スキャン / 中央ボタン)
 *    - favorites → icon: "heart"
 *    - comparison → icon: "bar-chart"
 *    - profile → icon: "person"
 */

import React from 'react';
import { render } from '@testing-library/react-native';

// ── expo-router のモック ──────────────────────────────────────────────────────
const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React = require('react');
  const { View, Text, TouchableOpacity } = require('react-native');

  // Tabs.Screen の設定を収集するためのストア
  const screenConfigs: Array<{ name: string; options: any }> = [];

  const TabsScreen = ({ name, options }: { name: string; options?: any }) => {
    // 収集(副作用)
    const existing = screenConfigs.find((s) => s.name === name);
    if (!existing) screenConfigs.push({ name, options: options ?? {} });
    return null;
  };

  const Tabs = ({ children }: any) => {
    return React.createElement(View, { testID: 'tabs-container' }, children);
  };
  Tabs.Screen = TabsScreen;

  // テストから参照できるようにエクスポート
  (Tabs as any).__screenConfigs = screenConfigs;

  return {
    router: { push: mockPush },
    Tabs,
    Redirect: ({ href }: { href: string }) =>
      React.createElement(View, { testID: `redirect-${href}` }),
  };
});

// ── useAuth のモック ──────────────────────────────────────────────────────────
let mockAuthState = {
  session: { user: { id: 'user-1' } } as any,
  isLoading: false,
};

jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => mockAuthState,
}));

// ── useProfile のモック ───────────────────────────────────────────────────────
let mockProfileState = {
  isLoading: false,
  profile: { onboardingCompletedAt: '2024-01-01', onboardingStartedAt: null } as any,
};

jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => mockProfileState,
}));

// ── @expo/vector-icons のモック ───────────────────────────────────────────────
jest.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name, size, color, testID }: any) => {
    const { Text } = require('react-native');
    return <Text testID={testID ?? `icon-${name}`} accessibilityLabel={name}>{name}</Text>;
  },
}));

// ── theme モック ─────────────────────────────────────────────────────────────
jest.mock('../../src/theme', () => ({
  colors: {
    bg: '#FFFFFF',
    card: '#FAFAFA',
    accent: '#FF6B35',
    border: '#E5E5E5',
    text: '#111111',
    textMuted: '#888888',
    accentLight: '#FFF0EC',
    success: '#6B9B6B',
    successLight: '#EDF5ED',
    blue: '#5B8BC7',
    blueLight: '#EEF4FB',
    purple: '#7C6BA0',
    purpleLight: '#F5F3F8',
    warning: '#E5A84B',
    warningLight: '#FEF9EE',
    danger: '#D64545',
    dangerLight: '#FDECEC',
  },
  spacing: {
    xs: 4, sm: 8, md: 12, lg: 16, xl: 20,
    '2xl': 24, '3xl': 32, '4xl': 40, '5xl': 48,
  },
  radius: { sm: 4, md: 8, lg: 12, xl: 16, '2xl': 20, full: 9999 },
  typography: { xs: 12, sm: 14, md: 16, lg: 18, xl: 20, '2xl': 24 },
  shadows: {
    sm: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 1 },
    md: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.10, shadowRadius: 8, elevation: 3 },
    lg: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 12, elevation: 4 },
  },
}));

// ── supabase のモック ─────────────────────────────────────────────────────────
// _layout.tsx の依存チェーン (AIFloatingFab → api.ts → supabase.ts) が
// WebSocket を要求するため stub に差し替える。
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
    })),
  },
}));

import TabsLayout from '../../app/(tabs)/_layout';

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthState = {
    session: { user: { id: 'user-1' } },
    isLoading: false,
  };
  mockProfileState = {
    isLoading: false,
    profile: { onboardingCompletedAt: '2024-01-01', onboardingStartedAt: null },
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. ローディング / リダイレクト
// ─────────────────────────────────────────────────────────────────────────────

describe('TabsLayout: ローディング・認証状態', () => {
  it('isLoading=true のとき ActivityIndicator が表示される', () => {
    mockAuthState = { session: null, isLoading: true };
    const { getByTestId } = render(<TabsLayout />);
    // ActivityIndicator は testID がないため View 存在確認
    // ローディング中は tabs-container が描画されない
    expect(() => getByTestId('tabs-container')).toThrow();
  });

  it('session がない場合 redirect-/ が描画される', () => {
    mockAuthState = { session: null, isLoading: false };
    const { getByTestId } = render(<TabsLayout />);
    expect(getByTestId('redirect-/')).toBeTruthy();
  });

  it('onboarding 未完了・未開始の場合 /onboarding/welcome へリダイレクト', () => {
    mockProfileState = {
      isLoading: false,
      profile: { onboardingCompletedAt: null, onboardingStartedAt: null },
    };
    const { getByTestId } = render(<TabsLayout />);
    expect(getByTestId('redirect-/onboarding/welcome')).toBeTruthy();
  });

  it('onboarding 開始済み・未完了の場合 /onboarding/resume へリダイレクト', () => {
    mockProfileState = {
      isLoading: false,
      profile: { onboardingCompletedAt: null, onboardingStartedAt: '2024-01-01' },
    };
    const { getByTestId } = render(<TabsLayout />);
    expect(getByTestId('redirect-/onboarding/resume')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. タブ数とアイコン
//    _layout.tsx は Tabs.Screen を宣言的に記述するため、
//    レンダリング後に expo-router モックが収集した screenConfigs を検証する。
// ─────────────────────────────────────────────────────────────────────────────

describe('TabsLayout: タブ構成', () => {
  function getScreenConfigs() {
    // expo-router モックが保持するスクリーン設定を取得
    const { Tabs } = require('expo-router');
    return (Tabs as any).__screenConfigs as Array<{ name: string; options: any }>;
  }

  function renderAndGetConfigs() {
    render(<TabsLayout />);
    return getScreenConfigs();
  }

  it('Tabs.Screen が 8 本宣言されている (6 visible + health + settings)', () => {
    const configs = renderAndGetConfigs();
    // home, menus, meals, favorites, comparison, profile, health, settings
    const names = configs.map((c) => c.name);
    expect(names).toContain('home');
    expect(names).toContain('menus');
    expect(names).toContain('meals');
    expect(names).toContain('favorites');
    expect(names).toContain('comparison');
    expect(names).toContain('profile');
    expect(names).toContain('health');
    expect(names).toContain('settings');
    expect(configs.length).toBe(8);
  });

  it('home タブのタイトルが「ホーム」', () => {
    const configs = renderAndGetConfigs();
    const home = configs.find((c) => c.name === 'home');
    expect(home?.options?.title).toBe('ホーム');
  });

  it('menus タブのタイトルが「献立」', () => {
    const configs = renderAndGetConfigs();
    const menus = configs.find((c) => c.name === 'menus');
    expect(menus?.options?.title).toBe('献立');
  });

  it('meals タブのタイトルが「スキャン」', () => {
    const configs = renderAndGetConfigs();
    const meals = configs.find((c) => c.name === 'meals');
    expect(meals?.options?.title).toBe('スキャン');
  });

  it('favorites タブは href: null (タブバー非表示)', () => {
    const configs = renderAndGetConfigs();
    const fav = configs.find((c) => c.name === 'favorites');
    expect(fav?.options?.href).toBeNull();
  });

  it('comparison タブのタイトルが「比較」', () => {
    const configs = renderAndGetConfigs();
    const cmp = configs.find((c) => c.name === 'comparison');
    expect(cmp?.options?.title).toBe('比較');
  });

  it('profile タブのタイトルが「マイページ」', () => {
    const configs = renderAndGetConfigs();
    const prof = configs.find((c) => c.name === 'profile');
    expect(prof?.options?.title).toBe('マイページ');
  });

  it('menus タブのアイコンが "book-outline"', () => {
    const configs = renderAndGetConfigs();
    const menus = configs.find((c) => c.name === 'menus');
    // tabBarIcon は関数 — 実際に呼び出してアイコン名を確認
    const { getByText } = render(menus?.options?.tabBarIcon({ color: '#000', size: 24 }));
    expect(getByText('book-outline')).toBeTruthy();
  });

  it('home タブのアイコンが "home"', () => {
    const configs = renderAndGetConfigs();
    const home = configs.find((c) => c.name === 'home');
    const { getByText } = render(home?.options?.tabBarIcon({ color: '#000', size: 24 }));
    expect(getByText('home')).toBeTruthy();
  });

  it('favorites タブのアイコンは未定義 (href:null のためタブバーに表示されない)', () => {
    const configs = renderAndGetConfigs();
    const fav = configs.find((c) => c.name === 'favorites');
    expect(fav?.options?.tabBarIcon).toBeUndefined();
  });

  it('comparison タブのアイコンが "bar-chart"', () => {
    const configs = renderAndGetConfigs();
    const cmp = configs.find((c) => c.name === 'comparison');
    const { getByText } = render(cmp?.options?.tabBarIcon({ color: '#000', size: 24 }));
    expect(getByText('bar-chart')).toBeTruthy();
  });

  it('profile タブのアイコンが "person"', () => {
    const configs = renderAndGetConfigs();
    const prof = configs.find((c) => c.name === 'profile');
    const { getByText } = render(prof?.options?.tabBarIcon({ color: '#000', size: 24 }));
    expect(getByText('person')).toBeTruthy();
  });

  it('health タブは href: null (タブバー非表示)', () => {
    const configs = renderAndGetConfigs();
    const health = configs.find((c) => c.name === 'health');
    expect(health?.options?.href).toBeNull();
  });

  it('settings タブは href: null (タブバー非表示)', () => {
    const configs = renderAndGetConfigs();
    const settings = configs.find((c) => c.name === 'settings');
    expect(settings?.options?.href).toBeNull();
  });
});
