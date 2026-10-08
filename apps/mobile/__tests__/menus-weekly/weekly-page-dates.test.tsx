/**
 * weekly-page-dates.test.tsx
 * 週間献立画面 (app/menus/weekly/index.tsx) が「今日」と「今週」を決める日付のテスト (#1049 F7-21)
 *
 * 以前は new Date() (端末のタイムゾーンの今日) から週の開始日を決めていた。
 * Web・サーバー (Asia/Tokyo) とは基準が違うので、端末が日本以外のタイムゾーンだと、
 * 同じ瞬間に WebView のタブとネイティブ画面で「今週」が違うことがあった。
 * 今は startOfTodayLocal() / todayLocal() (Asia/Tokyo) を基準にする。
 *
 * 時計は「JST の 2026-10-12 (月) 08:30 = UTC の 2026-10-11 (日) 23:30」に固定する。
 * 月曜始まりの週は、JST なら 10/12〜10/18。UTC の端末 (CI) の暦で見ると日曜日なので 10/5〜10/11 になってしまう。
 */

import React from 'react';
import { act, render } from '@testing-library/react-native';

// ── モック ────────────────────────────────────────────────────────────────────
const mockGet = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: (...args: unknown[]) => mockGet(...args),
    post: jest.fn().mockResolvedValue({}),
    patch: jest.fn().mockResolvedValue({}),
    del: jest.fn().mockResolvedValue({}),
  }),
  getApiBaseUrl: () => 'https://api.example.test',
}));

jest.mock('../../src/lib/supabase', () => {
  const channel = { on: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn() };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  return {
    supabase: {
      channel: jest.fn(() => channel),
      removeChannel: jest.fn(),
      from: jest.fn(),
      auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) },
    },
  };
});

jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({ profile: { id: 'user-1', weekStartDay: 'monday' } }),
}));

jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, session: { user: { id: 'user-1' } }, isLoading: false }),
}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

import WeeklyMenuPage from '../../app/menus/weekly/index';

// ── 時計: Date だけを固定する ─────────────────────────────────────────────────────
function freezeDate(iso: string) {
  jest.useFakeTimers({
    now: new Date(iso),
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
  const view = render(<WeeklyMenuPage />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  mockGet.mockReset();
  mockGet.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/meal-plans')) return { dailyMeals: [] };
    if (path.startsWith('/api/ai/menu/weekly/pending')) return { hasPending: false };
    return {};
  });
  // 祝日 API (holidays-jp) は空で返す
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  freezeDate('2026-10-11T23:30:00Z');
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe('WeeklyMenuPage — 今週は Asia/Tokyo の今日から決まる', () => {
  it('(前提) 時計は UTC では日曜日 (10/11)、JST では月曜日 (10/12) に固定されている', () => {
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-11');
  });

  it('最初の読み込みは、JST の今週 (月曜始まり 2026-10-12 〜 2026-10-18) の献立を取る', async () => {
    await renderPage();

    const weekCalls = mockGet.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path.startsWith('/api/meal-plans?startDate=2026-10-12&endDate=2026-10-18'));

    expect(weekCalls.length).toBeGreaterThanOrEqual(1);
    // 端末の暦 (UTC では日曜) の週 (2026-10-05 〜 2026-10-11) は、今週として読まない
    const staleWeekCalls = mockGet.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path.startsWith('/api/meal-plans?startDate=2026-10-05&endDate=2026-10-11'));
    expect(staleWeekCalls).toEqual([]);
  });

  it('進行中の生成の確認も、JST の今週の開始日 (2026-10-12) で問い合わせる', async () => {
    await renderPage();

    const pendingCalls = mockGet.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path.startsWith('/api/ai/menu/weekly/pending'));

    expect(pendingCalls).toContain('/api/ai/menu/weekly/pending?date=2026-10-12');
  });
});
