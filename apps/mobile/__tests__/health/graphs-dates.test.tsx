/**
 * graphs-dates.test.tsx
 * 健康の推移グラフ (app/health/graphs.tsx) の日付のテスト (#1049 F7-21)
 *
 * 以前は、グラフの日付を new Date().toISOString().slice(0, 10) (UTC の日付) で作っていた。
 * 健康記録の record_date は Asia/Tokyo の日付なので、JST の 0〜9 時は UTC では前日になり、
 *   - グラフの最後の日が昨日になって、今日の記録 (朝の体重など) がグラフに載らない
 *   - 取得範囲の開始日も 1 日ずれる
 * という状態だった。今は todayLocal() (Asia/Tokyo) を基準にする。
 *
 * 時計は「JST の 2026-10-08 08:30 = UTC の 2026-10-07 23:30」に固定する。
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

// ── モック ────────────────────────────────────────────────────────────────────
const mockGet = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: (...args: unknown[]) => mockGet(...args) }),
}));

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

jest.mock('react-native-svg', () => {
  const { View } = require('react-native');
  const Stub = ({ children }: { children?: React.ReactNode }) => <View>{children}</View>;
  return { __esModule: true, default: Stub, Circle: Stub, Line: Stub, Path: Stub, Polygon: Stub, Text: Stub };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import HealthGraphsPage from '../../app/health/graphs';

// ── 時計: Date だけを固定する ─────────────────────────────────────────────────────
const FROZEN_INSTANT = '2026-10-07T23:30:00Z'; // = 2026-10-08 08:30 JST

function freezeDate() {
  jest.useFakeTimers({
    now: new Date(FROZEN_INSTANT),
    doNotFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'nextTick',
      'queueMicrotask',
      'hrtime',
      'performance',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
    ],
  });
}

async function renderPage() {
  const view = render(<HealthGraphsPage />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

beforeEach(() => {
  mockGet.mockReset();
  mockGet.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/health/records')) {
      return {
        records: [
          // 今朝 (JST の今日) の体重と、1 週間前の体重
          { id: 'today', record_date: '2026-10-08', weight: 61.2 },
          { id: 'week-ago', record_date: '2026-10-01', weight: 62.0 },
        ],
      };
    }
    if (path.startsWith('/api/health/checkups')) return { checkups: [] };
    if (path.startsWith('/api/health/goals')) return { goals: [] };
    return {};
  });
  freezeDate();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('HealthGraphsPage — 日付は Asia/Tokyo の「今日」が基準', () => {
  it('(前提) 時計は UTC では前日、JST では 10/8 の時刻に固定されている', () => {
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-07');
  });

  it('JST の朝でも、今日の記録がグラフの最新値になる (昨日の日付までで切れない)', async () => {
    await renderPage();

    expect(screen.getByTestId('health-graphs-chart')).toBeTruthy();
    // 最新値は今日 (10/8) の 61.2。UTC の日付で作ると 10/7 までになり、1 週間前の 62.0 が最新値に見える
    expect(screen.getByTestId('health-graphs-latest-value')).toHaveTextContent('61.2');
  });

  it('取得範囲の開始日は、JST の今日から数える (1 か月 = 30 日前 → 2026-09-08)', async () => {
    await renderPage();

    const recordsCall = mockGet.mock.calls.map(([path]) => path as string).find((path) => path.startsWith('/api/health/records'));
    expect(recordsCall).toBe('/api/health/records?start_date=2026-09-08&limit=365');
  });

  it('期間を 1 週間にしても、開始日は JST の今日から数え (2026-10-01)、今日の記録が最新値のまま', async () => {
    await renderPage();
    mockGet.mockClear();

    await act(async () => {
      fireEvent.press(screen.getByTestId('health-graphs-period-week'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const recordsCall = mockGet.mock.calls.map(([path]) => path as string).find((path) => path.startsWith('/api/health/records'));
    expect(recordsCall).toBe('/api/health/records?start_date=2026-10-01&limit=365');
    expect(screen.getByTestId('health-graphs-latest-value')).toHaveTextContent('61.2');
  });
});
