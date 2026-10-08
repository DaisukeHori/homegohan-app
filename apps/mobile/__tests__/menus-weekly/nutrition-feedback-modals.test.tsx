/**
 * #1221: 栄養分析モーダル 2 種 (NutritionDetailModal / StatsModal) の AI 栄養フィードバック待ちの回帰テスト
 *
 * 旧実装の問題:
 *  - 本番に存在しない `ai_nutrition_feedback` テーブルを Realtime 購読 / 5 秒ポーリングしており、
 *    イベントは永久に届かず、StatsModal の「今日」タブを開いている間は 5 秒ごとに失敗クエリが走っていた
 *  - 実際にサーバーが読み書きするのは `nutrition_feedback_cache` (cacheId で 1 行を特定できる)
 *
 * 修正後は POST の応答で得た cacheId を `nutrition_feedback_cache` の UPDATE (filter: id=eq.<cacheId>) で購読し、
 * GET /api/ai/nutrition/feedback?cacheId= のポーリングを保険として併用する。
 * どの終わり方 (完了 / 失敗 / モーダルを閉じる / アンマウント) でも購読とポーリングは必ず解除される。
 */

// ============================================================
// モック
// ============================================================

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

// 重い / ネイティブ依存の子コンポーネントは描画しない (フィードバック表示とは無関係)
jest.mock('../../src/components/menu/RadarChart', () => ({ RadarChart: () => null }));
jest.mock('../../src/components/menu/RadarKeyPicker', () => ({ RadarKeyPicker: () => null }));
jest.mock('../../src/components/menu/DriBar', () => ({ DriBar: () => null }));
jest.mock('../../src/components/menu/BarChart', () => ({ BarChart: () => null }));
jest.mock('../../src/components/menu/ImproveMealModal', () => ({ ImproveMealModal: () => null }));

// 旧 NutritionDetailModal は useAuth() でユーザー ID を取っていた (修正後は不要)。
// 旧実装に対してもこのテストを動かし、失敗することを確かめられるように残している。
jest.mock('../../src/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, session: null, isLoading: false }),
}));

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet, post: mockPost }),
}));

// --- 偽 Supabase (Realtime) ---
type PostgresChangesFilter = {
  event: string;
  schema: string;
  table: string;
  filter?: string;
};
type RealtimeHandler = (payload: { new: Record<string, unknown> }) => void;

interface FakeChannel {
  name: string;
  registrations: Array<{ type: string; filter: PostgresChangesFilter; handler: RealtimeHandler }>;
  removed: boolean;
  on: (type: string, filter: PostgresChangesFilter, handler: RealtimeHandler) => FakeChannel;
  subscribe: (cb?: (status: string) => void) => FakeChannel;
}

const mockChannels: FakeChannel[] = [];
const mockChannel = jest.fn((name: string): FakeChannel => {
  const channel: FakeChannel = {
    name,
    registrations: [],
    removed: false,
    on: (type, filter, handler) => {
      channel.registrations.push({ type, filter, handler });
      return channel;
    },
    subscribe: (cb) => {
      cb?.('SUBSCRIBED');
      return channel;
    },
  };
  mockChannels.push(channel);
  return channel;
});
const mockRemoveChannel = jest.fn(async (channel: FakeChannel) => {
  channel.removed = true;
  return 'ok';
});

// テーブルを直接読みに行くクエリ。旧実装は存在しない ai_nutrition_feedback を 5 秒ごとに読みに行っていた。
// 本番と同じく「テーブルが無い」エラーを返す (旧実装はこれを握り潰す)。
const mockFrom = jest.fn((table: string) => {
  const result = { data: null, error: { message: `relation "public.${table}" does not exist` } };
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'single']) {
    chain[method] = () => chain;
  }
  chain.then = (onFulfilled: (r: typeof result) => unknown) => Promise.resolve(onFulfilled(result));
  return chain;
});

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: (name: string) => mockChannel(name),
    removeChannel: (channel: FakeChannel) => mockRemoveChannel(channel),
    from: (table: string) => mockFrom(table),
    auth: { getSession: jest.fn().mockResolvedValue({ data: { session: null } }) },
  },
}));

// ============================================================
// imports (モック設定後)
// ============================================================

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';

