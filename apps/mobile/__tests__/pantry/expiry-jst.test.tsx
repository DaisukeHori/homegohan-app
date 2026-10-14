/**
 * 食品庫の「期限切れ」「期限間近」の判定を、日本の暦日 (画面の今日 = todayLocal) で行う (#1594)。
 *
 * 以前の判定は、期限の日付を new Date(dateStr) (その日の UTC の 0 時 = 日本の 9 時) にして今の時刻と比べていたので、
 *   - 期限が今日の食材が、期限の日の日本の 9:00 から「期限切れ」になった (期限の日のうちは「期限切れ」にしないのが正しい)
 *   - 「期限間近」(今日から 3 日後の期限まで) の境目も 9 時間ずれ、3 日後が期限の食材は日本の 9:00 まで「期限間近」にならなかった
 * 時計 (Date だけ) を日本の 0:30 と 9:30 に固定し、どちらの時刻でも同じ表示になることを確かめる (テストは TZ=UTC で流れる)。
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

const mockGet = jest.fn();

jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: mockGet,
    post: jest.fn(),
    patch: jest.fn(),
    del: jest.fn(),
  }),
}));

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import PantryPage from '../../app/pantry/index';

/**
 * 時計 (Date) を固定する時刻。どちらも日本の暦日では 2026-10-14。
 *   - JST 0:30 : UTC では前日 (10-13) の 15:30。以前の判定では、期限が今日の食材が「期限間近」、3 日後の食材が通常だった
 *   - JST 9:30 : UTC でも同じ日 (10-14) の 0:30。以前の判定では、期限が今日の食材が「期限切れ」だった
 */
const CLOCKS = [
  { label: 'JST 0:30 (UTC の前日の 15:30)', at: '2026-10-13T15:30:00.000Z' },
  { label: 'JST 9:30 (UTC の同じ日の 0:30)', at: '2026-10-14T00:30:00.000Z' },
] as const;

type ExpectedBadge = 'expired' | 'expiring' | 'none';

/**
 * 食材と、期待する表示。期限の日付は、日本の今日 (2026-10-14) から手で数えた固定値 (実装の関数で求めない)。
 * 「期限間近」の範囲は今日から 3 日後の期限まで (両端を含む)
 */
const CASES: ReadonlyArray<{ id: string; name: string; expirationDate: string; expected: ExpectedBadge }> = [
  { id: 'yesterday', name: '昨日が期限の牛乳', expirationDate: '2026-10-13', expected: 'expired' },
  { id: 'today', name: '今日が期限の豆腐', expirationDate: '2026-10-14', expected: 'expiring' },
  { id: 'threshold', name: '3日後が期限の卵', expirationDate: '2026-10-17', expected: 'expiring' },
  { id: 'after-threshold', name: '4日後が期限のチーズ', expirationDate: '2026-10-18', expected: 'none' },
];

/** Date 以外の時計の API (setTimeout・Promise の後処理など)。waitFor は本物の時計で動かす */
const REAL_TIMER_APIS = [
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
] as const;

/** Date だけを時刻 at に固定する (ほかの時計の API は本物のまま) */
function fixDateOnly(at: string): void {
  jest.useFakeTimers({ now: new Date(at), doNotFake: [...REAL_TIMER_APIS] });
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

describe.each(CLOCKS)('PantryPage — 期限の判定は日本の暦日 (#1594): $label', ({ at }) => {
  it('時計が固定されている (前提: Date.now が固定した時刻を返す)', () => {
    fixDateOnly(at);
    expect(new Date().toISOString()).toBe(at);
  });

  it('昨日 = 期限切れ / 今日・3 日後 = 期限間近 / 4 日後 = バッジなし', async () => {
    fixDateOnly(at);
    mockGet.mockResolvedValueOnce({
      items: CASES.map((c) => ({
        id: c.id,
        name: c.name,
        amount: null,
        category: 'other',
        expirationDate: c.expirationDate,
        addedAt: '2026-10-01',
      })),
    });

    render(<PantryPage />);

    await waitFor(() => {
      expect(screen.getByTestId('pantry-item-after-threshold')).toBeTruthy();
    });

    for (const c of CASES) {
      const expired = screen.queryByTestId(`pantry-expired-badge-${c.id}`);
      const expiring = screen.queryByTestId(`pantry-expiring-badge-${c.id}`);
      expect({ id: c.id, expired: expired !== null, expiring: expiring !== null }).toEqual({
        id: c.id,
        expired: c.expected === 'expired',
        expiring: c.expected === 'expiring',
      });
    }
    // バッジの文言 (期限切れ 1 件・期限間近 2 件)
    expect(screen.getAllByText('期限切れ')).toHaveLength(1);
    expect(screen.getAllByText('期限間近')).toHaveLength(2);
  });
});
