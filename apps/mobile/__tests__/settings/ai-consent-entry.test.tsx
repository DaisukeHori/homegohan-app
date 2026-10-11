/**
 * ai-consent-entry.test.tsx
 * RNTL tests for apps/mobile/app/(tabs)/settings.tsx — 「AI へのデータ提供の同意」の項目 (T15 / #1154)
 *
 * 画面を開くと自動で作る AI のコメントや、AI の分析を省いた画面は「設定の「AI へのデータ提供の同意」から同意できます」と案内する。
 * その項目が設定タブにあり、押すと同意画面 (/settings/ai-consent。Web の同じページを WebView で開く) へ移ることを確かめる。
 */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

import { AI_CONSENT_SETTINGS_ENTRY_TITLE } from '../../src/lib/ai-consent';

// 設定タブは画面が大きく、初回の描画が重い (logout.test.tsx と同じ上限)
jest.setTimeout(30_000);

// ---- Mocks ----

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    replace: jest.fn(),
    push: (...args: unknown[]) => mockRouterPush(...args),
  },
}));

jest.mock('../../src/lib/signOut', () => ({
  signOutWithCleanup: jest.fn(),
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
});

async function renderSettings() {
  const api = render(<SettingsTab />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return api;
}

describe('設定タブ — AI へのデータ提供の同意 (T15 / #1154)', () => {
  it('項目があり、案内の一文が指す名前と同じ', async () => {
    const api = await renderSettings();
    const row = api.getByTestId('settings-ai-consent-row');
    expect(row).toBeTruthy();
    expect(api.getByText(AI_CONSENT_SETTINGS_ENTRY_TITLE)).toBeTruthy();
  });

  it('押すと同意画面 (/settings/ai-consent) へ移る', async () => {
    const api = await renderSettings();
    fireEvent.press(api.getByTestId('settings-ai-consent-row'));
    expect(mockRouterPush).toHaveBeenCalledWith('/settings/ai-consent');
  });
});
