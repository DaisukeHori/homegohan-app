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
 *
 * 「献立を改善」(handleImprove) の過去の日付の判定 (#1138) も、同じ「今日」で行う。
 * 端末のタイムゾーンの今日 (formatLocalDate(new Date())) を渡していた時期があり、UTC の端末では
 * JST の昨日 (10/11) が「今日」になって、過去の日を改善できてしまった。
 */

import React from 'react';
import { act, render } from '@testing-library/react-native';

// ── モック ────────────────────────────────────────────────────────────────────
const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
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
import { ImproveMealModal } from '../../src/components/menu/ImproveMealModal';
import { ImproveMealRejectedError, type ImproveMealRequest } from '../../src/lib/improve-meal';

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
  mockPost.mockReset();
  mockPost.mockImplementation(async (path: string) =>
    path === '/api/ai/menu/v4/generate' ? { requestId: 'req-improve-1', totalSlots: 1 } : {},
  );
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

describe('WeeklyMenuPage — 「献立を改善」の過去の日付の判定は Asia/Tokyo の今日', () => {
  const improveRequest = (overrides: Partial<ImproveMealRequest>): ImproveMealRequest => ({
    date: '2026-10-12',
    mealTypes: ['dinner'],
    nextDay: false,
    ...overrides,
  });

  const generateCalls = () =>
    mockPost.mock.calls.filter(([path]) => path === '/api/ai/menu/v4/generate') as Array<[string, any]>;

  async function submitImprove(request: ImproveMealRequest) {
    const view = await renderPage();
    const { onSubmit } = view.UNSAFE_getByType(ImproveMealModal).props as {
      onSubmit: (request: ImproveMealRequest) => Promise<void>;
    };
    let error: unknown = null;
    await act(async () => {
      try {
        await onSubmit(request);
      } catch (e) {
        error = e;
      }
    });
    return error;
  }

  it('端末の暦 (UTC) の今日 = JST の昨日 (2026-10-11) は過去の日付なので、生成を始めない', async () => {
    const error = await submitImprove(improveRequest({ date: '2026-10-11' }));

    expect(error).toBeInstanceOf(ImproveMealRejectedError);
    expect((error as Error).message).toContain('2026-10-11は過去の日付のため改善できません');
    expect(generateCalls()).toEqual([]);
  });

  it('JST の今日 (2026-10-12) は改善できる (端末の暦では翌日でも、拒否されない)', async () => {
    const error = await submitImprove(improveRequest({ date: '2026-10-12' }));

    expect(error).toBeNull();
    expect(generateCalls()).toHaveLength(1);
    expect(generateCalls()[0][1].targetSlots).toEqual([{ date: '2026-10-12', mealType: 'dinner' }]);
    expect(generateCalls()[0][1].resolveExistingMeals).toBe(true);
  });

  it('JST の昨日を選んで「翌日を改善」にすると、対象は JST の今日 (2026-10-12) になり、改善できる', async () => {
    const error = await submitImprove(improveRequest({ date: '2026-10-11', nextDay: true }));

    expect(error).toBeNull();
    expect(generateCalls()).toHaveLength(1);
    expect(generateCalls()[0][1].targetSlots).toEqual([{ date: '2026-10-12', mealType: 'dinner' }]);
  });

  it('JST の一昨日 (2026-10-10) を選んで「翌日を改善」にしても、対象 (JST の昨日) は過去なので改善できない', async () => {
    const error = await submitImprove(improveRequest({ date: '2026-10-10', nextDay: true }));

    expect(error).toBeInstanceOf(ImproveMealRejectedError);
    expect((error as Error).message).toContain('2026-10-11は過去の日付のため改善できません');
    expect(generateCalls()).toEqual([]);
  });
});
