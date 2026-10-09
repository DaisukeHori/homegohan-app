/**
 * comparison.test.tsx
 * 比較画面 (app/comparison/index.tsx) の再計算ボタンと更新時刻の案内 (#1406)
 *
 * 再計算 (POST /api/comparison/trigger) は全員分のランキングを作り直す重い処理で、サーバーは super_admin 以外を 403 にする。
 * 以前の画面は、誰にでも「再計算」ボタンを出していた (押しても必ず失敗した)。
 * 集計は毎日 JST 4:00 に pg_cron が走らせるので、一般の利用者にはボタンを出さず、更新時刻だけを案内する。
 * super_admin にはボタンを出し、押すと選んでいる期間の種類 (periodType) で再計算を呼ぶ。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';

const mockGet = jest.fn();
const mockPost = jest.fn();
let mockRoles: string[] = [];

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: mockPost }),
}));

jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({
    isLoading: false,
    profile: null,
    roles: mockRoles,
    hasRole: (role: string) => mockRoles.includes(role),
  }),
}));

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import ComparisonPage from '../../app/comparison';

/** src/app/api/comparison/rankings/route.ts の GET が返す形 (中身は空) */
const RANKINGS_RESPONSE = {
  rankings: [],
  highlights: [],
  userMetrics: [],
  periodType: 'weekly',
  periodStart: '2026-10-05',
  periodEnd: '2026-10-11',
};

/** @homegohan/core の createHttpClient が投げるエラーと同じ文面 */
function httpError(status: number, statusText: string, body: unknown) {
  return new Error(`HTTP ${status} ${statusText}: ${JSON.stringify(body)}`);
}

async function renderLoaded() {
  render(<ComparisonPage />);
  await waitFor(() => {
    expect(screen.getByText('期間: 2026-10-05 〜 2026-10-11')).toBeTruthy();
  });
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockGet.mockResolvedValue(RANKINGS_RESPONSE);
  (Alert.alert as jest.Mock).mockClear();
  mockRoles = [];
});

describe('比較画面 — 再計算ボタン (#1406)', () => {
  it.each([
    ['一般の利用者', ['user']],
    ['admin', ['user', 'admin']],
    ['support', ['user', 'support']],
  ])('%s には再計算ボタンを出さず、毎日の更新時刻 (JST 4:00) を案内する', async (_label, roles) => {
    mockRoles = roles;
    await renderLoaded();

    expect(screen.queryByTestId('comparison-recalculate-button')).toBeNull();
    expect(screen.getByTestId('comparison-update-schedule')).toHaveTextContent(
      'ランキングは毎日 4:00 (日本時間) に更新されます。',
    );
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('super_admin には再計算ボタンを出し、押すと選んでいる期間の種類で POST /api/comparison/trigger を呼んでから読み直す', async () => {
    mockRoles = ['user', 'super_admin'];
    mockPost.mockResolvedValue({ success: true, periodType: 'monthly' });
    await renderLoaded();
    // 期間の種類を「月」に切り替える (ランキングを読み直す)
    fireEvent.press(screen.getByTestId('comparison-period-monthly'));
    await waitFor(() => {
      expect(mockGet).toHaveBeenLastCalledWith('/api/comparison/rankings?periodType=monthly');
    });
    const readsBefore = mockGet.mock.calls.length;

    fireEvent.press(screen.getByTestId('comparison-recalculate-button'));

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledTimes(readsBefore + 1);
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('/api/comparison/trigger', { periodType: 'monthly' });
    expect(screen.getByTestId('comparison-update-schedule')).toBeTruthy();
  });

  it('再計算に失敗したら、サーバーの message だけを出す (本文の JSON をそのまま出さない)', async () => {
    mockRoles = ['user', 'super_admin'];
    mockPost.mockRejectedValue(
      httpError(500, 'Internal Server Error', { error: { code: 'INTERNAL_ERROR', message: '処理中にエラーが発生しました' } }),
    );
    await renderLoaded();

    fireEvent.press(screen.getByTestId('comparison-recalculate-button'));

    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalledWith('実行失敗', '処理中にエラーが発生しました');
    });
  });
});
