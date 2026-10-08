/**
 * logout.test.tsx
 * RNTL tests for the logout flow of apps/mobile/app/(tabs)/settings.tsx (#1038 F7-10)
 *
 * ログアウトは、各画面でバラバラに書かず共通処理 (signOutWithCleanup) を通す。
 * この共通処理が push token の削除 → 端末データの削除 → サインアウトの順に行うため、
 * 画面側は「ユーザー ID を渡して呼ぶこと」と「完了後にトップへ戻ること」を守っていればよい。
 */

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// 設定タブは画面が大きく、初回の描画が重い。CPU の取り合いになる環境 (CI の並列実行など) でも、
// ケースごとの 5 秒の既定を超えて落ちないように上限を広げる (supabase-client.test.ts と同じ)
jest.setTimeout(30_000);

// ---- Mocks ----

const mockSignOutWithCleanup = jest.fn();
jest.mock('../../src/lib/signOut', () => ({
  signOutWithCleanup: (...args: unknown[]) => mockSignOutWithCleanup(...args),
}));

const mockRouterReplace = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    replace: (...args: unknown[]) => mockRouterReplace(...args),
    push: jest.fn(),
  },
}));

jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'uid-settings' } }),
}));

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: jest.fn().mockResolvedValue({
      settings: { notifications_enabled: true, auto_analyze_enabled: true, data_share_enabled: false },
    }),
    patch: jest.fn().mockResolvedValue({}),
  }),
  getApiBaseUrl: () => 'https://api.example.test',
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) },
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { week_start_day: 'monday' } }),
      update: jest.fn().mockReturnThis(),
    }),
  },
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
}));
jest.mock('expo-file-system', () => ({
  documentDirectory: '/tmp/',
  writeAsStringAsync: jest.fn(),
  EncodingType: { UTF8: 'utf8' },
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(false),
  shareAsync: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

import SettingsTab from '../../app/(tabs)/settings';

beforeEach(() => {
  jest.clearAllMocks();
  mockSignOutWithCleanup.mockResolvedValue({ error: null });
});

/** 画面の初期読み込み (設定値の取得) が終わるまで待つ。終わる前にテストが進むと act の警告が出る */
async function renderSettings() {
  const api = render(<SettingsTab />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return api;
}

describe('設定タブ — ログアウト (#1038 F7-10)', () => {
  it('確認モーダルで「ログアウト」を押すと、共通のログアウト処理にユーザー ID を渡して実行し、トップへ戻る', async () => {
    const api = await renderSettings();

    fireEvent.press(api.getByTestId('settings-logout-button'));
    fireEvent.press(await api.findByTestId('settings-logout-confirm-button'));

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/'));
    // push token の削除はサインアウトの前に行う必要がある。個別に呼ばず、順序を保証する共通処理に任せている
    expect(mockSignOutWithCleanup).toHaveBeenCalledTimes(1);
    expect(mockSignOutWithCleanup).toHaveBeenCalledWith('uid-settings');
  });

  it('共通処理が例外を投げても、トップへ戻る (ログアウト操作が固まらない)', async () => {
    mockSignOutWithCleanup.mockRejectedValue(new Error('boom'));
    const api = await renderSettings();

    fireEvent.press(api.getByTestId('settings-logout-button'));
    fireEvent.press(await api.findByTestId('settings-logout-confirm-button'));

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/'));
  });

  it('キャンセルしたときは何も実行しない', async () => {
    const api = await renderSettings();

    fireEvent.press(api.getByTestId('settings-logout-button'));
    fireEvent.press(await api.findByTestId('settings-logout-cancel-button'));

    expect(mockSignOutWithCleanup).not.toHaveBeenCalled();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });
});
