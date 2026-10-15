/**
 * 週間献立画面: 献立のカードの番号付きの名前 (#1631)
 *
 * 同じ日・同じ区分の献立が複数あるとき、カードの名前は 1 件目が短い名前 (朝・昼・夕・おやつ・夜食)、
 * 2 件目が表示名 + 2 (朝食2)、3 件目以降が短い名前 + 番号 (朝3)。5 値以外の区分は、元の値をそのまま名前にする。
 * #1631 で、区分ごとの比較の連鎖 (mealType === "breakfast" ? "朝" : …) をやめ、MEAL_CONFIG (キーは MealType) の
 * label / shortLabel から引くようにした (#1665 で表示名は MEAL_LABELS、短い名前は src/lib/meal-type-visuals.ts の
 * MEAL_TYPE_SHORT_LABELS へ移した)。書き直しの前と同じ名前になることを、画面を実際に描画して確かめる。
 * 期待する名前は、定数から求めずに手で書く。
 */

// ============================================================
// モック (ultimate-progress-card.test.tsx と同じ形。献立の読み込みだけ献立を返す)
// ============================================================

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, testID }: any) => React.createElement(View, { testID }, children),
  };
});

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: ({ children, style, testID }: any) => React.createElement(View, { style, testID }, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('../../src/providers/ProfileProvider', () => ({
  useProfile: () => ({ profile: { weekStartDay: 'monday' } }),
}));

const mockGet = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: jest.fn() }),
  getApiBaseUrl: () => 'http://localhost:3000',
}));

jest.mock('../../src/lib/supabase', () => {
  const channel: any = {};
  channel.on = jest.fn(() => channel);
  channel.subscribe = jest.fn(() => channel);
  return {
    supabase: {
      channel: jest.fn(() => channel),
      removeChannel: jest.fn(),
      auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) },
    },
  };
});

// 名前とは関係が無い、API や画像を扱う重いモーダルは描画しない
jest.mock('../../src/components/menu/V4GenerateModal', () => ({ V4GenerateModal: () => null }));
jest.mock('../../src/components/menu/ImproveMealModal', () => ({ ImproveMealModal: () => null }));
jest.mock('../../src/components/menu/AddMealModal', () => ({ AddMealModal: () => null }));
jest.mock('../../src/components/menu/AddMealSlotModal', () => ({ AddMealSlotModal: () => null }));
jest.mock('../../src/components/menu/ConfirmDeleteModal', () => ({ ConfirmDeleteModal: () => null }));
jest.mock('../../src/components/menu/ManualEditModal', () => ({ ManualEditModal: () => null }));
jest.mock('../../src/components/menu/NutritionDetailModal', () => ({ NutritionDetailModal: () => null }));
jest.mock('../../src/components/menu/PantryModal', () => ({ PantryModal: () => null }));
jest.mock('../../src/components/menu/RecipeModal', () => ({ RecipeModal: () => null }));
jest.mock('../../src/components/menu/RegenerateMealModal', () => ({ RegenerateMealModal: () => null }));
jest.mock('../../src/components/menu/ServingsModal', () => ({ ServingsModal: () => null }));
jest.mock('../../src/components/menu/ShoppingListModal', () => ({ ShoppingListModal: () => null }));
jest.mock('../../src/components/menu/StatsModal', () => ({ StatsModal: () => null }));

// ============================================================
// imports
// ============================================================

import React from 'react';
import { act, render, waitFor, within } from '@testing-library/react-native';

import WeeklyMenuPage from '../../app/menus/weekly/index';

// ============================================================
// ヘルパー
// ============================================================

/**
 * 時計 (Date) を固定する時刻。水曜日の日本の 12:00 (UTC でも同じ日の 3:00)。
 * 画面の今日 (todayLocal = 日本の暦日) と週 (端末の暦の月曜日から) が、どのタイムゾーンで流しても同じ週に入る
 */
const FIXED_NOW = '2026-10-14T03:00:00.000Z';
const TODAY = '2026-10-14';

/** Date 以外の時計の API。画面の読み込みの待ち (waitFor) は本物の時計で動かす (v4-generate-modal-range-max.test.tsx と同じ) */
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

/** 今日の献立 (並びは displayOrder の順) と、カードに出る名前 */
const MEALS: ReadonlyArray<{ id: string; mealType: string; dishName: string; label: string }> = [
  { id: 'b1', mealType: 'breakfast', dishName: 'トーストA', label: '朝' },
  { id: 'b2', mealType: 'breakfast', dishName: 'トーストB', label: '朝食2' },
  { id: 'b3', mealType: 'breakfast', dishName: 'トーストC', label: '朝3' },
  { id: 'l1', mealType: 'lunch', dishName: 'そばA', label: '昼' },
  { id: 'l2', mealType: 'lunch', dishName: 'そばB', label: '昼食2' },
  { id: 'd1', mealType: 'dinner', dishName: '鍋A', label: '夕' },
  { id: 'd2', mealType: 'dinner', dishName: '鍋B', label: '夕食2' },
  { id: 'd3', mealType: 'dinner', dishName: '鍋C', label: '夕3' },
  { id: 's1', mealType: 'snack', dishName: 'プリンA', label: 'おやつ' },
  { id: 's2', mealType: 'snack', dishName: 'プリンB', label: 'おやつ2' },
  { id: 's3', mealType: 'snack', dishName: 'プリンC', label: 'おやつ3' },
  { id: 'n1', mealType: 'midnight_snack', dishName: 'おにぎりA', label: '夜食' },
  { id: 'n2', mealType: 'midnight_snack', dishName: 'おにぎりB', label: '夜食2' },
  { id: 'n3', mealType: 'midnight_snack', dishName: 'おにぎりC', label: '夜食3' },
  { id: 'x1', mealType: 'brunch', dishName: 'パンケーキA', label: 'brunch' },
  { id: 'x2', mealType: 'brunch', dishName: 'パンケーキB', label: 'brunch2' },
  { id: 'x3', mealType: 'brunch', dishName: 'パンケーキC', label: 'brunch3' },
];

const originalFetch = global.fetch;

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(FIXED_NOW), doNotFake: [...REAL_TIMER_APIS] });
  // 祝日の取得 (外部サイト) は行わない
  global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

  mockGet.mockReset();
  mockGet.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/ai/menu/weekly/pending')) return { hasPending: false };
    if (url.startsWith('/api/meal-plans')) {
      return {
        dailyMeals: [
          {
            id: 'day-today',
            dayDate: TODAY,
            meals: MEALS.map((m, index) => ({
              id: m.id,
              mealType: m.mealType,
              dishName: m.dishName,
              mode: 'cook',
              isCompleted: false,
              isGenerating: false,
              displayOrder: index,
            })),
          },
        ],
      };
    }
    return {};
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

// ============================================================
// テスト
// ============================================================

describe('週間献立画面: 献立のカードの番号付きの名前 (#1631)', () => {
  it('1 件目は短い名前、2 件目は表示名 + 2、3 件目以降は短い名前 + 番号。5 値以外は元の値のまま', async () => {
    const screen = render(<WeeklyMenuPage />);
    await waitFor(() => expect(screen.getByTestId(`weekly-meal-card-${MEALS[0].id}`)).toBeTruthy());
    await act(async () => {});

    const actual = MEALS.map((m) => {
      const card = screen.getByTestId(`weekly-meal-card-${m.id}`);
      return { id: m.id, hasLabel: within(card).queryByText(m.label) !== null };
    });
    expect(actual).toEqual(MEALS.map((m) => ({ id: m.id, hasLabel: true })));
  });
});
