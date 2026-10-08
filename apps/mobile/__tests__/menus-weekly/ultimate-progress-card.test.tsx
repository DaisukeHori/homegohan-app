/**
 * 週間献立画面: 進捗カードの種類 (通常 / 究極モード) は、生成を頼んだ入り口に合わせて決まる (#1142)
 *
 * 週間献立画面 (app/menus/weekly/index.tsx) は、同じ v4 生成 (useV4MenuGeneration) を 2 つの入り口から呼ぶ。
 *   - AI アシスタント (handleV4Generate): 究極モードを選べる
 *   - 「献立を改善」(handleImprove → submitImprove): 常に通常モード (ultimateMode: false) で送る
 * 進捗カードの種類は、生成が始まった時 (onGenerationStart) に「今回は究極モードで頼んだか」の記録
 * (requestedUltimateRef) を読んで決める。この記録が使い終わったあとも残ると、
 * 究極モードで一度生成したあとの「献立を改善」(実際は通常の 3 段階で動く) まで、
 * 究極モードのフェーズ一覧と「究極モードで献立を生成中...」の表示になってしまう。
 * 究極モードの生成が失敗した場合も同じ。
 *
 * 画面を実際に描画し、AI アシスタントと改善モーダルの代わりに、画面が渡す onGenerate / onSubmit を
 * 直接呼んで確かめる (画面の中の本物の handleV4Generate / handleImprove / useV4MenuGeneration を通る)。
 * 見る場所は利用者に見える進捗カードの表示。
 */

// ============================================================
// モック
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

// API。画面の読み込み・進捗の問い合わせ・v4 生成の依頼は、テストごとに返す値を決める
const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: mockPost }),
  getApiBaseUrl: () => 'http://localhost:3000',
}));

// Realtime の購読 (channel().on().subscribe())。生成の完了は、購読に渡された関数を呼んで再現する
let mockRealtimeHandler: ((payload: unknown) => Promise<void>) | null = null;
jest.mock('../../src/lib/supabase', () => {
  const channel: any = {};
  channel.on = jest.fn((_type: unknown, _filter: unknown, handler: (payload: unknown) => Promise<void>) => {
    mockRealtimeHandler = handler;
    return channel;
  });
  channel.subscribe = jest.fn(() => channel);
  return {
    supabase: {
      channel: jest.fn(() => channel),
      removeChannel: jest.fn(),
      auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) },
    },
  };
});

// 画面が渡す props をそのまま受け取るための差し替え (AI アシスタント / 献立を改善)
const mockV4ModalProps: { current: any } = { current: null };
jest.mock('../../src/components/menu/V4GenerateModal', () => ({
  V4GenerateModal: (props: unknown) => {
    mockV4ModalProps.current = props;
    return null;
  },
}));

const mockImproveModalProps: { current: any } = { current: null };
jest.mock('../../src/components/menu/ImproveMealModal', () => ({
  ImproveMealModal: (props: unknown) => {
    mockImproveModalProps.current = props;
    return null;
  },
}));

// 進捗カードの種類とは関係が無い、API や画像を扱う重いモーダルは描画しない
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
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import WeeklyMenuPage from '../../app/menus/weekly/index';

// 画面全体の最初の描画は読み込むモジュールが多く、キャッシュの無い CI や負荷の高い環境では 5 秒の既定を超えることがある
jest.setTimeout(30000);

// ============================================================
// ヘルパー
// ============================================================

const ULTIMATE_MESSAGE = '究極モードで献立を生成中...';
const NORMAL_MESSAGE = 'AIが献立を生成中...';
/** 究極モードのフェーズ一覧にだけある手順 (通常モードの一覧には無い) */
const ULTIMATE_ONLY_PHASE = 'progress-todo-phase-improving';

const originalFetch = global.fetch;
let requestCount = 0;

beforeEach(() => {
  requestCount = 0;
  mockRealtimeHandler = null;
  mockV4ModalProps.current = null;
  mockImproveModalProps.current = null;

  // 祝日の取得 (外部サイト) は行わない
  global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

  mockGet.mockReset();
  mockGet.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/ai/menu/weekly/pending')) return { hasPending: false };
    if (url.startsWith('/api/ai/menu/weekly/status')) return { status: 'processing', progress: null };
    if (url.startsWith('/api/meal-plans')) return { dailyMeals: [] };
    return {};
  });

  mockPost.mockReset();
  mockPost.mockImplementation(async (_url: string, body: { targetSlots: unknown[] }) => {
    requestCount += 1;
    return { requestId: `req-${requestCount}`, totalSlots: body.targetSlots.length };
  });
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** YYYY-MM-DD (端末の今日から days 日後)。改善は過去の日付を受け付けないので、明日以降を使う */
function localDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function renderPage() {
  const utils = render(<WeeklyMenuPage />);
  // 画面を開いたときの読み込み (献立・生成中の確認) が終わるまで待つ
  await waitFor(() =>
    expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('/api/ai/menu/weekly/pending')),
  );
  await act(async () => {});
  return utils;
}

