/**
 * ConfigErrorScreen.test.tsx
 * apps/mobile/src/components/ConfigErrorScreen.tsx のテスト (#1182)
 *
 * 必須の環境変数が入っていないビルドで、app/_layout.tsx が Provider の代わりに出す画面。
 *  - 見出しと、利用者向けの案内を出す
 *  - 足りない環境変数の「名前」を、開発ビルド (__DEV__) でだけ開発者向けに出す (値は読まない)。
 *    リリースビルドの利用者には名前を見せない
 *  - 再試行のボタンは出さない (利用者が直せる問題ではない)
 *  - Provider の外でも描画できる (hooks を使わない)
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';

import { ConfigErrorScreen } from '../../src/components/ConfigErrorScreen';
import { colors } from '../../src/theme';

// WCAG 2.x のコントラスト比 (https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio)
function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const AA_NORMAL_TEXT = 4.5;

describe('ConfigErrorScreen', () => {
  it('見出しと案内を出す (Provider なしで描画できる)', () => {
    const { getByTestId, getByText } = render(<ConfigErrorScreen missing={['EXPO_PUBLIC_SUPABASE_URL']} />);

    expect(getByTestId('config-error-screen')).toBeTruthy();
    expect(getByText('アプリの設定が不足しています')).toBeTruthy();
    expect(getByText(/サーバーに接続するための設定が入っていません/)).toBeTruthy();
  });

  it('開発ビルド (__DEV__) では、足りない環境変数の名前を 1 つずつ出す', () => {
    const { getByTestId, getByText } = render(
      <ConfigErrorScreen missing={['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY']} />,
    );

    expect(getByTestId('config-error-missing')).toBeTruthy();
    expect(getByText('EXPO_PUBLIC_SUPABASE_URL')).toBeTruthy();
    expect(getByText('EXPO_PUBLIC_SUPABASE_ANON_KEY')).toBeTruthy();
  });

  it('足りない変数の指定が空なら、変数名の欄は出さない', () => {
    const { queryByTestId, getByTestId } = render(<ConfigErrorScreen missing={[]} />);

    expect(getByTestId('config-error-screen')).toBeTruthy();
    expect(queryByTestId('config-error-missing')).toBeNull();
  });

  it('小さい文字 (12px) の開発者向けの文は、背景の上で AA (4.5:1) のコントラストに届く', () => {
    const { getByText } = render(<ConfigErrorScreen missing={['EXPO_PUBLIC_SUPABASE_URL']} />);

    for (const element of [getByText(/開発者向け/), getByText('EXPO_PUBLIC_SUPABASE_URL')]) {
      const style = StyleSheet.flatten(element.props.style);
      expect(style.fontSize).toBe(12);
      expect(contrastRatio(String(style.color), colors.bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
    // 前提の確認: 以前の色 (textMuted) は届かない
    expect(contrastRatio(colors.textMuted, colors.bg)).toBeLessThan(AA_NORMAL_TEXT);
  });

  describe('リリースビルド (__DEV__ が false)', () => {
    const globalWithDev = globalThis as typeof globalThis & { __DEV__: boolean };
    let originalDev: boolean;

    beforeEach(() => {
      originalDev = globalWithDev.__DEV__;
      globalWithDev.__DEV__ = false;
    });

    afterEach(() => {
      globalWithDev.__DEV__ = originalDev;
    });

    it('足りない環境変数の名前を画面に出さない (見出しと案内だけを出す)', () => {
      const { getByText, queryByTestId, queryByText } = render(
        <ConfigErrorScreen missing={['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY']} />,
      );

      expect(getByText('アプリの設定が不足しています')).toBeTruthy();
      expect(getByText(/サーバーに接続するための設定が入っていません/)).toBeTruthy();
      expect(queryByTestId('config-error-missing')).toBeNull();
      expect(queryByText(/EXPO_PUBLIC_SUPABASE_URL/)).toBeNull();
      expect(queryByText(/EXPO_PUBLIC_SUPABASE_ANON_KEY/)).toBeNull();
      expect(queryByText(/開発者向け/)).toBeNull();
    });
  });

  it('showMissingNames で明示すれば、__DEV__ に関わらずそれに従う', () => {
    const hidden = render(<ConfigErrorScreen missing={['EXPO_PUBLIC_SUPABASE_URL']} showMissingNames={false} />);
    expect(hidden.queryByText('EXPO_PUBLIC_SUPABASE_URL')).toBeNull();
    hidden.unmount();

    const shown = render(<ConfigErrorScreen missing={['EXPO_PUBLIC_SUPABASE_URL']} showMissingNames />);
    expect(shown.getByText('EXPO_PUBLIC_SUPABASE_URL')).toBeTruthy();
  });

  it('再試行のボタンは出さない (ビルドを作り直さないと直らない)', () => {
    const { queryByText, queryByTestId } = render(<ConfigErrorScreen missing={['EXPO_PUBLIC_SUPABASE_URL']} />);

    expect(queryByText('再試行')).toBeNull();
    expect(queryByTestId('error-fallback-retry')).toBeNull();
  });
});
