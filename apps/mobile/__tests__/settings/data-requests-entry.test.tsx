/**
 * data-requests-entry.test.tsx
 * #1812: アカウントの画面 (apps/mobile/app/settings/account.tsx) の「開示・訂正・利用停止の請求」の項目と、
 * 押した先の請求の画面 (apps/mobile/app/settings/data-requests.tsx。Web の請求の画面を WebView で開く) を確かめる
 * (設計 docs/design/cross/15-data-subject-requests.md §9・§19)。
 *
 *  1. 項目が出て、見出し・説明の文は Web の設定の項目と同じ共用の値 (@homegohan/shared) で、その文字列そのもの
 *  2. 押すと請求の画面の経路 (DSR_SCREEN_ROUTE) へ移り、その経路は Web の請求の画面のパス (DSR_SETTINGS_PATH) と同じ
 *  3. 請求の画面は WebViewScreen に DSR_SETTINGS_PATH を渡す (AI の同意の画面と同じ開き方)
 *  4. 経路に当たる画面のファイルが app/ にある (押しても Unmatched Route にならない)
 * Web とモバイルの値の突き合わせは tests/data-subject-requests-mobile-contract.test.ts。
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import {
  DSR_SETTINGS_ENTRY_DESCRIPTION as SHARED_DSR_SETTINGS_ENTRY_DESCRIPTION,
  DSR_SETTINGS_ENTRY_TITLE as SHARED_DSR_SETTINGS_ENTRY_TITLE,
  DSR_SETTINGS_PATH as SHARED_DSR_SETTINGS_PATH,
} from '@homegohan/shared';

// ---- Mocks ----
const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    replace: (...args: unknown[]) => mockReplace(...args),
  },
}));

const mockPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: (...args: unknown[]) => mockPost(...args) }),
}));

jest.mock('../../src/lib/supabase', () => ({
  SUPABASE_AUTH_STORAGE_KEY: 'sb-test-auth-token',
  supabase: { auth: { getUser: jest.fn(), signOut: jest.fn() } },
}));

jest.mock('../../src/lib/signOut', () => ({
  signOutAfterAccountDeletion: jest.fn(),
  signOutOnDevice: jest.fn(),
}));

jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => ({ clearSession: jest.fn() }),
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// パスワード・メールアドレスの変更の部品 (#1187) は account-credentials.test.tsx が確かめる。ここでは請求の項目だけを見る
jest.mock('../../src/components/settings/AccountCredentialsSection', () => ({
  AccountCredentialsSection: () => null,
}));

// 請求の画面が WebViewScreen に渡す値を記録する (WebView そのものは描かない)
const mockWebViewScreen = jest.fn();
jest.mock('../../src/components/web/WebViewScreen', () => ({
  WebViewScreen: (props: Record<string, unknown>) => {
    mockWebViewScreen(props);
    return null;
  },
}));

import AccountSettingsPage from '../../app/settings/account';
import DataRequestsSettingsScreen from '../../app/settings/data-requests';
import {
  DSR_SCREEN_ROUTE,
  DSR_SETTINGS_ENTRY_DESCRIPTION,
  DSR_SETTINGS_ENTRY_TITLE,
  DSR_SETTINGS_PATH,
} from '../../src/lib/data-subject-requests';

/** apps/mobile/app (Expo Router の画面のファイルの置き場) */
const APP_DIR = path.resolve(__dirname, '../../app');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('アカウントの画面 — 開示・訂正・利用停止の請求の項目 (#1812)', () => {
  it('項目があり、見出し・説明の文は Web の設定の項目と同じ共用の値', () => {
    render(<AccountSettingsPage />);

    const row = screen.getByTestId('account-data-requests-row');
    expect(row).toBeTruthy();
    expect(screen.getByText(DSR_SETTINGS_ENTRY_TITLE)).toBeTruthy();
    expect(screen.getByText(DSR_SETTINGS_ENTRY_DESCRIPTION)).toBeTruthy();
    expect(DSR_SETTINGS_ENTRY_TITLE).toBe(SHARED_DSR_SETTINGS_ENTRY_TITLE);
    expect(DSR_SETTINGS_ENTRY_DESCRIPTION).toBe(SHARED_DSR_SETTINGS_ENTRY_DESCRIPTION);
    // Web の設定の項目 (src/app/(main)/settings/page.tsx) と同じ文字列 (data-requests-link.test.ts が Web 側で同じ文を確かめる)
    expect(DSR_SETTINGS_ENTRY_TITLE).toBe('開示・訂正・利用停止の請求');
    expect(DSR_SETTINGS_ENTRY_DESCRIPTION).toBe('個人情報の開示・訂正・利用停止・消去を請求する');
  });

  it('押すと請求の画面の経路へ 1 回だけ移り、その経路は Web の請求の画面のパス (DSR_SETTINGS_PATH) と同じ', () => {
    render(<AccountSettingsPage />);

    fireEvent.press(screen.getByTestId('account-data-requests-row'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(DSR_SCREEN_ROUTE);
    expect(DSR_SCREEN_ROUTE).toBe(SHARED_DSR_SETTINGS_PATH);
    expect(DSR_SCREEN_ROUTE).toBe('/settings/data-requests');
    // 押しただけでは退会の API も入口への移動も起きない
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('退会のボタンより上 (危険な操作の前) に並ぶ', () => {
    render(<AccountSettingsPage />);

    const ids: string[] = [];
    const walk = (node: ReturnType<typeof screen.toJSON>): void => {
      if (!node) return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const testID = node.props?.testID;
      if (typeof testID === 'string') ids.push(testID);
      (node.children ?? []).forEach((child) => {
        if (typeof child !== 'string') walk(child);
      });
    };
    walk(screen.toJSON());

    expect(ids).toContain('account-data-requests-row');
    expect(ids).toContain('account-delete-button');
    expect(ids.indexOf('account-data-requests-row')).toBeLessThan(ids.indexOf('account-delete-button'));
  });
});

describe('請求の画面 app/settings/data-requests.tsx (#1812)', () => {
  it('Web の請求の画面 (DSR_SETTINGS_PATH) を WebViewScreen で開く', () => {
    render(<DataRequestsSettingsScreen />);

    expect(mockWebViewScreen).toHaveBeenCalled();
    const props = mockWebViewScreen.mock.calls[0][0] as { path: unknown; testID: unknown };
    expect(props.path).toBe(DSR_SETTINGS_PATH);
    expect(props.path).toBe(SHARED_DSR_SETTINGS_PATH);
    expect(props.testID).toBe('webview-data-requests');
  });

  it('押した先の経路 (DSR_SCREEN_ROUTE) に当たる画面のファイルが app/ にある', () => {
    const screenFile = path.join(APP_DIR, `${DSR_SCREEN_ROUTE}.tsx`);
    expect(fs.existsSync(screenFile)).toBe(true);
    expect(path.relative(APP_DIR, screenFile)).toBe(path.join('settings', 'data-requests.tsx'));
  });
});
