/**
 * profile-row.test.tsx
 * RNTL tests for apps/mobile/app/(tabs)/settings.tsx — 「プロフィール」の行 (#1598)
 *
 * 以前は router.push("/profile") で、同じパスのネイティブのプロフィール画面 (app/profile/index.tsx。いまは消した) が、
 * マイページのタブ (app/(tabs)/profile.tsx。Web のマイページを WebView で開く) より先に当たっていた
 * (expo-router は index の画面を同じパスの画面より先に当てる)。その画面は、通常の操作で届かない
 * ネイティブの画面として消し、WebView の画面に一本化した。この行はマイページのタブのルートを名指しして開く。
 */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import fs from 'fs';
import path from 'path';

// ---- Mocks (ai-consent-entry.test.tsx と同じ最小限) ----

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

const APP_DIR = path.resolve(__dirname, '../../app');
/** マイページのタブのルート (app/(tabs)/profile.tsx) */
const PROFILE_TAB_ROUTE = '/(tabs)/profile';

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

describe('設定タブ — プロフィールの行 (#1598)', () => {
  it('押すと、マイページのタブ (/(tabs)/profile。WebView) を開く', async () => {
    const api = await renderSettings();
    fireEvent.press(api.getByTestId('settings-profile-row'));
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith(PROFILE_TAB_ROUTE);
  });

  it('行き先のタブの画面は実在し、同じパス /profile のネイティブの画面 (app/profile/index.tsx。消した) は無い', () => {
    expect(fs.existsSync(path.join(APP_DIR, '(tabs)', 'profile.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(APP_DIR, 'profile', 'index.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(APP_DIR, 'profile.tsx'))).toBe(false);
  });
});
