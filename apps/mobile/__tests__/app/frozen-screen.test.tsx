/**
 * frozen-screen.test.tsx — apps/mobile/app/frozen.tsx (#1861)
 *
 * 凍結の画面は、Web の凍結の画面 (/frozen) を WebViewScreen で開く (請求の画面 app/settings/data-requests.tsx と同じ形)。
 * 退会・書き出し (/frozen/account)・有料プランの解約 (/frozen/billing)・お問い合わせ (/contact) は Web の画面のまま WebView の中で進む。
 * ログアウト・退会の後は WebViewScreen の既定どおり入口へ移る (afterSignOut を渡さない)。
 */
import { render } from '@testing-library/react-native';
import React from 'react';

const mockWebViewProps: Array<Record<string, unknown>> = [];
jest.mock('../../src/components/web/WebViewScreen', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return {
    WebViewScreen: (props: { testID?: string } & Record<string, unknown>) => {
      mockWebViewProps.push(props);
      return ReactActual.createElement(View, { testID: props.testID });
    },
  };
});

import FrozenScreen from '../../app/frozen';
import { FROZEN_SCREEN_PATH } from '../../src/lib/account-frozen';

beforeEach(() => {
  mockWebViewProps.length = 0;
});

describe('凍結の画面 (app/frozen.tsx)', () => {
  it('WebViewScreen に Web の凍結の画面のパス (/frozen) を渡して開く', () => {
    const { getByTestId } = render(<FrozenScreen />);

    expect(getByTestId('webview-frozen')).toBeTruthy();
    expect(mockWebViewProps).toHaveLength(1);
    expect(mockWebViewProps[0].path).toBe(FROZEN_SCREEN_PATH);
    expect(mockWebViewProps[0].path).toBe('/frozen');
  });

  it('ログアウト・退会の後の行き先は既定 (入口) のまま: afterSignOut も header も渡さない', () => {
    render(<FrozenScreen />);

    expect(mockWebViewProps[0].afterSignOut).toBeUndefined();
    expect(mockWebViewProps[0].header).toBeUndefined();
  });
});
