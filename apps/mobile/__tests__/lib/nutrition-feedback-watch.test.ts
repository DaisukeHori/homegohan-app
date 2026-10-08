/**
 * nutrition-feedback-watch.test.ts
 *
 * #1221: モバイルの AI 栄養フィードバック待ち受け (src/lib/nutrition-feedback-watch.ts) の単体テスト。
 *
 * 旧実装 (realtime.ts の subscribeNutritionFeedback と、栄養分析モーダル 2 種のインライン実装) は
 *  - 本番に存在しない `ai_nutrition_feedback` を購読 / ポーリングしており、イベントが永久に届かなかった
 *  - 差分検出が「limit(1) の結果の件数 (0 か 1)」を覚えた件数と比べるだけで、初回以降は新しい行を検出できなかった
 *  - 生成の失敗 (status=error) を検出できず、40 秒待ってから黙って諦めていた
 * 修正後は POST の応答で得た cacheId (= nutrition_feedback_cache.id) の 1 行だけを見る。
 * ここでは、その待ち受けがどの終わり方でも「ポーリングの停止と Realtime チャンネルの除去」を必ず行い、
 * 通知を 1 回だけ出すことを確かめる。モーダル越しの確認は menus-weekly/nutrition-feedback-modals.test.tsx。
 */

import {
  FEEDBACK_ERROR_MESSAGE,
  FEEDBACK_MAX_POLLS,
  FEEDBACK_POLL_INTERVAL_MS,
  FEEDBACK_TIMEOUT_MESSAGE,
  watchNutritionFeedback,
  type FeedbackRealtimeClient,
  type NutritionFeedbackStatusResponse,
} from '../../src/lib/nutrition-feedback-watch';

// ──────────────────────────────────────────────────────────────
// テスト用の Supabase / API スタブ
// ──────────────────────────────────────────────────────────────

type RealtimeHandler = (payload: { new?: Record<string, unknown> }) => void;

interface FakeChannelState {
  name: string;
  filter: { event: string; schema: string; table: string; filter?: string } | null;
  handler: RealtimeHandler | null;
  subscribed: boolean;
}

/** supabase.channel() が返す偽チャンネル (.on() / .subscribe() は自分自身を返す) */
interface FakeChannel {
  state: FakeChannelState;
  on: jest.Mock;
  subscribe: jest.Mock;
}

interface FakeSupabaseOptions {
  /** .on() が例外を投げる (同名トピックの購読が残っていて、subscribe 後の .on() になった場合の再現) */
  onThrows?: boolean;
  /** subscribe のコールバックに渡す状態 */
  subscribeStatus?: string;
  removeChannelImpl?: () => unknown;
}

function createFakeSupabase(options: FakeSupabaseOptions = {}) {
  const channels: FakeChannelState[] = [];
  const supabase = {
    channel: jest.fn((name: string) => {
      const state: FakeChannelState = { name, filter: null, handler: null, subscribed: false };
      channels.push(state);
      const channel: FakeChannel = {
        state,
        on: jest.fn((_type: string, filter: FakeChannelState['filter'], cb: RealtimeHandler) => {
          if (options.onThrows) {
            throw new Error('cannot add `postgres_changes` callbacks after `subscribe()`.');
          }
          state.filter = filter;
          state.handler = cb;
          return channel;
        }),
        subscribe: jest.fn((cb?: (status: string) => void) => {
          state.subscribed = true;
          cb?.(options.subscribeStatus ?? 'SUBSCRIBED');
          return channel;
        }),
      };
      return channel;
    }),
    // async にしない (同期的な throw も再現できるようにするため)
    removeChannel: jest.fn((_channel: unknown) => {
      if (options.removeChannelImpl) return options.removeChannelImpl();
      return Promise.resolve('ok');
    }),
  };
  return { supabase, channels, client: supabase as unknown as FeedbackRealtimeClient };
}

type StatusResponse = NutritionFeedbackStatusResponse;

