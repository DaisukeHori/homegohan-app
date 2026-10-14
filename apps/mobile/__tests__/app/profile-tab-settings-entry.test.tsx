/**
 * profile-tab-settings-entry.test.tsx
 * apps/mobile/app/(tabs)/profile.tsx の RNTL テスト (#1037)
 *
 * マイページのタブは WebView (Web の /profile)。設計書 docs/design/mobile/01-architecture.md §3.2 では
 * 設定画面 (ログアウト・通知の設定・退会) はネイティブで作るので、マイページの上の歯車から
 * ネイティブの設定画面 (/(tabs)/settings) を開けなければならない。
 * maestro/smoke.yaml の「9. ログアウト」も、この歯車 (testID: profile-settings-button) を押して設定画面へ行く。
 */

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

// ---- Mocks ----

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockRouterPush(...args) },
}));

// WebViewScreen はセッションの取得や WebView を持つので、受け取った props を記録し、header だけを描く
const mockWebViewScreenProps: Array<Record<string, unknown>> = [];
jest.mock('../../src/components/web/WebViewScreen', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return {
    WebViewScreen: (props: { testID?: string; header?: React.ReactNode } & Record<string, unknown>) => {
      mockWebViewScreenProps.push(props);
      return ReactActual.createElement(View, { testID: props.testID }, props.header);
    },
  };
});

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

import ProfileTab from '../../app/(tabs)/profile';

beforeEach(() => {
  jest.clearAllMocks();
  mockWebViewScreenProps.length = 0;
});

describe('マイページのタブ — ネイティブの設定画面への歯車 (#1037)', () => {
  it('Web のマイページ (/profile) を WebView で開き、その上に歯車を置く', () => {
    const { getByTestId } = render(<ProfileTab />);

    expect(getByTestId('webview-profile')).toBeTruthy();
    expect(mockWebViewScreenProps[0]?.path).toBe('/profile');

    const gear = getByTestId('profile-settings-button');
    expect(gear.props.accessibilityLabel).toBe('設定');
    expect(gear.props.accessibilityRole).toBe('button');
  });

  it('歯車を押すと、ネイティブの設定画面 (/(tabs)/settings) を開く', () => {
    const { getByTestId } = render(<ProfileTab />);

    fireEvent.press(getByTestId('profile-settings-button'));

    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/settings');
  });
});
