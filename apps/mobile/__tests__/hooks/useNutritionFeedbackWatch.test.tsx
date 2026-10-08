/**
 * useNutritionFeedbackWatch.test.tsx
 *
 * #1221: AI 栄養フィードバックの取得 (POST) から結果待ち (Realtime + ポーリング) までの「持ち主」を決める
 * フック (src/hooks/useNutritionFeedbackWatch.ts) のテスト。
 *
 * 旧実装は各モーダルが pollRef / realtimeCleanupRef を自前で持ち、POST の応答を待っている間にモーダルを
 * 閉じても、遅れて届いた応答が購読やポーリングを始めてしまい、誰も止められなかった。
 * このフックは次のどれが起きても購読とポーリングを必ず解除し、その取得を「現役ではない」ことにする。
 *   - アンマウント / cancel() / 別の取得の開始
 */

import { act, renderHook } from '@testing-library/react-native';

import { useNutritionFeedbackWatch } from '../../src/hooks/useNutritionFeedbackWatch';
import { FEEDBACK_POLL_INTERVAL_MS } from '../../src/lib/nutrition-feedback-watch';

// ──────────────────────────────────────────────────────────────
// モック
// ──────────────────────────────────────────────────────────────

const mockGet = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ get: mockGet }),
}));

interface FakeChannel {
  name: string;
  filter: { table: string; filter?: string } | null;
  removed: boolean;
  on: (type: string, filter: { table: string; filter?: string }, handler: unknown) => FakeChannel;
  subscribe: (cb?: (status: string) => void) => FakeChannel;
}

const mockChannels: FakeChannel[] = [];
jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: (name: string) => {
      const channel: FakeChannel = {
        name,
        filter: null,
        removed: false,
        on: (_type, filter) => {
          channel.filter = filter;
          return channel;
        },
        subscribe: (cb) => {
          cb?.('SUBSCRIBED');
          return channel;
        },
      };
      mockChannels.push(channel);
      return channel;
    },
    removeChannel: async (channel: FakeChannel) => {
      channel.removed = true;
      return 'ok';
    },
  },
}));

const GENERATING = { status: 'generating', feedback: null, praiseComment: null, advice: null, nutritionTip: null };
const COMPLETED = {
  status: 'completed',
  feedback: 'アドバイス本文',
  advice: 'アドバイス本文',
  praiseComment: 'よくできました',
  nutritionTip: '豆知識',
};

