/**
 * export-rows.test.tsx
 * RNTL tests for apps/mobile/app/(tabs)/settings.tsx — 「データとプライバシー」の書き出しの 2 行 (#1870)
 *
 * CSV の書き出し (/api/export/meals) が返すのは献立 (planned_meals。記録した食事 = is_completed の行だけでなく、予定の献立も含む) なのに、
 * 副題と共有のダイアログの題が「食事記録」になっていた。Web の設定の「献立をCSVエクスポート」と同じく「献立」と呼ぶ。
 * JSON の書き出し (/api/account/export) は本人のデータを出すが、認証情報や運営の内部の記録は出さない
 * (src/lib/account-export-tables.ts の ACCOUNT_EXPORT_EXCLUDED) ので、「全データ」とは書かず「ご自身のデータ」と書く。
 * FAQ (src/app/faq/page.tsx の「データをエクスポートできますか？」) は、この行の名前と中身を案内している。
 *
 * 期待の文はここに直接書く (画面の定数を import すると、文を変えてもテストが一緒に変わって見張りにならない)。
 */

import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';

// ---- Mocks (profile-row.test.tsx と同じ最小限 + 書き出しの通信と共有) ----

jest.mock('expo-router', () => ({
  router: {
    replace: jest.fn(),
    push: jest.fn(),
  },
}));

jest.mock('../../src/lib/signOut', () => ({
  signOutOnDevice: jest.fn(),
}));

jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'uid-settings' }, clearSession: jest.fn() }),
}));

/** テストの API の宛先 (書き出しの URL の突き合わせに使う) */
const API_BASE_URL = 'https://api.example.test';

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
    auth: { getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'token-export' } } }) },
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

const mockWriteAsStringAsync = jest.fn();
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/tmp/',
  writeAsStringAsync: (...args: unknown[]) => mockWriteAsStringAsync(...args),
  EncodingType: { UTF8: 'utf8' },
}));

const mockShareAsync = jest.fn();
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  shareAsync: (...args: unknown[]) => mockShareAsync(...args),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

import SettingsTab from '../../app/(tabs)/settings';

/** HTTP 200 (書き出しが成功した応答) */
const HTTP_OK = 200;

const fetchMock = jest.fn();
const originalFetch = global.fetch;

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockResolvedValue({ ok: true, status: HTTP_OK, text: async () => 'exported' });
});

async function renderSettings() {
  const api = render(<SettingsTab />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return api;
}

async function pressAndSettle(api: Awaited<ReturnType<typeof renderSettings>>, testID: string) {
  await act(async () => {
    fireEvent.press(api.getByTestId(testID));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('設定タブ — 書き出しの行の文言 (#1870)', () => {
  it('CSV の行は「CSVでエクスポート」で、副題は献立の CSV と言う (食事記録とは言わない)', async () => {
    const api = await renderSettings();
    const row = within(api.getByTestId('settings-export-csv-row'));
    expect(row.getByText('CSVでエクスポート')).toBeTruthy();
    expect(row.getByText('献立を CSV 形式でダウンロード')).toBeTruthy();
    expect(row.queryByText(/食事記録/)).toBeNull();
  });

  it('CSV の行を押すと、献立の書き出し (/api/export/meals) を「献立をCSVでエクスポート」の題で共有に渡す', async () => {
    const api = await renderSettings();
    await pressAndSettle(api, 'settings-export-csv-row');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/api/export/meals`);
    expect(mockShareAsync).toHaveBeenCalledTimes(1);
    expect(mockShareAsync.mock.calls[0][1]).toEqual(
      expect.objectContaining({ mimeType: 'text/csv', dialogTitle: '献立をCSVでエクスポート' }),
    );
  });

  it('JSON の行は「JSONでエクスポート」で、副題は「ご自身のデータ」と言う (全データとは言わない)', async () => {
    const api = await renderSettings();
    const row = within(api.getByTestId('settings-export-json-row'));
    expect(row.getByText('JSONでエクスポート')).toBeTruthy();
    expect(row.getByText('ご自身のデータを JSON 形式でダウンロード')).toBeTruthy();
    expect(row.queryByText(/全データ/)).toBeNull();
  });

  it('JSON の行を押すと、本人のデータの書き出し (/api/account/export) を「JSONデータをエクスポート」の題で共有に渡す', async () => {
    const api = await renderSettings();
    await pressAndSettle(api, 'settings-export-json-row');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/api/account/export`);
    expect(mockShareAsync).toHaveBeenCalledTimes(1);
    expect(mockShareAsync.mock.calls[0][1]).toEqual(
      expect.objectContaining({ mimeType: 'application/json', dialogTitle: 'JSONデータをエクスポート' }),
    );
  });
});
