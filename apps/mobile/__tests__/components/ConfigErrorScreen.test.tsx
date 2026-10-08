/**
 * ConfigErrorScreen.test.tsx
 * apps/mobile/src/components/ConfigErrorScreen.tsx のテスト (#1182)
 *
 * 必須の環境変数が入っていないビルドで、app/_layout.tsx が Provider の代わりに出す画面。
 *  - 見出しと、利用者向けの案内を出す
 *  - 足りない環境変数の「名前」を、開発者向けに出す (値は読まない)
 *  - 再試行のボタンは出さない (利用者が直せる問題ではない)
 *  - Provider の外でも描画できる (hooks を使わない)
 */

import React from 'react';
import { render } from '@testing-library/react-native';

import { ConfigErrorScreen } from '../../src/components/ConfigErrorScreen';

describe('ConfigErrorScreen', () => {
  it('見出しと案内を出す (Provider なしで描画できる)', () => {
    const { getByTestId, getByText } = render(<ConfigErrorScreen missing={['EXPO_PUBLIC_SUPABASE_URL']} />);

    expect(getByTestId('config-error-screen')).toBeTruthy();
    expect(getByText('アプリの設定が不足しています')).toBeTruthy();
    expect(getByText(/サーバーに接続するための設定が入っていません/)).toBeTruthy();
  });

  it('足りない環境変数の名前を 1 つずつ出す', () => {
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

  it('再試行のボタンは出さない (ビルドを作り直さないと直らない)', () => {
    const { queryByText, queryByTestId } = render(<ConfigErrorScreen missing={['EXPO_PUBLIC_SUPABASE_URL']} />);

    expect(queryByText('再試行')).toBeNull();
    expect(queryByTestId('error-fallback-retry')).toBeNull();
  });
});