function createHandlers() {
  return { onResolved: jest.fn(), onFailed: jest.fn() };
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockChannels.length = 0;
  mockGet.mockReset();
  mockGet.mockResolvedValue(GENERATING);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────
// テスト
// ──────────────────────────────────────────────────────────────

describe('useNutritionFeedbackWatch (#1221)', () => {
  it('watch() は nutrition_feedback_cache を cacheId で購読し、状態確認は認証付き API の GET (cacheId はエンコード) で行う', async () => {
    const { result } = renderHook(() => useNutritionFeedbackWatch());

    const request = result.current.startRequest();
    await act(async () => {
      request.watch('a b/c', createHandlers());
    });

    expect(mockChannels).toHaveLength(1);
    expect(mockChannels[0].filter).toEqual({
      event: 'UPDATE',
      schema: 'public',
      table: 'nutrition_feedback_cache',
      filter: 'id=eq.a b/c',
    });
    expect(mockGet).toHaveBeenCalledWith('/api/ai/nutrition/feedback?cacheId=a%20b%2Fc');
  });

  it('完了を受け取ると onResolved が呼ばれ、購読もポーリングも止まる', async () => {
    mockGet.mockResolvedValue(GENERATING);
    const { result } = renderHook(() => useNutritionFeedbackWatch());
    const handlers = createHandlers();

    await act(async () => {
      result.current.startRequest().watch('cache-1', handlers);
    });
    expect(handlers.onResolved).not.toHaveBeenCalled();

    mockGet.mockResolvedValue(COMPLETED);
    await advance(FEEDBACK_POLL_INTERVAL_MS);

    expect(handlers.onResolved).toHaveBeenCalledTimes(1);
    expect(handlers.onResolved).toHaveBeenCalledWith({
      advice: 'アドバイス本文',
      praiseComment: 'よくできました',
      nutritionTip: '豆知識',
    });
    expect(mockChannels[0].removed).toBe(true);

    const calls = mockGet.mock.calls.length;
    await advance(FEEDBACK_POLL_INTERVAL_MS * 10);
    expect(mockGet.mock.calls.length).toBe(calls);
  });

  it('マウント直後に始めた取得は現役である', () => {
    const { result } = renderHook(() => useNutritionFeedbackWatch());

    expect(result.current.startRequest().isCurrent()).toBe(true);
  });

  it('cancel() で待ち受けを止め、その取得は現役でなくなる', async () => {
    const { result } = renderHook(() => useNutritionFeedbackWatch());
    const handlers = createHandlers();
    const request = result.current.startRequest();
    await act(async () => {
      request.watch('cache-1', handlers);
    });
    expect(mockChannels[0].removed).toBe(false);

    act(() => result.current.cancel());

    expect(request.isCurrent()).toBe(false);
    expect(mockChannels[0].removed).toBe(true);

    const calls = mockGet.mock.calls.length;
    await advance(FEEDBACK_POLL_INTERVAL_MS * 30);
    expect(mockGet.mock.calls.length).toBe(calls);
    expect(handlers.onResolved).not.toHaveBeenCalled();
    expect(handlers.onFailed).not.toHaveBeenCalled();
  });

  it('cancel() は何も待っていなくても、何度呼んでも安全', () => {
    const { result } = renderHook(() => useNutritionFeedbackWatch());

    expect(() => {
      act(() => result.current.cancel());
      act(() => result.current.cancel());
    }).not.toThrow();
  });

  it('新しい startRequest() は前の取得の待ち受けを止め、前の取得は現役でなくなる', async () => {
    const { result } = renderHook(() => useNutritionFeedbackWatch());
    const first = result.current.startRequest();
    await act(async () => {
      first.watch('cache-1', createHandlers());
    });

    const second = result.current.startRequest();

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(mockChannels[0].removed).toBe(true);

    // 新しい取得は新しい cacheId を待てる
    await act(async () => {
      second.watch('cache-2', createHandlers());
    });
    expect(mockChannels).toHaveLength(2);
    expect(mockChannels[1].filter?.filter).toBe('id=eq.cache-2');
    expect(mockChannels[1].removed).toBe(false);
  });

  it('現役でなくなった取得の watch() は、購読もポーリングも始めない (POST の応答が遅れて届いた場合)', async () => {
    const { result } = renderHook(() => useNutritionFeedbackWatch());
    const stale = result.current.startRequest();

    act(() => result.current.cancel()); // モーダルが閉じられた
    await act(async () => {
      stale.watch('cache-1', createHandlers()); // 遅れて届いた POST の応答
    });
    await advance(FEEDBACK_POLL_INTERVAL_MS * 5);

    expect(mockChannels).toHaveLength(0);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('同じ取得で watch() を 2 回呼んでも、前の待ち受けを取り残さない', async () => {
    const { result } = renderHook(() => useNutritionFeedbackWatch());
    const request = result.current.startRequest();

    await act(async () => {
      request.watch('cache-1', createHandlers());
      request.watch('cache-2', createHandlers());
    });

    expect(mockChannels).toHaveLength(2);
    expect(mockChannels[0].removed).toBe(true);
    expect(mockChannels[1].removed).toBe(false);

    act(() => result.current.cancel());
    expect(mockChannels[1].removed).toBe(true);
  });

  it('アンマウントで待ち受けが止まり、その取得は現役でなくなる', async () => {
    const { result, unmount } = renderHook(() => useNutritionFeedbackWatch());
    const handlers = createHandlers();
    const request = result.current.startRequest();
    await act(async () => {
      request.watch('cache-1', handlers);
    });

    unmount();

    expect(request.isCurrent()).toBe(false);
    expect(mockChannels[0].removed).toBe(true);

    const calls = mockGet.mock.calls.length;
    await advance(FEEDBACK_POLL_INTERVAL_MS * 30);
    expect(mockGet.mock.calls.length).toBe(calls);
    expect(handlers.onResolved).not.toHaveBeenCalled();
    expect(handlers.onFailed).not.toHaveBeenCalled();
  });

  it('アンマウントのあとで届いた POST の応答は、購読もポーリングも始めない', async () => {
    const { result, unmount } = renderHook(() => useNutritionFeedbackWatch());
    const request = result.current.startRequest();

    unmount();
    await act(async () => {
      request.watch('cache-1', createHandlers());
    });
    await advance(FEEDBACK_POLL_INTERVAL_MS * 5);

    expect(mockChannels).toHaveLength(0);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('アンマウントのあとに始めた取得も現役ではなく、購読もポーリングも始めない', async () => {
    const { result, unmount } = renderHook(() => useNutritionFeedbackWatch());
    unmount();

    const request = result.current.startRequest();
    expect(request.isCurrent()).toBe(false);
    await act(async () => {
      request.watch('cache-1', createHandlers());
    });
    await advance(FEEDBACK_POLL_INTERVAL_MS * 5);

    expect(mockChannels).toHaveLength(0);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('startRequest / cancel は再レンダリングしても同じ参照 (呼び出し側の useCallback / useEffect を無駄に再実行させない)', () => {
    const { result, rerender } = renderHook(() => useNutritionFeedbackWatch());
    const before = result.current;

    rerender({});

    expect(result.current).toBe(before);
    expect(result.current.startRequest).toBe(before.startRequest);
    expect(result.current.cancel).toBe(before.cancel);
  });
});