/** AI アシスタントの「献立を生成」を押したときに画面へ渡る内容 */
function generateParams(ultimateMode: boolean) {
  return {
    targetSlots: [{ date: localDate(1), mealType: 'dinner' }],
    resolveExistingMeals: false,
    constraints: {},
    note: '',
    ultimateMode,
  };
}

/** 献立を改善モーダルで「改善する」を押したときに画面へ渡る内容 */
function improveRequest() {
  return { date: localDate(1), mealTypes: ['dinner'], nextDay: false, advice: null };
}

async function generateFromAssistant(ultimateMode: boolean) {
  await act(async () => {
    await mockV4ModalProps.current.onGenerate(generateParams(ultimateMode));
  });
}

async function improve() {
  await act(async () => {
    await mockImproveModalProps.current.onSubmit(improveRequest());
  });
}

/** Realtime で「生成が完了した」通知が届いたことにする */
async function completeGeneration() {
  expect(mockRealtimeHandler).not.toBeNull();
  await act(async () => {
    await mockRealtimeHandler!({ new: { status: 'completed', progress: null } });
  });
}

function expectProgressCard(screen: ReturnType<typeof render>, kind: 'normal' | 'ultimate') {
  expect(screen.getByTestId('weekly-generating-indicator')).toBeTruthy();
  expect(screen.getByTestId('progress-todo-card')).toBeTruthy();
  if (kind === 'ultimate') {
    expect(screen.getByText(ULTIMATE_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(NORMAL_MESSAGE)).toBeNull();
    expect(screen.queryByTestId(ULTIMATE_ONLY_PHASE)).not.toBeNull();
  } else {
    expect(screen.getByText(NORMAL_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(ULTIMATE_MESSAGE)).toBeNull();
    expect(screen.queryByTestId(ULTIMATE_ONLY_PHASE)).toBeNull();
  }
}

// ============================================================
// テスト
// ============================================================

describe('週間献立画面: 進捗カードの種類 (#1142)', () => {
  it('AI アシスタントで究極モードを頼むと、究極モードの進捗カードになる (v4 生成に ultimateMode: true を送る)', async () => {
    const screen = await renderPage();

    await generateFromAssistant(true);

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith(
      '/api/ai/menu/v4/generate',
      expect.objectContaining({ ultimateMode: true }),
    );
    expectProgressCard(screen, 'ultimate');
  });

  it('AI アシスタントで究極モードを頼まなければ、通常の進捗カードになる', async () => {
    const screen = await renderPage();

    await generateFromAssistant(false);

    expect(mockPost).toHaveBeenCalledWith(
      '/api/ai/menu/v4/generate',
      expect.objectContaining({ ultimateMode: false }),
    );
    expectProgressCard(screen, 'normal');
  });

  it('究極モードで生成して完了したあとの「献立を改善」は、通常の進捗カードになる', async () => {
    const screen = await renderPage();

    await generateFromAssistant(true);
    expectProgressCard(screen, 'ultimate');
    await completeGeneration();
    expect(screen.queryByTestId('weekly-generating-indicator')).toBeNull();

    await improve();

    // 改善は常に通常モードで送る (resolveExistingMeals: true で既存の献立を差し替える)
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost).toHaveBeenLastCalledWith(
      '/api/ai/menu/v4/generate',
      expect.objectContaining({ ultimateMode: false, resolveExistingMeals: true }),
    );
    expectProgressCard(screen, 'normal');
  });

  it('究極モードの生成が失敗したあとの「献立を改善」も、通常の進捗カードになる', async () => {
    const screen = await renderPage();
    mockPost.mockRejectedValueOnce(new Error('HTTP 500 Internal Server Error'));

    // 失敗は呼び出し元 (AI アシスタント) に例外で返り、画面にはエラーが出る
    await act(async () => {
      await expect(mockV4ModalProps.current.onGenerate(generateParams(true))).rejects.toThrow('HTTP 500');
    });
    expect(screen.getByTestId('weekly-error-banner')).toBeTruthy();
    expect(screen.queryByTestId('weekly-generating-indicator')).toBeNull();

    // エラー表示を閉じて (再読み込み)、改善する
    fireEvent.press(screen.getByText('再読み込み'));
    await waitFor(() => expect(screen.queryByTestId('weekly-error-banner')).toBeNull());
    await improve();

    expect(mockPost).toHaveBeenLastCalledWith(
      '/api/ai/menu/v4/generate',
      expect.objectContaining({ ultimateMode: false, resolveExistingMeals: true }),
    );
    expectProgressCard(screen, 'normal');
  });

  it('改善のあとにもう一度 AI アシスタントで究極モードを頼むと、また究極モードの進捗カードになる', async () => {
    const screen = await renderPage();

    await generateFromAssistant(true);
    await completeGeneration();
    await improve();
    expectProgressCard(screen, 'normal');
    await completeGeneration();

    await generateFromAssistant(true);

    expectProgressCard(screen, 'ultimate');
  });
});