import { NutritionDetailModal } from '../../src/components/menu/NutritionDetailModal';
import {
  StatsModal,
  type NutrientValues,
  type StatsModalProps,
  type WeekNutrientData,
} from '../../src/components/menu/StatsModal';

// ============================================================
// ヘルパー
// ============================================================

const CACHE_ID = 'cache-1';
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 20;
const POLL_URL = `/api/ai/nutrition/feedback?cacheId=${CACHE_ID}`;

const GENERATING = { feedback: null, cached: false, status: 'generating', cacheId: CACHE_ID };

/** サーバーが completed の行に保存する feedback 列 (JSON 文字列) */
const completedFeedbackColumn = (overrides: Record<string, string> = {}) =>
  JSON.stringify({
    praiseComment: 'たんぱく質がしっかり摂れています✨',
    advice: '夕食に小松菜の炒め物を足しましょう',
    nutritionTip: 'カルシウムは小魚にも多い',
    ...overrides,
  });

/** GET /api/ai/nutrition/feedback?cacheId= の completed 応答 */
const completedGetResponse = () => ({
  praiseComment: 'ポーリングで届いた褒めコメント',
  advice: 'ポーリングで届いたアドバイス',
  nutritionTip: 'ポーリングで届いた豆知識',
  feedback: 'ポーリングで届いたアドバイス',
  status: 'completed',
  cacheId: CACHE_ID,
});

const GET_GENERATING = { feedback: null, praiseComment: null, advice: null, nutritionTip: null, status: 'generating', cacheId: CACHE_ID };

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** nutrition_feedback_cache を購読しているチャンネル */
const cacheChannels = () =>
  mockChannels.filter((c) => c.registrations.some((r) => r.filter.table === 'nutrition_feedback_cache'));

/** 全チャンネルの購読登録 (どのテーブルを見ているか) */
const subscribedTables = () =>
  mockChannels.flatMap((c) => c.registrations.map((r) => r.filter.table));

const pollCalls = () => mockGet.mock.calls.filter(([url]) => url === POLL_URL);

