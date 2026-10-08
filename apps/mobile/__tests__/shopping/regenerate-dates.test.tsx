/**
 * regenerate-dates.test.tsx
 * 買い物リストの再生成に送る期間 (app/shopping-list/index.tsx の calculateDateRange) のテスト (#1049 F7-21)
 *
 * 以前は new Date() (端末のタイムゾーンの今日) から期間を作っていた。
 * Web・サーバー (Asia/Tokyo) とは基準が違うので、端末が日本以外のタイムゾーンだと、
 * 同じ瞬間に Web 版とアプリで、買い物リストの「今日」「明日」が違う日になった。
 * 今は todayLocal() (Asia/Tokyo) を基準にし、日付の加減算は文字列で行う。
 *
 * 時計は「JST の 2026-10-08 08:30 = UTC の 2026-10-07 23:30」に固定する。
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

// ── モック ────────────────────────────────────────────────────────────────────
const mockPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({
    get: jest.fn().mockResolvedValue({}),
    post: (...args: unknown[]) => mockPost(...args),
    patch: jest.fn().mockResolvedValue({}),
    del: jest.fn().mockResolvedValue({}),
  }),
  getApiBaseUrl: () => 'http://localhost:3000',
}));

// 買い物リストがまだ無い状態 (空の一覧 → 「献立から生成」から範囲選択へ進む)
jest.mock('../../src/lib/mealPlan', () => ({
  getActiveShoppingListId: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: jest.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
      getSession: jest.fn().mockResolvedValue({ data: { session: { access_token: 'tok' } } }),
    },
    from: jest.fn(),
    channel: jest.fn().mockReturnValue({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn().mockReturnThis(),
    }),
    removeChannel: jest.fn(),
  },
}));

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import ShoppingListPage from '../../app/shopping-list/index';

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

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 一覧が空の画面から、範囲選択 → 人数確認 → 生成 まで進めて、再生成 API に送られた本文を返す */
async function regenerateWith(selectRange?: string) {
  render(<ShoppingListPage />);
  await settle();

  fireEvent.press(screen.getByText('献立から生成'));
  await settle();
  if (selectRange) {
    fireEvent.press(screen.getByText(selectRange));
  }
  fireEvent.press(screen.getByText('次へ（人数確認）'));
  await settle();
  await act(async () => {
    fireEvent.press(screen.getByText('この設定で買い物リストを生成'));
  });
  await settle();

  expect(mockPost).toHaveBeenCalledWith('/api/shopping-list/regenerate', expect.any(Object));
  return mockPost.mock.calls[0][1] as { startDate: string; endDate: string; mealTypes: string[] };
}

beforeEach(() => {
  mockPost.mockReset();
  mockPost.mockResolvedValue({});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  freezeDate('2026-10-07T23:30:00Z');
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('買い物リストの再生成 — 期間は Asia/Tokyo の今日が基準', () => {
  it('(前提) 時計は UTC では 10/7、JST では 10/8 の時刻に固定されている', () => {
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-07');
  });

  it('既定の「1 週間」は、今日 (JST 10/8) から 7 日分 (〜10/14)', async () => {
    const body = await regenerateWith();

    expect(body.startDate).toBe('2026-10-08');
    expect(body.endDate).toBe('2026-10-14');
    expect(body.mealTypes).toEqual(['breakfast', 'lunch', 'dinner']);
  });

  it('「明日」は JST の 10/9 だけ', async () => {
    const body = await regenerateWith('明日の分');

    expect(body.startDate).toBe('2026-10-09');
    expect(body.endDate).toBe('2026-10-09');
  });
});
