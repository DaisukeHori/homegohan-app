/**
 * plan-entry.test.tsx
 * 設定タブ (apps/mobile/app/(tabs)/settings.tsx) の「プランとお支払い」の行 (billing/03 §8.10・§10.6。テスト 53)。
 *
 *  1. 行を押すと、購入の画面 (PLAN_SCREEN_PATH = /settings/plan) を開く
 *  2. 経路に当たる画面のファイル app/settings/plan.tsx が実在する (押しても Unmatched Route にならない)
 *  3. 行は「個人情報」の節の最後 (栄養目標の行の下)
 */

import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import fs from 'fs';
import path from 'path';

// ---- Mocks (profile-row.test.tsx と同じ最小限) ----

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
import { PLAN_SCREEN_PATH } from '../../src/lib/plan-screen';

const APP_DIR = path.resolve(__dirname, '../../app');

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

describe('設定タブ — プランとお支払いの行 (billing/03 §10.6)', () => {
  it('settings tab has the プランとお支払い row that opens /settings/plan', async () => {
    const api = await renderSettings();
    const row = api.getByTestId('settings-plan-row');
    expect(within(row).getByText('プランとお支払い')).toBeTruthy();
    expect(within(row).getByText('有料プランの購入・復元・購読の管理')).toBeTruthy();

    fireEvent.press(row);
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith(PLAN_SCREEN_PATH);
    expect(PLAN_SCREEN_PATH).toBe('/settings/plan');
    expect(fs.existsSync(path.join(APP_DIR, `${PLAN_SCREEN_PATH}.tsx`))).toBe(true);
  });

  it('行は「個人情報」の節の最後 (栄養目標の行の下) にある', () => {
    const source = fs.readFileSync(path.join(APP_DIR, '(tabs)', 'settings.tsx'), 'utf8');
    const section = source.slice(source.indexOf('{/* ── 個人情報 ── */}'), source.indexOf('{/* ── データとプライバシー ── */}'));
    const nutrition = section.indexOf('testID="settings-nutrition-targets-row"');
    const plan = section.indexOf('testID="settings-plan-row"');
    expect(nutrition).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(nutrition);
    // 最後の行だけが last (区切り線を引かない)
    expect(section.match(/^\s*last\s*$/gm)).toHaveLength(1);
    expect(section.indexOf('last', plan)).toBeGreaterThan(plan);
  });
});
