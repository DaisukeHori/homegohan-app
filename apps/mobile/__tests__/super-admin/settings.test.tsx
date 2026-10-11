/**
 * settings.test.tsx
 * 運営のシステム設定の画面 (app/(super-admin)/super-admin/settings.tsx) のテスト (#1457)
 *
 * system_settings の key='feature_flags' の行は、機能フラグの置き場が feature_flags テーブルに移って (#1148)、
 * もう何にも効いていない。サーバー (GET /api/super-admin/settings) は、こうした使われていない行に
 * read_only: true と note (説明) を付けて返し、PUT は 409 SETTING_READ_ONLY で断る。
 * 画面は、その行に「使われていない」説明を出し、選んでも保存させない。
 * 保存に失敗したときは、生の文字列 (JSON) ではなく本文の message を出す。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';

const mockGet = jest.fn();
const mockPut = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, put: mockPut, post: jest.fn(), patch: jest.fn(), del: jest.fn() }),
}));

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

import SuperAdminSettingsPage from '../../app/(super-admin)/super-admin/settings';

const RETIRED_NOTE = 'この設定は使われていません (読み取り専用)。機能フラグは運営画面の「機能フラグ」で切り替えます。';

/** src/app/api/super-admin/settings/route.ts の GET が返す形 */
const SETTINGS_RESPONSE = {
  settings: [
    { key: 'feature_flags', value: { menu_generation_v5_direct: true }, updated_at: '2026-09-01T00:00:00.000Z', read_only: true, note: RETIRED_NOTE },
    { key: 'support_email', value: 'support@example.com', updated_at: '2026-09-02T00:00:00.000Z', read_only: false, note: null },
  ],
};

const WAIT = { timeout: 5000 };
const alertSpy = Alert.alert as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue(SETTINGS_RESPONSE);
  mockPut.mockResolvedValue({ success: true });
});

async function renderPage() {
  render(<SuperAdminSettingsPage />);
  await waitFor(() => expect(screen.getByText('support_email')).toBeTruthy(), WAIT);
}

describe('システム設定の画面 — 使われていない key (#1457)', () => {
  it('使われていない key (feature_flags) の行に、サーバーの説明を出す。ほかの行には出さない', async () => {
    await renderPage();

    expect(screen.getByTestId('super-admin-settings-retired-feature_flags').props.children).toBe(RETIRED_NOTE);
    expect(screen.queryByTestId('super-admin-settings-retired-support_email')).toBeNull();
  });

  it('使われていない key を選ぶと、説明を出し、保存ボタンを押せない (PUT を呼ばない)', async () => {
    await renderPage();

    fireEvent.press(screen.getByText('feature_flags'));

    expect(screen.getByTestId('super-admin-settings-read-only-note')).toBeTruthy();
    // 一覧の行と、入力欄の下の 2 か所に出る
    expect(screen.getAllByText(RETIRED_NOTE)).toHaveLength(2);
    const save = screen.getByTestId('super-admin-settings-save');
    expect(save.props.accessibilityState?.disabled ?? save.props.disabled).toBe(true);
    await act(async () => {
      fireEvent.press(save);
    });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('使われている key は、これまでどおり保存できる', async () => {
    await renderPage();

    fireEvent.press(screen.getByText('support_email'));
    expect(screen.queryByTestId('super-admin-settings-read-only-note')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('super-admin-settings-save'));
    });

    expect(mockPut).toHaveBeenCalledWith(
      '/api/super-admin/settings',
      expect.objectContaining({ key: 'support_email', value: 'support@example.com' }),
    );
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('保存しました', '設定を更新しました。'), WAIT);
  });

  it('保存がサーバーに断られたら (409 SETTING_READ_ONLY)、生の文字列ではなく本文の message を出す', async () => {
    const message = 'この設定は使われていないため、変更できません。機能フラグは運営画面の「機能フラグ」で切り替えます。';
    mockPut.mockRejectedValue(
      new Error(`HTTP 409 Conflict: ${JSON.stringify({ error: { code: 'SETTING_READ_ONLY', message } })}`),
    );
    // 画面の一覧にまだ出ていない (読み込みのあとにできた) 使われていない key を、手で入力して保存した場合
    mockGet.mockResolvedValue({ settings: [SETTINGS_RESPONSE.settings[1]] });
    await renderPage();

    fireEvent.changeText(screen.getByPlaceholderText('key'), 'feature_flags');
    await act(async () => {
      fireEvent.press(screen.getByTestId('super-admin-settings-save'));
    });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('保存失敗', message), WAIT);
  });
});