/** Realtime の UPDATE イベントを流す */
async function emitRealtimeUpdate(channel: FakeChannel, record: Record<string, unknown>) {
  await act(async () => {
    channel.registrations[0].handler({ new: record });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockChannels.length = 0;
  mockPost.mockReset();
  mockGet.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ============================================================
// NutritionDetailModal
// ============================================================

describe('NutritionDetailModal: AI 栄養フィードバックの待ち受け (#1221)', () => {
  const totals = { caloriesKcal: 1800, proteinG: 70 };
  const baseProps = {
    visible: true,
    onClose: jest.fn(),
    date: '2026-10-08',
    dateLabel: '10/8',
    totals,
    mealCount: 3,
    radarKeys: ['caloriesKcal'],
    onRadarKeysSaved: jest.fn(),
    // 「献立を改善」の確定処理 (#1138)。このテストは改善を使わない (ImproveMealModal は描画しない) が、必須の props
    onImprove: jest.fn().mockResolvedValue(undefined),
  };

  it('生成中なら、実在する nutrition_feedback_cache を cacheId で購読する (存在しない ai_nutrition_feedback は見ない)', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    render(<NutritionDetailModal {...baseProps} />);
    await flushPromises();

    const channels = cacheChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0].registrations).toHaveLength(1);
    expect(channels[0].registrations[0]).toMatchObject({
      type: 'postgres_changes',
      filter: {
        event: 'UPDATE',
        schema: 'public',
        table: 'nutrition_feedback_cache',
        filter: `id=eq.${CACHE_ID}`,
      },
    });
    expect(subscribedTables()).not.toContain('ai_nutrition_feedback');
  });

  it('Realtime で completed の UPDATE が届くと、褒めコメント・アドバイス・豆知識を表示して購読を外す', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    render(<NutritionDetailModal {...baseProps} />);
    await flushPromises();

    const [channel] = cacheChannels();
    expect(channel).toBeDefined();
    await emitRealtimeUpdate(channel, { status: 'completed', feedback: completedFeedbackColumn() });

    expect(screen.getByText('たんぱく質がしっかり摂れています✨')).toBeTruthy();
    expect(screen.getByText('夕食に小松菜の炒め物を足しましょう')).toBeTruthy();
    expect(screen.getByText('カルシウムは小魚にも多い')).toBeTruthy();
    expect(screen.queryByText('あなたの献立を分析中...')).toBeNull();
    expect(channel.removed).toBe(true);

    // 結果が届いたあとはポーリングも止まる
    const callsAfterResolve = pollCalls().length;
    await advance(POLL_INTERVAL_MS * 5);
    expect(pollCalls()).toHaveLength(callsAfterResolve);
  });

  it('Realtime が届かなくても、cacheId のポーリングで completed を取得できる', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    render(<NutritionDetailModal {...baseProps} />);
    await flushPromises();
    expect(screen.getByText('あなたの献立を分析中...')).toBeTruthy();

    mockGet.mockResolvedValue(completedGetResponse());
    await advance(POLL_INTERVAL_MS);

    expect(mockGet).toHaveBeenCalledWith(POLL_URL);
    expect(screen.getByText('ポーリングで届いた褒めコメント')).toBeTruthy();
    expect(screen.getByText('ポーリングで届いたアドバイス')).toBeTruthy();
    expect(screen.getByText('ポーリングで届いた豆知識')).toBeTruthy();
    // 完了したら購読も外れる
    expect(cacheChannels().every((c) => c.removed)).toBe(true);
  });

  it('POST の応答が返った時点で既に生成が終わっていても (サーバーは完了後に応答する)、次のポーリングを待たず表示する', async () => {
    mockPost.mockResolvedValue(GENERATING);
    // 最初の確認で既に completed
    mockGet.mockResolvedValue(completedGetResponse());

    render(<NutritionDetailModal {...baseProps} />);
    await flushPromises();

    expect(screen.getByText('ポーリングで届いた褒めコメント')).toBeTruthy();
    expect(screen.queryByText('あなたの献立を分析中...')).toBeNull();
  });

  it('生成が失敗した (status=error) 場合は、スピナーを止めてメッセージと再分析ボタンを出す', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    render(<NutritionDetailModal {...baseProps} />);
    await flushPromises();

    const [channel] = cacheChannels();
    expect(channel).toBeDefined();
    await emitRealtimeUpdate(channel, {
      status: 'error',
      feedback: JSON.stringify({
        praiseComment: '',
        advice: '分析中にエラーが発生しました。再分析をお試しください。',
        nutritionTip: '',
      }),
    });

    expect(screen.queryByText('あなたの献立を分析中...')).toBeNull();
    expect(screen.getByText('分析中にエラーが発生しました。再分析をお試しください。')).toBeTruthy();
    expect(screen.getByText('再分析')).toBeTruthy();
    expect(channel.removed).toBe(true);
  });

  it('40 秒待っても終わらなければ、スピナーを止めてタイムアウトのメッセージと再分析ボタンを出す', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    render(<NutritionDetailModal {...baseProps} />);
    await flushPromises();
    expect(screen.getByText('あなたの献立を分析中...')).toBeTruthy();

    await advance(POLL_INTERVAL_MS * (MAX_POLLS + 1));

    expect(screen.queryByText('あなたの献立を分析中...')).toBeNull();
    expect(screen.getByText('分析がタイムアウトしました。再分析をお試しください。')).toBeTruthy();
    expect(screen.getByText('再分析')).toBeTruthy();
    expect(cacheChannels().every((c) => c.removed)).toBe(true);

    // 諦めたあとは叩かない
    const callsAfterTimeout = pollCalls().length;
    await advance(POLL_INTERVAL_MS * 10);
    expect(pollCalls()).toHaveLength(callsAfterTimeout);
  });

  it('再分析ボタンで forceRefresh の POST を送り、新しい cacheId の結果を待つ', async () => {
    mockPost.mockResolvedValueOnce({
      ...completedGetResponse(),
      cached: true,
    });
    render(<NutritionDetailModal {...baseProps} />);
    await flushPromises();
    expect(screen.getByText('ポーリングで届いた褒めコメント')).toBeTruthy();

    mockPost.mockResolvedValueOnce({ ...GENERATING, cacheId: 'cache-2' });
    mockGet.mockResolvedValue({ ...GET_GENERATING, cacheId: 'cache-2' });
    await act(async () => {
      fireEvent.press(screen.getByText('再分析'));
    });
    await flushPromises();

    expect(mockPost).toHaveBeenLastCalledWith(
      '/api/ai/nutrition/feedback',
      expect.objectContaining({ forceRefresh: true, date: '2026-10-08' }),
    );
    const channels = cacheChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0].registrations[0].filter.filter).toBe('id=eq.cache-2');
  });

  it('生成を待っている間にモーダルを閉じると、購読もポーリングも止まる', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    const { rerender } = render(<NutritionDetailModal {...baseProps} />);
    await flushPromises();
    const [channel] = cacheChannels();
    expect(channel).toBeDefined();
    expect(channel.removed).toBe(false);

    rerender(<NutritionDetailModal {...baseProps} visible={false} />);
    await flushPromises();
    expect(channel.removed).toBe(true);

    const callsAtClose = mockGet.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 30);
    expect(mockGet.mock.calls.length).toBe(callsAtClose);
  });

  it('生成を待っている間にアンマウントされても、購読もポーリングも止まる', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    const { unmount } = render(<NutritionDetailModal {...baseProps} />);
    await flushPromises();
    const [channel] = cacheChannels();
    expect(channel).toBeDefined();

    unmount();
    expect(channel.removed).toBe(true);

    const callsAtUnmount = mockGet.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 30);
    expect(mockGet.mock.calls.length).toBe(callsAtUnmount);
  });

  it('POST の応答を待つ間にモーダルを閉じたら、遅れて届いた応答で購読もポーリングも始めない', async () => {
    let resolvePost: (value: unknown) => void = () => {};
    mockPost.mockReturnValue(new Promise((resolve) => { resolvePost = resolve; }));
    mockGet.mockResolvedValue(GET_GENERATING);

    const { rerender } = render(<NutritionDetailModal {...baseProps} />);
    await flushPromises();

    rerender(<NutritionDetailModal {...baseProps} visible={false} />);
    await flushPromises();

    resolvePost(GENERATING);
    await flushPromises();
    await advance(POLL_INTERVAL_MS * 5);

    expect(cacheChannels()).toHaveLength(0);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('日付が変わったら前の日の待ち受けを止め、新しい日の cacheId で待ち直す', async () => {
    mockPost.mockResolvedValueOnce(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    const { rerender } = render(<NutritionDetailModal {...baseProps} />);
    await flushPromises();
    const [first] = cacheChannels();
    expect(first).toBeDefined();

    mockPost.mockResolvedValueOnce({ ...GENERATING, cacheId: 'cache-9' });
    rerender(<NutritionDetailModal {...baseProps} date="2026-10-09" dateLabel="10/9" />);
    await flushPromises();

    expect(first.removed).toBe(true);
    const active = cacheChannels().filter((c) => !c.removed);
    expect(active).toHaveLength(1);
    expect(active[0].registrations[0].filter.filter).toBe('id=eq.cache-9');
  });

  it('食事が 0 件なら API も購読も使わない', async () => {
    render(<NutritionDetailModal {...baseProps} mealCount={0} />);
    await flushPromises();
    await advance(POLL_INTERVAL_MS * 3);

    expect(mockPost).not.toHaveBeenCalled();
    expect(mockChannel).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('モーダルを開いている間、supabase.from でテーブルを直接読みに行かない (旧実装は存在しないテーブルを読んでいた)', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    render(<NutritionDetailModal {...baseProps} />);
    await flushPromises();
    await advance(15_000);

    expect(mockFrom).not.toHaveBeenCalled();
  });
});

// ============================================================
// StatsModal
// ============================================================

describe('StatsModal: AI 栄養フィードバックの待ち受け (#1221)', () => {
  const todayNutrients: NutrientValues = {
    caloriesKcal: 1800,
    proteinG: 70,
    fatG: 55,
    carbsG: 250,
    fiberG: 18,
  };
  const weekNutrients: WeekNutrientData = {
    avgCalories: 1800,
    dailyKcal: [1800, 1900, 1700, 0, 0, 0, 0],
    avgProtein: 70,
    avgFat: 55,
    avgCarbs: 250,
    avgFiber: 18,
  };
  const todayMeals = [
    { dish_name: '鮭の塩焼き定食', calories_kcal: 650 },
    { dish_name: 'カレーライス', calories_kcal: 800 },
  ];
  const baseProps: StatsModalProps = {
    visible: true,
    onClose: jest.fn(),
    onOpenImprove: jest.fn(),
    selectedDate: '2026-10-08',
    weekRange: { start: '2026-10-06', end: '2026-10-12' },
    todayNutrients,
    weekNutrients,
    todayMeals,
  };

  it('生成中なら、実在する nutrition_feedback_cache を cacheId で購読する (存在しない ai_nutrition_feedback は見ない)', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    render(<StatsModal {...baseProps} />);
    await flushPromises();

    const channels = cacheChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0].registrations[0]).toMatchObject({
      type: 'postgres_changes',
      filter: {
        event: 'UPDATE',
        schema: 'public',
        table: 'nutrition_feedback_cache',
        filter: `id=eq.${CACHE_ID}`,
      },
    });
    expect(subscribedTables()).not.toContain('ai_nutrition_feedback');
  });

  it('「今日」タブを開いている間、5 秒ごとにテーブルを直接読みに行かない (旧実装は存在しないテーブルへ失敗クエリを投げ続けていた)', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    render(<StatsModal {...baseProps} />);
    await flushPromises();
    await advance(16_000);

    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('Realtime で completed の UPDATE が届くと、褒めコメントとアドバイスを表示して購読を外す', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    render(<StatsModal {...baseProps} />);
    await flushPromises();

    const [channel] = cacheChannels();
    expect(channel).toBeDefined();
    await emitRealtimeUpdate(channel, { status: 'completed', feedback: completedFeedbackColumn() });

    expect(screen.getByText('たんぱく質がしっかり摂れています✨')).toBeTruthy();
    expect(screen.getByText('夕食に小松菜の炒め物を足しましょう')).toBeTruthy();
    expect(screen.queryByText('あなたの献立を分析中...')).toBeNull();
    expect(channel.removed).toBe(true);
  });

  it('Realtime が届かなくても、cacheId のポーリングで completed を取得できる', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    render(<StatsModal {...baseProps} />);
    await flushPromises();
    expect(screen.getByText('あなたの献立を分析中...')).toBeTruthy();

    mockGet.mockResolvedValue(completedGetResponse());
    await advance(POLL_INTERVAL_MS);

    expect(mockGet).toHaveBeenCalledWith(POLL_URL);
    expect(screen.getByText('ポーリングで届いた褒めコメント')).toBeTruthy();
    expect(screen.getByText('ポーリングで届いたアドバイス')).toBeTruthy();
    expect(cacheChannels().every((c) => c.removed)).toBe(true);
  });

  it('キャッシュ済みなら購読もポーリングも使わず、そのまま表示する', async () => {
    mockPost.mockResolvedValue({ ...completedGetResponse(), cached: true });

    render(<StatsModal {...baseProps} />);
    await flushPromises();

    expect(screen.getByText('ポーリングで届いた褒めコメント')).toBeTruthy();
    expect(mockChannel).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('生成が失敗した (status=error) 場合は、スピナーを止めてメッセージを出す', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    render(<StatsModal {...baseProps} />);
    await flushPromises();

    const [channel] = cacheChannels();
    expect(channel).toBeDefined();
    await emitRealtimeUpdate(channel, {
      status: 'error',
      feedback: JSON.stringify({
        praiseComment: '',
        advice: '分析中にエラーが発生しました。再分析をお試しください。',
        nutritionTip: '',
      }),
    });

    expect(screen.queryByText('あなたの献立を分析中...')).toBeNull();
    expect(screen.getByText('分析中にエラーが発生しました。再分析をお試しください。')).toBeTruthy();
    expect(channel.removed).toBe(true);
  });

  it('40 秒待っても終わらなければ、スピナーを止めてタイムアウトのメッセージを出す', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    render(<StatsModal {...baseProps} />);
    await flushPromises();
    expect(screen.getByText('あなたの献立を分析中...')).toBeTruthy();

    await advance(POLL_INTERVAL_MS * (MAX_POLLS + 1));

    expect(screen.queryByText('あなたの献立を分析中...')).toBeNull();
    expect(screen.getByText('分析がタイムアウトしました。再分析をお試しください。')).toBeTruthy();
    expect(cacheChannels().every((c) => c.removed)).toBe(true);

    const callsAfterTimeout = pollCalls().length;
    await advance(POLL_INTERVAL_MS * 10);
    expect(pollCalls()).toHaveLength(callsAfterTimeout);
  });

  it('日付が変わったら前の日の待ち受けを止め、新しい日の cacheId で待ち直す', async () => {
    mockPost.mockResolvedValueOnce(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    const { rerender } = render(<StatsModal {...baseProps} />);
    await flushPromises();
    const [first] = cacheChannels();
    expect(first).toBeDefined();

    mockPost.mockResolvedValueOnce({ ...GENERATING, cacheId: 'cache-9' });
    rerender(<StatsModal {...baseProps} selectedDate="2026-10-09" />);
    await flushPromises();

    expect(first.removed).toBe(true);
    expect(mockPost).toHaveBeenLastCalledWith(
      '/api/ai/nutrition/feedback',
      expect.objectContaining({ date: '2026-10-09' }),
    );
    const active = cacheChannels().filter((c) => !c.removed);
    expect(active).toHaveLength(1);
    expect(active[0].registrations[0].filter.filter).toBe('id=eq.cache-9');
  });

  it('「今週」タブから「今日」タブへ戻したら、取得し直して待ち直す', async () => {
    mockPost.mockResolvedValueOnce(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    render(<StatsModal {...baseProps} />);
    await flushPromises();
    const [first] = cacheChannels();
    expect(first).toBeDefined();

    await act(async () => {
      fireEvent.press(screen.getByTestId('stats-tab-week'));
    });
    expect(first.removed).toBe(true);

    mockPost.mockResolvedValueOnce(GENERATING);
    await act(async () => {
      fireEvent.press(screen.getByTestId('stats-tab-today'));
    });
    await flushPromises();

    expect(mockPost).toHaveBeenCalledTimes(2);
    const active = cacheChannels().filter((c) => !c.removed);
    expect(active).toHaveLength(1);
    expect(active[0].registrations[0].filter.filter).toBe(`id=eq.${CACHE_ID}`);
  });

  it('「今週」タブへ切り替えると、購読もポーリングも止まる', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    render(<StatsModal {...baseProps} />);
    await flushPromises();
    const [channel] = cacheChannels();
    expect(channel).toBeDefined();

    await act(async () => {
      fireEvent.press(screen.getByTestId('stats-tab-week'));
    });
    expect(channel.removed).toBe(true);

    const callsAtSwitch = mockGet.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 30);
    expect(mockGet.mock.calls.length).toBe(callsAtSwitch);
  });

  it('モーダルを閉じると、購読もポーリングも止まる', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    const { rerender } = render(<StatsModal {...baseProps} />);
    await flushPromises();
    const [channel] = cacheChannels();
    expect(channel).toBeDefined();

    rerender(<StatsModal {...baseProps} visible={false} />);
    await flushPromises();
    expect(channel.removed).toBe(true);

    const callsAtClose = mockGet.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 30);
    expect(mockGet.mock.calls.length).toBe(callsAtClose);
  });

  it('POST の応答を待つ間にモーダルを閉じたら、遅れて届いた応答で購読もポーリングも始めない', async () => {
    let resolvePost: (value: unknown) => void = () => {};
    mockPost.mockReturnValue(new Promise((resolve) => { resolvePost = resolve; }));
    mockGet.mockResolvedValue(GET_GENERATING);

    const { rerender } = render(<StatsModal {...baseProps} />);
    await flushPromises();

    rerender(<StatsModal {...baseProps} visible={false} />);
    await flushPromises();

    resolvePost(GENERATING);
    await flushPromises();
    await advance(POLL_INTERVAL_MS * 5);

    expect(cacheChannels()).toHaveLength(0);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('アンマウントされても、購読もポーリングも止まる', async () => {
    mockPost.mockResolvedValue(GENERATING);
    mockGet.mockResolvedValue(GET_GENERATING);

    const { unmount } = render(<StatsModal {...baseProps} />);
    await flushPromises();
    const [channel] = cacheChannels();
    expect(channel).toBeDefined();

    unmount();
    expect(channel.removed).toBe(true);

    const callsAtUnmount = mockGet.mock.calls.length;
    await advance(POLL_INTERVAL_MS * 30);
    expect(mockGet.mock.calls.length).toBe(callsAtUnmount);
  });

  it('食事が 0 件なら API も購読も使わない', async () => {
    render(<StatsModal {...baseProps} todayMeals={[]} />);
    await flushPromises();
    await advance(POLL_INTERVAL_MS * 3);

    expect(mockPost).not.toHaveBeenCalled();
    expect(mockChannel).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
