/**
 * sessions-entry.test.tsx
 * RNTL tests for apps/mobile/app/(tabs)/settings.tsx — 「ログイン中の端末」の項目 (#1189。docs/design/cross/16-auth-history-sessions.md §16・§20.4)
 *
 * 設定タブの「アカウント」に項目があり、押すとログイン中の端末の画面 (/settings/sessions) へ移ることを確かめる。
 * mock の形は ai-consent-entry.test.tsx と同じ。
 */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

// ---- Mocks ----

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    replace: jest.fn(),
    push: (...args: unknown[]) => mockRouterPush(...args),
  },
}));

jest.mock('../../src/lib/signOut', () => ({
  signOutOnDevice: jest.fn(),
}));

jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'uid-settings' }, clearSession: jest.fn() }),
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
jest.mock('expo-file-system/legacy', () => ({
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
});

async function renderSettings() {
  const api = render(<SettingsTab />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return api;
}

describe('設定タブ — ログイン中の端末 (#1189)', () => {
  it('アカウントに testID="settings-sessions-row" の行があり、押すと /settings/sessions へ router.push する', async () => {
    const api = await renderSettings();
    const row = api.getByTestId('settings-sessions-row');
    expect(row).toBeTruthy();
    expect(api.getByText('ログイン中の端末')).toBeTruthy();

    fireEvent.press(row);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith('/settings/sessions');
  });
});
