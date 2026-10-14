/**
 * tests/nutrition-feedback-watch.test.ts
 *
 * #1206: 献立ページ (menus/weekly) の AI栄養士フィードバック モーダルの cleanup が
 * stale closure で発火せず、Realtime 購読 / ポーリングがリークしていた問題の回帰テスト。
 *
 * 旧実装は useEffect の cleanup が `if (!showNutritionDetailModal && feedbackChannelRef.current)` と
 * state を見て解除を決めていた。cleanup は effect 作成時点のクロージャで動くため、
 * 「モーダルを開いたまま別ページへ移動 (アンマウント)」では常に「まだ開いている」と判断され、
 * Realtime チャンネルもポーリングも解除されなかった。
 * 修正後は購読/ポーリングを src/lib/nutrition-feedback-watch.ts と
 * src/hooks/useNutritionFeedbackWatch.ts に切り出し、state ではなく ref を見て必ず解除する。
 *
 * @testing-library/react は本リポジトリに無いので、react-dom/client の createRoot + act で
 * フックを実際に描画して検証する (CancelGenerationConfirmModal.test.ts と同じ手法)。
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  watchNutritionFeedback,
  FEEDBACK_ERROR_MESSAGE,
  FEEDBACK_MAX_POLLS,
  FEEDBACK_POLL_INTERVAL_MS,
  FEEDBACK_TIMEOUT_MESSAGE,
  type FeedbackRealtimeClient,
} from '@/lib/nutrition-feedback-watch';
import {
  useNutritionFeedbackWatch,
  type UseNutritionFeedbackWatchOptions,
} from '@/hooks/useNutritionFeedbackWatch';

// react-dom の act() を使う環境であることを React に伝える (警告抑止)
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = React.createElement;

// ──────────────────────────────────────────────────────────────
// テスト用の Supabase / fetch スタブ
// ──────────────────────────────────────────────────────────────

type RealtimeHandler = (payload: { new: Record<string, unknown> }) => void;

interface FakeChannelState {
  name: string;
  handler: RealtimeHandler | null;
  subscribed: boolean;
}

function createFakeSupabase(options: { onThrows?: boolean; removeChannelImpl?: () => unknown } = {}) {
  const channels: FakeChannelState[] = [];
  const supabase = {
    channel: vi.fn((name: string) => {
      const state: FakeChannelState = { name, handler: null, subscribed: false };
      channels.push(state);
      const channel = {
        state,
        on: vi.fn((_type: string, _filter: unknown, cb: RealtimeHandler) => {
          if (options.onThrows) {
            throw new Error('cannot add `postgres_changes` callbacks after `subscribe()`.');
          }
          state.handler = cb;
          return channel;
        }),
        subscribe: vi.fn((cb?: (status: string) => void) => {
          state.subscribed = true;
          cb?.('SUBSCRIBED');
          return channel;
        }),
      };
      return channel;
    }),
    removeChannel: vi.fn(async (_channel: unknown) => {
      if (options.removeChannelImpl) return options.removeChannelImpl();
      return 'ok';
    }),
  };
  return { supabase, channels, client: supabase as unknown as FeedbackRealtimeClient };
}

type PollBody = Record<string, unknown>;

/** 呼ばれるたびに bodies の先頭から順に返す (使い切ったら最後の値を返し続ける) */
function stubPollFetch(bodies: PollBody[]) {
  let index = 0;
  const fetchMock = vi.fn(async (_url: string) => {
    const body = bodies[Math.min(index, bodies.length - 1)];
    index++;
    return { ok: true, json: async () => body } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const GENERATING = { status: 'generating' };
const COMPLETED = {
  status: 'completed',
  feedback: 'アドバイス本文',
  advice: 'アドバイス本文',
  praiseComment: 'よくできました',
  nutritionTip: '豆知識',
};

beforeEach(() => {
  vi.useFakeTimers();
  // 本体が出すデバッグログでテスト出力が埋まらないようにする
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────
// watchNutritionFeedback (購読/ポーリング本体)
// ──────────────────────────────────────────────────────────────

describe('watchNutritionFeedback: どの終わり方でもポーリング停止 + チャンネル除去 (#1206)', () => {
  it('ポーリングで完了を受け取ると onResolved が 1 回呼ばれ、Realtime チャンネルも removeChannel される', async () => {
    const fetchMock = stubPollFetch([GENERATING, COMPLETED]);
    const { supabase, client } = createFakeSupabase();
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-1', onResolved, onFailed });
    expect(supabase.channel).toHaveBeenCalledWith('nutrition_feedback_cache-1');

    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);
    expect(onResolved).not.toHaveBeenCalled();
    expect(supabase.removeChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith({
      advice: 'アドバイス本文',
      praiseComment: 'よくできました',
      nutritionTip: '豆知識',
    });
    expect(onFailed).not.toHaveBeenCalled();
    // 旧実装は解決時に clearInterval だけで、チャンネルは残っていた
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);

    // ポーリングも止まっている
    const callsAtResolve = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 10);
    expect(fetchMock.mock.calls.length).toBe(callsAtResolve);
  });

  it('Realtime の UPDATE (completed / JSON 文字列) で onResolved が呼ばれ、ポーリングも止まりチャンネルも外れる', async () => {
    const fetchMock = stubPollFetch([GENERATING]);
    const { supabase, channels, client } = createFakeSupabase();
    const onResolved = vi.fn();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-2', onResolved, onFailed: vi.fn() });
    expect(channels[0].subscribed).toBe(true);

    channels[0].handler!({
      new: {
        status: 'completed',
        feedback: JSON.stringify({ praiseComment: '褒め', advice: '助言', nutritionTip: 'Tip' }),
      },
    });

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith({ advice: '助言', praiseComment: '褒め', nutritionTip: 'Tip' });
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 10);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Realtime の completed が旧形式 (JSON ではない文字列) ならその文字列を advice にする', () => {
    stubPollFetch([GENERATING]);
    const { channels, client } = createFakeSupabase();
    const onResolved = vi.fn();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-3', onResolved, onFailed: vi.fn() });
    channels[0].handler!({ new: { status: 'completed', feedback: 'ただの文字列のフィードバック' } });

    expect(onResolved).toHaveBeenCalledWith({
      advice: 'ただの文字列のフィードバック',
      praiseComment: null,
      nutritionTip: null,
    });
  });

  it('Realtime の error では保存されていた advice を onFailed に渡し、チャンネルを外す', () => {
    stubPollFetch([GENERATING]);
    const { supabase, channels, client } = createFakeSupabase();
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-4', onResolved, onFailed });
    channels[0].handler!({
      new: { status: 'error', feedback: JSON.stringify({ advice: 'LLM が失敗しました' }) },
    });

    expect(onFailed).toHaveBeenCalledWith('LLM が失敗しました');
    expect(onResolved).not.toHaveBeenCalled();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('Realtime の error で feedback が空なら既定のエラー文言を渡す', () => {
    stubPollFetch([GENERATING]);
    const { channels, client } = createFakeSupabase();
    const onFailed = vi.fn();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-5', onResolved: vi.fn(), onFailed });
    channels[0].handler!({ new: { status: 'error', feedback: null } });

    expect(onFailed).toHaveBeenCalledWith(FEEDBACK_ERROR_MESSAGE);
  });

  it('Realtime の途中経過 (generating の UPDATE) では何もせず、待ち続ける', () => {
    stubPollFetch([GENERATING]);
    const { supabase, channels, client } = createFakeSupabase();
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-6', onResolved, onFailed });
    channels[0].handler!({ new: { status: 'generating', feedback: '' } });

    expect(onResolved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(supabase.removeChannel).not.toHaveBeenCalled();
  });

  it('ポーリングの error でも onFailed を呼び、チャンネルを外す', async () => {
    stubPollFetch([{ status: 'error', advice: '失敗しました' }]);
    const { supabase, client } = createFakeSupabase();
    const onFailed = vi.fn();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-7', onResolved: vi.fn(), onFailed });
    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);

    expect(onFailed).toHaveBeenCalledWith('失敗しました');
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });

  it(`${FEEDBACK_MAX_POLLS} 回ポーリングしても終わらなければタイムアウト文言で onFailed を呼び、チャンネルも外す`, async () => {
    const fetchMock = stubPollFetch([GENERATING]);
    const { supabase, client } = createFakeSupabase();
    const onFailed = vi.fn();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-8', onResolved: vi.fn(), onFailed });

    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * (FEEDBACK_MAX_POLLS - 1));
    expect(onFailed).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith(FEEDBACK_TIMEOUT_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(FEEDBACK_MAX_POLLS);
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);

    // それ以上は叩かない
    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 5);
    expect(fetchMock).toHaveBeenCalledTimes(FEEDBACK_MAX_POLLS);
  });

  it('Realtime と ポーリングの両方が届いても onResolved は 1 回だけ', async () => {
    stubPollFetch([COMPLETED]);
    const { channels, client } = createFakeSupabase();
    const onResolved = vi.fn();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-9', onResolved, onFailed: vi.fn() });
    channels[0].handler!({ new: { status: 'completed', feedback: JSON.stringify({ advice: 'A' }) } });
    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 3);

    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('stop() でポーリング停止 + チャンネル除去。何度呼んでも removeChannel は 1 回', async () => {
    const fetchMock = stubPollFetch([GENERATING]);
    const { supabase, client } = createFakeSupabase();
    const onResolved = vi.fn();
    const onFailed = vi.fn();

    const stop = watchNutritionFeedback({ supabase: client, cacheId: 'cache-10', onResolved, onFailed });
    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stop();
    stop();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 30);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 止めたあとはもう叩かない
    expect(onResolved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled(); // タイムアウト通知も出ない
  });

  it('stop() の時点で応答待ちだったポーリング結果は捨てる (止めたあとに onResolved を呼ばない)', async () => {
    let releaseResponse: (value: Response) => void = () => {};
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => { releaseResponse = resolve; })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { client } = createFakeSupabase();
    const onResolved = vi.fn();

    const stop = watchNutritionFeedback({ supabase: client, cacheId: 'cache-11', onResolved, onFailed: vi.fn() });
    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stop();
    releaseResponse({ ok: true, json: async () => COMPLETED } as unknown as Response);
    await vi.advanceTimersByTimeAsync(0);

    expect(onResolved).not.toHaveBeenCalled();
  });

  it('Realtime の購読で例外が出ても外へ投げず、ポーリングだけで結果を受け取る (同名チャンネル残存時の .on() 例外)', async () => {
    stubPollFetch([COMPLETED]);
    const { supabase, client } = createFakeSupabase({ onThrows: true });
    const onResolved = vi.fn();

    expect(() =>
      watchNutritionFeedback({ supabase: client, cacheId: 'cache-12', onResolved, onFailed: vi.fn() })
    ).not.toThrow();

    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);
    expect(onResolved).toHaveBeenCalledTimes(1);
    // 例外の出たチャンネルも取り残さない
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('removeChannel が reject / throw しても stop() は例外を出さない', async () => {
    stubPollFetch([GENERATING]);
    const rejecting = createFakeSupabase({ removeChannelImpl: () => Promise.reject(new Error('socket closed')) });
    const stopRejecting = watchNutritionFeedback({
      supabase: rejecting.client, cacheId: 'cache-13', onResolved: vi.fn(), onFailed: vi.fn(),
    });
    expect(() => stopRejecting()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0); // reject が未処理にならない

    const throwing = createFakeSupabase({ removeChannelImpl: () => { throw new Error('boom'); } });
    const stopThrowing = watchNutritionFeedback({
      supabase: throwing.client, cacheId: 'cache-14', onResolved: vi.fn(), onFailed: vi.fn(),
    });
    expect(() => stopThrowing()).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────
// useNutritionFeedbackWatch (所有権: アンマウント / モーダルを閉じる / 置き換え)
// ──────────────────────────────────────────────────────────────

type HookResult = ReturnType<typeof useNutritionFeedbackWatch>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  // テスト内でアンマウント済みの場合は何もしない
  try {
    act(() => root?.unmount());
  } catch {
    // 既にアンマウント済み
  }
  container.remove();
});

function renderWatchHook(
  initial: UseNutritionFeedbackWatchOptions,
  { strict = false }: { strict?: boolean } = {}
) {
  const result: { current: HookResult } = { current: null as unknown as HookResult };
  function Harness(props: { options: UseNutritionFeedbackWatchOptions }) {
    result.current = useNutritionFeedbackWatch(props.options);
    return null;
  }
  const element = (options: UseNutritionFeedbackWatchOptions) => {
    const harness = h(Harness, { options });
    return strict ? h(React.StrictMode, null, harness) : harness;
  };
  act(() => {
    root = createRoot(container);
    root.render(element(initial));
  });
  return {
    result,
    rerender(options: UseNutritionFeedbackWatchOptions) {
      act(() => root.render(element(options)));
    },
    unmount() {
      act(() => root.unmount());
    },
  };
}

function hookOptions(
  client: FeedbackRealtimeClient,
  overrides: Partial<UseNutritionFeedbackWatchOptions> = {}
): UseNutritionFeedbackWatchOptions {
  return {
    supabase: client,
    isViewing: true,
    isLoading: true,
    onAbandoned: vi.fn(),
    ...overrides,
  };
}

describe('useNutritionFeedbackWatch: アンマウント時は state を見ずに必ず解除する (#1206 の再現)', () => {
  it('モーダルを開いたまま (isViewing=true) アンマウントしても、Realtime 購読もポーリングも解除される', async () => {
    const fetchMock = stubPollFetch([GENERATING]);
    const { supabase, client } = createFakeSupabase();
    const handlers = { onResolved: vi.fn(), onFailed: vi.fn() };
    const view = renderWatchHook(hookOptions(client, { isViewing: true, isLoading: true }));

    const request = view.result.current.startRequest();
    request.watch('cache-a', handlers);
    expect(supabase.channel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1); // ポーリング稼働中

    view.unmount();

    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 30);
    expect(fetchMock).toHaveBeenCalledTimes(1); // アンマウント後は叩かない
    expect(handlers.onResolved).not.toHaveBeenCalled();
    expect(handlers.onFailed).not.toHaveBeenCalled();
  });

  it('アンマウント時は onAbandoned を呼ばない (消えたコンポーネントの state を触らない)', () => {
    stubPollFetch([GENERATING]);
    const { client } = createFakeSupabase();
    const options = hookOptions(client, { isViewing: true, isLoading: true });
    const view = renderWatchHook(options);
    view.result.current.startRequest().watch('cache-b', { onResolved: vi.fn(), onFailed: vi.fn() });

    view.unmount();

    expect(options.onAbandoned).not.toHaveBeenCalled();
  });

  it('POST の応答待ち (購読前) にアンマウントされたら、応答が戻ってから watch を呼んでも購読を張らない', async () => {
    const fetchMock = stubPollFetch([GENERATING]);
    const { supabase, client } = createFakeSupabase();
    const view = renderWatchHook(hookOptions(client));

    const request = view.result.current.startRequest();
    expect(request.isCurrent()).toBe(true);

    view.unmount();

    // 応答が戻った想定
    expect(request.isCurrent()).toBe(false);
    request.watch('cache-c', { onResolved: vi.fn(), onFailed: vi.fn() });
    expect(supabase.channel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 5);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('アンマウント後に startRequest しても現役にならず、購読も張らない', () => {
    stubPollFetch([GENERATING]);
    const { supabase, client } = createFakeSupabase();
    const view = renderWatchHook(hookOptions(client));
    const { startRequest } = view.result.current;

    view.unmount();
    const late = startRequest();

    expect(late.isCurrent()).toBe(false);
    late.watch('cache-d', { onResolved: vi.fn(), onFailed: vi.fn() });
    expect(supabase.channel).not.toHaveBeenCalled();
  });

  it('StrictMode (開発時の effect 二重実行) でも取得は現役になり、アンマウントでは解除される', () => {
    stubPollFetch([GENERATING]);
    const { supabase, client } = createFakeSupabase();
    const view = renderWatchHook(hookOptions(client), { strict: true });

    const request = view.result.current.startRequest();
    expect(request.isCurrent()).toBe(true);
    request.watch('cache-e', { onResolved: vi.fn(), onFailed: vi.fn() });

    view.unmount();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });
});

describe('useNutritionFeedbackWatch: モーダルがすべて閉じたら結果待ちをやめる', () => {
  it('取得中のままモーダルを閉じると、購読/ポーリングを解除し、onAbandoned (スピナー解除 + 再取得の準備) を 1 回呼ぶ', async () => {
    const fetchMock = stubPollFetch([GENERATING]);
    const { supabase, client } = createFakeSupabase();
    const onAbandoned = vi.fn();
    const view = renderWatchHook(hookOptions(client, { isViewing: true, isLoading: true, onAbandoned }));

    const request = view.result.current.startRequest();
    request.watch('cache-f', { onResolved: vi.fn(), onFailed: vi.fn() });

    view.rerender(hookOptions(client, { isViewing: false, isLoading: true, onAbandoned }));

    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
    expect(onAbandoned).toHaveBeenCalledTimes(1);
    expect(request.isCurrent()).toBe(false);
    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 10);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST の応答待ち (購読前) にモーダルを閉じたら、応答が戻っても購読を張らず、onAbandoned を呼ぶ', () => {
    stubPollFetch([GENERATING]);
    const { supabase, client } = createFakeSupabase();
    const onAbandoned = vi.fn();
    const view = renderWatchHook(hookOptions(client, { isViewing: true, isLoading: true, onAbandoned }));

    const request = view.result.current.startRequest();
    view.rerender(hookOptions(client, { isViewing: false, isLoading: true, onAbandoned }));

    expect(request.isCurrent()).toBe(false);
    request.watch('cache-g', { onResolved: vi.fn(), onFailed: vi.fn() });
    expect(supabase.channel).not.toHaveBeenCalled();
    expect(onAbandoned).toHaveBeenCalledTimes(1);
  });

  it('取得が終わっている (isLoading=false) なら、モーダルを閉じても onAbandoned は呼ばない', () => {
    stubPollFetch([GENERATING]);
    const { client } = createFakeSupabase();
    const onAbandoned = vi.fn();
    const view = renderWatchHook(hookOptions(client, { isViewing: true, isLoading: false, onAbandoned }));

    view.rerender(hookOptions(client, { isViewing: false, isLoading: false, onAbandoned }));

    expect(onAbandoned).not.toHaveBeenCalled();
  });

  it('マウント時点でモーダルが閉じていても (初期状態)、onAbandoned は呼ばない', () => {
    const { client } = createFakeSupabase();
    const onAbandoned = vi.fn();
    renderWatchHook(hookOptions(client, { isViewing: false, isLoading: false, onAbandoned }));

    expect(onAbandoned).not.toHaveBeenCalled();
  });

  it('isViewing が true のまま再描画されても (サマリー → 栄養詳細への切り替え等)、進行中の購読は解除されず結果も届く', async () => {
    stubPollFetch([GENERATING]);
    const { supabase, channels, client } = createFakeSupabase();
    const onAbandoned = vi.fn();
    const handlers = { onResolved: vi.fn(), onFailed: vi.fn() };
    const view = renderWatchHook(hookOptions(client, { isViewing: true, isLoading: true, onAbandoned }));
    const request = view.result.current.startRequest();
    request.watch('cache-h', handlers);

    // 依存の変化 (別の onAbandoned、isLoading の切り替え、再描画) を何度重ねても解除しない
    view.rerender(hookOptions(client, { isViewing: true, isLoading: true, onAbandoned: vi.fn() }));
    view.rerender(hookOptions(client, { isViewing: true, isLoading: false, onAbandoned }));
    view.rerender(hookOptions(client, { isViewing: true, isLoading: true, onAbandoned }));

    expect(supabase.removeChannel).not.toHaveBeenCalled();
    expect(onAbandoned).not.toHaveBeenCalled();
    expect(request.isCurrent()).toBe(true);

    channels[0].handler!({ new: { status: 'completed', feedback: JSON.stringify({ advice: '届いた' }) } });
    expect(handlers.onResolved).toHaveBeenCalledWith({ advice: '届いた', praiseComment: null, nutritionTip: null });
  });
});

describe('useNutritionFeedbackWatch: 取得の置き換えと解決時の後始末', () => {
  it('新しい取得を始めると、前の購読/ポーリングは解除され、前の取得は現役でなくなる', async () => {
    const fetchMock = stubPollFetch([GENERATING]);
    const { supabase, client } = createFakeSupabase();
    const view = renderWatchHook(hookOptions(client));

    const first = view.result.current.startRequest();
    first.watch('cache-i', { onResolved: vi.fn(), onFailed: vi.fn() });
    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = view.result.current.startRequest();

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);

    // 古い取得の watch は何も起こさない
    first.watch('cache-i', { onResolved: vi.fn(), onFailed: vi.fn() });
    expect(supabase.channel).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 10);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 前のポーリングは止まっている
  });

  it('結果が届いたらチャンネルは外れ、その後にアンマウントしても二重には外さない', () => {
    stubPollFetch([GENERATING]);
    const { supabase, channels, client } = createFakeSupabase();
    const handlers = { onResolved: vi.fn(), onFailed: vi.fn() };
    const view = renderWatchHook(hookOptions(client));
    view.result.current.startRequest().watch('cache-j', handlers);

    channels[0].handler!({ new: { status: 'completed', feedback: JSON.stringify({ advice: 'OK' }) } });
    expect(handlers.onResolved).toHaveBeenCalledTimes(1);
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('失敗/タイムアウトで終わったときもチャンネルは外れる', async () => {
    stubPollFetch([GENERATING]);
    const { supabase, client } = createFakeSupabase();
    const handlers = { onResolved: vi.fn(), onFailed: vi.fn() };
    const view = renderWatchHook(hookOptions(client));
    view.result.current.startRequest().watch('cache-k', handlers);

    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * FEEDBACK_MAX_POLLS);

    expect(handlers.onFailed).toHaveBeenCalledWith(FEEDBACK_TIMEOUT_MESSAGE);
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────
// ページ側の配線 (page.tsx 全体は描画できないため、ソースの contract テストで退行を防ぐ)
// ──────────────────────────────────────────────────────────────

describe('menus/weekly/page.tsx の配線 (#1206)', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/app/(main)/menus/weekly/page.tsx'),
    'utf8'
  );
  // fetchNutritionFeedback の本体 (次の useEffect の手前まで)
  const fetchStart = source.indexOf('const fetchNutritionFeedback = async');
  const fetchEnd = source.indexOf('useEffect(', fetchStart);
  const fetchSection = source.slice(fetchStart, fetchEnd);

  it('fetchNutritionFeedback の本体を特定できている', () => {
    expect(fetchStart).toBeGreaterThan(0);
    expect(fetchEnd).toBeGreaterThan(fetchStart);
    expect(fetchSection).toContain("'/api/ai/nutrition/feedback'");
  });

  it('購読/ポーリングは useNutritionFeedbackWatch に任せ、旧 feedbackChannelRef は残っていない', () => {
    expect(source).toContain('useNutritionFeedbackWatch({');
    expect(source).not.toContain('feedbackChannelRef');
  });

  it('モーダルが開いている判定は 栄養詳細モーダル と サマリー(stats)モーダル の両方を含む (stats 経路の購読を殺さない)', () => {
    expect(source).toMatch(/isViewing:\s*showNutritionDetailModal\s*\|\|\s*activeModal\s*===\s*'stats'/);
  });

  it('fetchNutritionFeedback は取得の開始時に startRequest し、await のあとで isCurrent を確認する', () => {
    expect(fetchSection).toContain('feedbackWatch.startRequest()');
    expect(fetchSection).toContain('request.watch(');
    const guards = fetchSection.match(/if \(!request\.isCurrent\(\)\) return;/g) ?? [];
    // fetch の後 / res.json() の後 / catch の 3 か所
    expect(guards.length).toBeGreaterThanOrEqual(3);
  });

  it('fetchNutritionFeedback に購読/ポーリングを自前で組む処理が残っておらず、page 全体に stale closure の cleanup も無い', () => {
    expect(fetchSection).not.toMatch(/setInterval\(|clearInterval\(|\.channel\(|removeChannel\(/);
    // 旧実装: cleanup の中で state (showNutritionDetailModal) を見て解除するかどうかを決めていた
    expect(source).not.toMatch(/if \(!showNutritionDetailModal\b[^)]*feedback/);
  });
});
