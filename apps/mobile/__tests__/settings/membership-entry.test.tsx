/**
 * membership-entry.test.tsx
 * #1917: アカウントの画面の退会が 409 (組織のオーナー・家族の代表者) で止まったときの Alert から開く、メンバーシップ設定の画面
 * (apps/mobile/app/settings/membership.tsx。Web のメンバーシップ設定を WebView で開く) を確かめる
 * (設計 docs/design/family/11-self-dissolve.md §15.5・§21.3)。data-requests-entry.test.tsx と同じ形。
 *
 *  1. メンバーシップ設定の画面は WebViewScreen に MEMBERSHIP_SETTINGS_PATH を渡す
 *  2. 経路 (MEMBERSHIP_SETTINGS_SCREEN_ROUTE) に当たる画面のファイルが app/ にある (押しても Unmatched Route にならない)
 *  3. MEMBERSHIP_SETTINGS_PATH は @homegohan/shared の値そのもので、どのタブの受け持ち (NATIVE_APP_TABS) にも入らない
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import { render } from '@testing-library/react-native';
import { MEMBERSHIP_SETTINGS_PATH as SHARED_MEMBERSHIP_SETTINGS_PATH, NATIVE_APP_TABS, findNativeAppTab } from '@homegohan/shared';

// メンバーシップ設定の画面が WebViewScreen に渡す値を記録する (WebView そのものは描かない)
const mockWebViewScreen = jest.fn();
jest.mock('../../src/components/web/WebViewScreen', () => ({
  WebViewScreen: (props: Record<string, unknown>) => {
    mockWebViewScreen(props);
    return null;
  },
}));

import MembershipSettingsScreen from '../../app/settings/membership';
import { MEMBERSHIP_SETTINGS_PATH, MEMBERSHIP_SETTINGS_SCREEN_ROUTE } from '../../src/lib/membership-settings';

/** apps/mobile/app (Expo Router の画面のファイルの置き場) */
const APP_DIR = path.resolve(__dirname, '../../app');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('メンバーシップ設定の画面 app/settings/membership.tsx (#1917)', () => {
  it('app/settings/membership.tsx は Web のメンバーシップ設定 (MEMBERSHIP_SETTINGS_PATH) を WebViewScreen で開く', () => {
    render(<MembershipSettingsScreen />);

    expect(mockWebViewScreen).toHaveBeenCalled();
    const props = mockWebViewScreen.mock.calls[0][0] as { path: unknown; testID: unknown };
    expect(props.path).toBe(MEMBERSHIP_SETTINGS_PATH);
    expect(props.path).toBe('/settings/membership');
    expect(props.testID).toBe('webview-membership-settings');
  });

  it('MEMBERSHIP_SETTINGS_SCREEN_ROUTE に当たる画面のファイルが app/ にある', () => {
    expect(MEMBERSHIP_SETTINGS_SCREEN_ROUTE).toBe(MEMBERSHIP_SETTINGS_PATH);
    const file = path.join(APP_DIR, `${MEMBERSHIP_SETTINGS_SCREEN_ROUTE}.tsx`);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('MEMBERSHIP_SETTINGS_PATH は @homegohan/shared の値そのもので、どのタブの受け持ち (NATIVE_APP_TABS) にも入らない', () => {
    expect(MEMBERSHIP_SETTINGS_PATH).toBe(SHARED_MEMBERSHIP_SETTINGS_PATH);
    expect(NATIVE_APP_TABS.length).toBeGreaterThan(0);
    expect(findNativeAppTab(MEMBERSHIP_SETTINGS_PATH)).toBeNull();
  });
});