/** 呼ばれるたびに responses の先頭から順に返す (使い切ったら最後の値を返し続ける) */
function stubFetchStatus(responses: StatusResponse[]) {
  let index = 0;
  return jest.fn(async (_cacheId: string): Promise<StatusResponse> => {
    const body = responses[Math.min(index, responses.length - 1)];
    index++;
    return body;
  });
}

const GENERATING: StatusResponse = {
  status: 'generating',
  feedback: null,
  praiseComment: null,
  advice: null,
  nutritionTip: null,
};
const COMPLETED: StatusResponse = {
  status: 'completed',
  feedback: 'アドバイス本文',
  advice: 'アドバイス本文',
  praiseComment: 'よくできました',
  nutritionTip: '豆知識',
};

/** 通知の 1 回だけ / 後始末の確認に使うコールバック */
function createHandlers() {
  return { onResolved: jest.fn(), onFailed: jest.fn() };
}

/** 保留中の Promise (マイクロタスク) を流す */
async function flush() {
  await jest.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  jest.useFakeTimers();
  // 本体が出す警告 / エラーログでテスト出力が埋まらないようにする
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────
// 購読先
// ──────────────────────────────────────────────────────────────

describe('watchNutritionFeedback: 購読先 (#1221)', () => {
  it('実在する nutrition_feedback_cache の UPDATE を、cacheId の 1 行 (id=eq.<cacheId>) に絞って購読する', () => {
    const { channels, client } = createFakeSupabase();

    watchNutritionFeedback({
      supabase: client,
      cacheId: 'cache-1',
      fetchStatus: stubFetchStatus([GENERATING]),
      ...createHandlers(),
    });

    expect(channels).toHaveLength(1);
    expect(channels[0].subscribed).toBe(true);
    expect(channels[0].filter).toEqual({
      event: 'UPDATE',
      schema: 'public',
      table: 'nutrition_feedback_cache',
      filter: 'id=eq.cache-1',
    });
    // 旧実装が見ていた存在しないテーブル / user_id フィルタ (INSERT) は使わない
    expect(JSON.stringify(channels[0].filter)).not.toContain('ai_nutrition_feedback');
    expect(JSON.stringify(channels[0].filter)).not.toContain('user_id');
    expect(channels[0].filter?.event).not.toBe('INSERT');
  });

  it('同じ cacheId を同時に 2 か所で待っても、チャンネル名が重ならず、どちらも購読できる', () => {
    const first = createFakeSupabase();
    // 同じ Supabase クライアントを共有して 2 回待つ
    watchNutritionFeedback({
      supabase: first.client,
      cacheId: 'cache-1',
      fetchStatus: stubFetchStatus([GENERATING]),
      ...createHandlers(),
    });
    watchNutritionFeedback({
      supabase: first.client,
      cacheId: 'cache-1',
      fetchStatus: stubFetchStatus([GENERATING]),
      ...createHandlers(),
    });

    expect(first.channels).toHaveLength(2);
    expect(first.channels[0].name).not.toBe(first.channels[1].name);
    // Realtime のチャンネル名は同名だと同じチャンネルが返り、subscribe 後の .on() が例外になる。
    // ここでは両方とも .on() まで成功していること (= 購読が張れていること) を確かめる
    expect(first.channels[0].handler).not.toBeNull();
    expect(first.channels[1].handler).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────
// 開始直後の確認
// ──────────────────────────────────────────────────────────────

describe('watchNutritionFeedback: 開始直後の確認 (#1221)', () => {
  it('開始と同時に現在の状態を cacheId で 1 回確認する', async () => {
    const fetchStatus = stubFetchStatus([GENERATING]);
    const { client } = createFakeSupabase();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-1', fetchStatus, ...createHandlers() });
    await flush();

    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(fetchStatus).toHaveBeenCalledWith('cache-1');
  });

  it('購読前に生成が終わっていた (サーバーが完了後に応答した) 場合は、次のポーリングを待たずに結果を返す', async () => {
    const fetchStatus = stubFetchStatus([COMPLETED]);
    const { supabase, client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-1', fetchStatus, onResolved, onFailed });
    await flush(); // ポーリング間隔は進めない

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith({
      advice: 'アドバイス本文',
      praiseComment: 'よくできました',
      nutritionTip: '豆知識',
    });
    expect(onFailed).not.toHaveBeenCalled();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);

    // 終わったあとはポーリングしない
    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 10);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('購読前に生成が失敗していた (status=error) 場合も、すぐ失敗を返す', async () => {
    const fetchStatus = stubFetchStatus([{ ...GENERATING, status: 'error' }]);
    const { supabase, client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-1', fetchStatus, onResolved, onFailed });
    await flush();

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith(FEEDBACK_ERROR_MESSAGE);
    expect(onResolved).not.toHaveBeenCalled();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('生成中なら何も通知せず、購読もポーリングも続ける', async () => {
    const fetchStatus = stubFetchStatus([GENERATING]);
    const { supabase, client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-1', fetchStatus, onResolved, onFailed });
    await flush();

    expect(onResolved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(supabase.removeChannel).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);
    expect(fetchStatus).toHaveBeenCalledTimes(2); // 開始時 + 1 回目のポーリング
  });
});

// ──────────────────────────────────────────────────────────────
// Realtime での受け取り
// ──────────────────────────────────────────────────────────────

describe('watchNutritionFeedback: Realtime の UPDATE (#1221)', () => {
  it('completed (JSON 文字列) で onResolved を 1 回呼び、ポーリングも止まりチャンネルも外れる', async () => {
    const fetchStatus = stubFetchStatus([GENERATING]);
    const { supabase, channels, client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-2', fetchStatus, onResolved, onFailed });
    await flush();
    const callsBefore = fetchStatus.mock.calls.length;

    channels[0].handler!({
      new: {
        status: 'completed',
        feedback: JSON.stringify({ praiseComment: '褒め', advice: '助言', nutritionTip: 'Tip' }),
      },
    });

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith({ advice: '助言', praiseComment: '褒め', nutritionTip: 'Tip' });
    expect(onFailed).not.toHaveBeenCalled();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 10);
    expect(fetchStatus.mock.calls.length).toBe(callsBefore);
  });

  it('completed が旧形式 (JSON ではない文字列) なら、その文字列を advice にする', async () => {
    const { channels, client } = createFakeSupabase();
    const { onResolved } = createHandlers();

    watchNutritionFeedback({
      supabase: client,
      cacheId: 'cache-3',
      fetchStatus: stubFetchStatus([GENERATING]),
      onResolved,
      onFailed: jest.fn(),
    });
    await flush();
    channels[0].handler!({ new: { status: 'completed', feedback: 'ただの文字列のフィードバック' } });

    expect(onResolved).toHaveBeenCalledWith({
      advice: 'ただの文字列のフィードバック',
      praiseComment: null,
      nutritionTip: null,
    });
  });

  it('error では、サーバーが保存したメッセージ (feedback の advice) を onFailed に渡してチャンネルを外す', async () => {
    const { supabase, channels, client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    watchNutritionFeedback({
      supabase: client,
      cacheId: 'cache-4',
      fetchStatus: stubFetchStatus([GENERATING]),
      onResolved,
      onFailed,
    });
    await flush();
    channels[0].handler!({
      new: {
        status: 'error',
        feedback: JSON.stringify({ praiseComment: '', advice: 'LLM が失敗しました', nutritionTip: '' }),
      },
    });

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith('LLM が失敗しました');
    expect(onResolved).not.toHaveBeenCalled();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('error で feedback が空なら、既定のエラー文言を渡す', async () => {
    const { channels, client } = createFakeSupabase();
    const { onFailed } = createHandlers();

    watchNutritionFeedback({
      supabase: client,
      cacheId: 'cache-5',
      fetchStatus: stubFetchStatus([GENERATING]),
      onResolved: jest.fn(),
      onFailed,
    });
    await flush();
    channels[0].handler!({ new: { status: 'error', feedback: null } });

    expect(onFailed).toHaveBeenCalledWith(FEEDBACK_ERROR_MESSAGE);
  });

  it('途中経過 (status=generating の UPDATE) では何もせず、待ち続ける', async () => {
    const { supabase, channels, client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    watchNutritionFeedback({
      supabase: client,
      cacheId: 'cache-6',
      fetchStatus: stubFetchStatus([GENERATING]),
      onResolved,
      onFailed,
    });
    await flush();
    channels[0].handler!({ new: { status: 'generating', feedback: '' } });
    channels[0].handler!({}); // payload.new が無いイベントも無視する

    expect(onResolved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(supabase.removeChannel).not.toHaveBeenCalled();
  });

  it('completed でも feedback が空なら、まだ完了扱いにしない', async () => {
    const { supabase, channels, client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    watchNutritionFeedback({
      supabase: client,
      cacheId: 'cache-6b',
      fetchStatus: stubFetchStatus([GENERATING]),
      onResolved,
      onFailed,
    });
    await flush();
    channels[0].handler!({ new: { status: 'completed', feedback: '' } });

    expect(onResolved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(supabase.removeChannel).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────
// ポーリングでの受け取り
// ──────────────────────────────────────────────────────────────

describe('watchNutritionFeedback: ポーリング (#1221)', () => {
  it('Realtime が届かなくても、ポーリングの completed で onResolved を 1 回呼び、チャンネルも外す', async () => {
    const fetchStatus = stubFetchStatus([GENERATING, GENERATING, COMPLETED]);
    const { supabase, client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-1', fetchStatus, onResolved, onFailed });
    await flush(); // 開始時の確認 (generating)
    expect(onResolved).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS); // 1 回目のポーリング (generating)
    expect(onResolved).not.toHaveBeenCalled();
    expect(supabase.removeChannel).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS); // 2 回目のポーリング (completed)
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalledWith({
      advice: 'アドバイス本文',
      praiseComment: 'よくできました',
      nutritionTip: '豆知識',
    });
    expect(onFailed).not.toHaveBeenCalled();
    // 旧実装は解決時に clearInterval だけで、購読は残っていた
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);

    const callsAtResolve = fetchStatus.mock.calls.length;
    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 10);
    expect(fetchStatus.mock.calls.length).toBe(callsAtResolve);
  });

  it('completed の応答に advice が無ければ feedback を、praiseComment が無ければ null を渡す', async () => {
    const fetchStatus = stubFetchStatus([{ status: 'completed', feedback: '旧形式の本文' }]);
    const { client } = createFakeSupabase();
    const { onResolved } = createHandlers();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-1', fetchStatus, onResolved, onFailed: jest.fn() });
    await flush();

    expect(onResolved).toHaveBeenCalledWith({
      advice: '旧形式の本文',
      praiseComment: null,
      nutritionTip: null,
    });
  });

  it('status=error では、応答に本文が無いので既定のエラー文言で onFailed を呼び、チャンネルも外す', async () => {
    // GET /api/ai/nutrition/feedback は error の行では advice / feedback を返さない (null)
    const fetchStatus = stubFetchStatus([GENERATING, { ...GENERATING, status: 'error' }]);
    const { supabase, client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-7', fetchStatus, onResolved, onFailed });
    await flush();
    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith(FEEDBACK_ERROR_MESSAGE);
    expect(onResolved).not.toHaveBeenCalled();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('一時的な通信エラー (reject) は握りつぶして、次のポーリングで結果を受け取る', async () => {
    const fetchStatus = jest
      .fn<Promise<StatusResponse>, [string]>()
      .mockRejectedValueOnce(new Error('network down')) // 開始時の確認
      .mockRejectedValueOnce(new Error('network down')) // 1 回目のポーリング
      .mockResolvedValue(COMPLETED);
    const { client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-1', fetchStatus, onResolved, onFailed });
    await flush();
    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);
    expect(onResolved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('Realtime とポーリングの両方が届いても、onResolved は 1 回だけ', async () => {
    const { channels, client } = createFakeSupabase();
    const { onResolved } = createHandlers();

    watchNutritionFeedback({
      supabase: client,
      cacheId: 'cache-9',
      fetchStatus: stubFetchStatus([COMPLETED]),
      onResolved,
      onFailed: jest.fn(),
    });
    // 開始時の確認 (completed) の応答が返る前に Realtime も届く
    channels[0].handler!({ new: { status: 'completed', feedback: JSON.stringify({ advice: 'A' }) } });
    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 3);

    expect(onResolved).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────
// タイムアウト
// ──────────────────────────────────────────────────────────────

describe('watchNutritionFeedback: タイムアウト (#1221)', () => {
  it(`${FEEDBACK_MAX_POLLS} 回ポーリングしても終わらなければ、次の周期でタイムアウト文言の onFailed を 1 回呼び、チャンネルも外す`, async () => {
    const fetchStatus = stubFetchStatus([GENERATING]);
    const { supabase, client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-8', fetchStatus, onResolved, onFailed });
    await flush();

    // 上限回数 (20 回 = 40 秒) ぶんのポーリングを使い切るまでは諦めない
    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * FEEDBACK_MAX_POLLS);
    expect(onFailed).not.toHaveBeenCalled();
    expect(supabase.removeChannel).not.toHaveBeenCalled();
    expect(fetchStatus).toHaveBeenCalledTimes(1 + FEEDBACK_MAX_POLLS); // 開始時の確認 + ポーリング

    // 次の周期でタイムアウト
    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith(FEEDBACK_TIMEOUT_MESSAGE);
    expect(onResolved).not.toHaveBeenCalled();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);

    // それ以上は叩かない / 通知しない
    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 10);
    expect(fetchStatus).toHaveBeenCalledTimes(1 + FEEDBACK_MAX_POLLS);
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('応答が返ってこない (ハングした) 通信が続いても、時間が来れば諦める', async () => {
    const fetchStatus = jest.fn(() => new Promise<StatusResponse>(() => {})); // 永久に解決しない
    const { supabase, client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-1', fetchStatus, onResolved, onFailed });
    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * (FEEDBACK_MAX_POLLS + 1));

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith(FEEDBACK_TIMEOUT_MESSAGE);
    expect(onResolved).not.toHaveBeenCalled();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('間隔と回数は呼び出し側で変えられる', async () => {
    const fetchStatus = stubFetchStatus([GENERATING]);
    const { client } = createFakeSupabase();
    const { onFailed } = createHandlers();

    watchNutritionFeedback({
      supabase: client,
      cacheId: 'cache-1',
      fetchStatus,
      onResolved: jest.fn(),
      onFailed,
      pollIntervalMs: 100,
      maxPolls: 3,
    });
    await jest.advanceTimersByTimeAsync(300);
    expect(onFailed).not.toHaveBeenCalled();
    expect(fetchStatus).toHaveBeenCalledTimes(1 + 3);

    await jest.advanceTimersByTimeAsync(100);
    expect(onFailed).toHaveBeenCalledWith(FEEDBACK_TIMEOUT_MESSAGE);
  });
});

// ──────────────────────────────────────────────────────────────
// stop と後始末
// ──────────────────────────────────────────────────────────────

describe('watchNutritionFeedback: stop() と後始末 (#1221)', () => {
  it('stop() でポーリング停止 + チャンネル除去。何度呼んでも removeChannel は 1 回で、以後は何も通知しない', async () => {
    const fetchStatus = stubFetchStatus([GENERATING]);
    const { supabase, client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    const stop = watchNutritionFeedback({ supabase: client, cacheId: 'cache-10', fetchStatus, onResolved, onFailed });
    await flush();
    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);
    const callsAtStop = fetchStatus.mock.calls.length;

    stop();
    stop();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 30);
    expect(fetchStatus.mock.calls.length).toBe(callsAtStop); // 止めたあとはもう叩かない
    expect(onResolved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled(); // タイムアウト通知も出ない
  });

  it('stop() の時点で応答待ちだった結果は捨てる (止めたあとに onResolved を呼ばない)', async () => {
    let release: (value: StatusResponse) => void = () => {};
    const fetchStatus = jest.fn(
      () =>
        new Promise<StatusResponse>((resolve) => {
          release = resolve;
        }),
    );
    const { client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    const stop = watchNutritionFeedback({ supabase: client, cacheId: 'cache-11', fetchStatus, onResolved, onFailed });
    await flush();
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    stop();
    release(COMPLETED);
    await flush();

    expect(onResolved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('stop() のあとに Realtime のイベントが届いても、通知しない', async () => {
    const { channels, client } = createFakeSupabase();
    const { onResolved, onFailed } = createHandlers();

    const stop = watchNutritionFeedback({
      supabase: client,
      cacheId: 'cache-11b',
      fetchStatus: stubFetchStatus([GENERATING]),
      onResolved,
      onFailed,
    });
    await flush();
    stop();
    channels[0].handler!({ new: { status: 'completed', feedback: JSON.stringify({ advice: 'A' }) } });
    channels[0].handler!({ new: { status: 'error', feedback: null } });

    expect(onResolved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('Realtime の購読で例外が出ても外へ投げず、ポーリングだけで結果を受け取る', async () => {
    const fetchStatus = stubFetchStatus([GENERATING, COMPLETED]);
    const { supabase, client } = createFakeSupabase({ onThrows: true });
    const { onResolved } = createHandlers();

    expect(() =>
      watchNutritionFeedback({ supabase: client, cacheId: 'cache-12', fetchStatus, onResolved, onFailed: jest.fn() }),
    ).not.toThrow();
    await flush();
    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);

    expect(onResolved).toHaveBeenCalledTimes(1);
    // 例外の出たチャンネルも取り残さない
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('Realtime が使えない (CHANNEL_ERROR) 状態でも、ポーリングで結果を受け取る', async () => {
    const fetchStatus = stubFetchStatus([GENERATING, COMPLETED]);
    const { client } = createFakeSupabase({ subscribeStatus: 'CHANNEL_ERROR' });
    const { onResolved, onFailed } = createHandlers();

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-12b', fetchStatus, onResolved, onFailed });
    await flush();
    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled(); // 黙って握りつぶさず、警告は残す
  });

  it('removeChannel が reject / throw しても、stop() は例外を出さない', async () => {
    const rejecting = createFakeSupabase({ removeChannelImpl: () => Promise.reject(new Error('socket closed')) });
    const stopRejecting = watchNutritionFeedback({
      supabase: rejecting.client,
      cacheId: 'cache-13',
      fetchStatus: stubFetchStatus([GENERATING]),
      ...createHandlers(),
    });
    expect(() => stopRejecting()).not.toThrow();
    await flush(); // reject が未処理にならない

    const throwing = createFakeSupabase({
      removeChannelImpl: () => {
        throw new Error('boom');
      },
    });
    const stopThrowing = watchNutritionFeedback({
      supabase: throwing.client,
      cacheId: 'cache-14',
      fetchStatus: stubFetchStatus([GENERATING]),
      ...createHandlers(),
    });
    expect(() => stopThrowing()).not.toThrow();
  });

  it('画面側のコールバックが例外を投げても、片付けは済んでいて、例外は外へ出ない', async () => {
    const fetchStatus = stubFetchStatus([GENERATING]);
    const { supabase, channels, client } = createFakeSupabase();
    const onResolved = jest.fn(() => {
      throw new Error('setState failed');
    });

    watchNutritionFeedback({ supabase: client, cacheId: 'cache-15', fetchStatus, onResolved, onFailed: jest.fn() });
    await flush();

    expect(() =>
      channels[0].handler!({ new: { status: 'completed', feedback: JSON.stringify({ advice: 'A' }) } }),
    ).not.toThrow();
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);

    const callsAtResolve = fetchStatus.mock.calls.length;
    await jest.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS * 5);
    expect(fetchStatus.mock.calls.length).toBe(callsAtResolve);
  });
});
