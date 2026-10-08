// AI栄養フィードバックの「生成待ち」を Realtime + ポーリングのハイブリッドで見守る (#1221)。
//
// Web の src/lib/nutrition-feedback-watch.ts (#1206) のモバイル版。
// 栄養分析モーダル 2 種 (NutritionDetailModal / StatsModal) は、POST /api/ai/nutrition/feedback が返した
// cacheId で「生成が終わるまで」を待つ。以前はこの待ち受けが各モーダルと realtime.ts にバラバラに実装されており、
// どれも次の不具合を抱えていた。
//   - 本番に存在しない `ai_nutrition_feedback` テーブルを購読 / ポーリングしていた
//     (実テーブルは `nutrition_feedback_cache`)。イベントは永久に届かず、
//     5 秒ごとの失敗クエリはエラーを握り潰されたまま走り続けていた
//   - ポーリングの差分検出が「limit(1) の結果の件数 (0 か 1)」を覚えた件数と比べるだけで、
//     初回に 1 を記録すると二度と新しい行を検出できなかった
//   - payload に存在しない列 (summary / praise_comment / advice) を読んでおり、届いても表示できなかった
//   - 生成の失敗 (status=error) を検出できず、40 秒待ってから諦めていた
// ここでは「cacheId で 1 行を特定する」ことで差分検出そのものを不要にし、
// どの終わり方 (成功 / 失敗 / タイムアウト / 呼び出し側の stop) でも
// ポーリングの停止と Realtime チャンネルの除去が必ず行われることを 1 か所で保証する。
//
// - Realtime は高速化のための補助、ポーリングが確実な経路 (Realtime が張れなくても結果は届く)。
// - サーバーは LLM の完了を待ってから POST に応答することがあり (waitUntil が使えない環境)、
//   その場合、応答後に購読しても UPDATE は二度と届かない。そのため購読と同時に現在の状態を 1 回確認する。

import type { RealtimeChannel } from '@supabase/supabase-js';

/** ポーリング間隔 (フォールバック用) */
export const FEEDBACK_POLL_INTERVAL_MS = 2000;
/** ポーリングの上限回数 (2 秒 × 20 回 = 40 秒で諦める) */
export const FEEDBACK_MAX_POLLS = 20;
export const FEEDBACK_ERROR_MESSAGE = '分析中にエラーが発生しました。再分析をお試しください。';
export const FEEDBACK_TIMEOUT_MESSAGE = '分析がタイムアウトしました。再分析をお試しください。';

/** 画面に出すフィードバックの 3 要素 */
export interface NutritionFeedbackContent {
  advice: string;
  praiseComment: string | null;
  nutritionTip: string | null;
}

/** GET /api/ai/nutrition/feedback?cacheId= の応答 (使う項目だけ) */
export interface NutritionFeedbackStatusResponse {
  status?: string;
  feedback?: string | null;
  praiseComment?: string | null;
  advice?: string | null;
  nutritionTip?: string | null;
}

/** watch が使う Supabase クライアントの最小部分 (テストで差し替えやすくするため) */
export interface FeedbackRealtimeClient {
  channel: (name: string) => RealtimeChannel;
  removeChannel: (channel: RealtimeChannel) => unknown;
}

export interface WatchNutritionFeedbackOptions {
  supabase: FeedbackRealtimeClient;
  /** POST /api/ai/nutrition/feedback が返した nutrition_feedback_cache.id */
  cacheId: string;
  /** 現在の状態を 1 回取得する (GET /api/ai/nutrition/feedback?cacheId=...)。失敗 (throw) は次回のポーリングに任せる */
  fetchStatus: (cacheId: string) => Promise<NutritionFeedbackStatusResponse>;
  /** 生成が完了したとき (1 回だけ) */
  onResolved: (content: NutritionFeedbackContent) => void;
  /** 生成の失敗・タイムアウトのとき (1 回だけ)。画面に出すメッセージを渡す */
  onFailed: (message: string) => void;
  pollIntervalMs?: number;
  maxPolls?: number;
}

type FeedbackColumn = { advice?: string; praiseComment?: string; nutritionTip?: string };

/** 同じ cacheId を複数のモーダルが同時に待っても、Realtime のトピック名が衝突しないようにする連番 */
let channelSeq = 0;

/**
 * nutrition_feedback_cache.feedback の文字列を読み替える。
 * 新形式は JSON ({ praiseComment, advice, nutritionTip })、古い行はただの文字列。
 */
function parseFeedbackColumn(raw: string): FeedbackColumn {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as FeedbackColumn;
  } catch {
    // 旧形式の文字列フィードバック
  }
  return { advice: raw };
}

/** Realtime チャンネルを外す。外す処理の失敗 (切断済みなど) を未処理の reject / 例外にしない */
function removeChannelSafely(supabase: FeedbackRealtimeClient, channel: RealtimeChannel): void {
  try {
    Promise.resolve(supabase.removeChannel(channel)).catch((e) => {
      console.warn('[nutrition-feedback-watch] failed to remove channel:', e);
    });
  } catch (e) {
    console.warn('[nutrition-feedback-watch] failed to remove channel:', e);
  }
}

/**
 * フィードバック生成の完了を Realtime + ポーリングで待つ。戻り値は stop 関数。
 *
 * - 成功・失敗・タイムアウトのいずれで終わるときも、先にポーリング停止 + チャンネル除去をしてから
 *   onResolved / onFailed を 1 回だけ呼ぶ。
 * - stop() は何度呼んでも安全。stop() 後に届いた応答 (遅れて返ってきたポーリング結果など) は捨てる。
 * - 上限回数 (maxPolls) を使い切った次の周期で onFailed(タイムアウト) を呼ぶ。
 *   応答が返ってこない (ハング) 通信があっても、時間が来れば必ず諦める。
 */
export function watchNutritionFeedback(options: WatchNutritionFeedbackOptions): () => void {
  const {
    supabase,
    cacheId,
    fetchStatus,
    onResolved,
    onFailed,
    pollIntervalMs = FEEDBACK_POLL_INTERVAL_MS,
    maxPolls = FEEDBACK_MAX_POLLS,
  } = options;

  let stopped = false;
  let pollCount = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let channel: RealtimeChannel | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (channel) {
      const target = channel;
      channel = null;
      removeChannelSafely(supabase, target);
    }
  };

  // 終わり方がどれでも、先に購読/ポーリングを片付けてから結果を通知する (通知は 1 回だけ)
  const finish = (notify: () => void) => {
    if (stopped) return;
    stop();
    try {
      notify();
    } catch (e) {
      // 画面側のコールバックの失敗で、未処理の reject を出さない
      console.error('[nutrition-feedback-watch] callback failed:', e);
    }
  };

  // 現在の状態を 1 回確認する。完了 / 失敗なら終了し、生成中なら何もしない (次の通知かポーリングを待つ)
  const checkOnce = async () => {
    let data: NutritionFeedbackStatusResponse;
    try {
      data = await fetchStatus(cacheId);
    } catch {
      // 一時的な通信エラーは無視して、次のポーリングに任せる
      return;
    }
    if (stopped || !data) return; // 応答を待つ間に止められた

    if (data.status === 'completed' && (data.feedback || data.praiseComment)) {
      finish(() =>
        onResolved({
          advice: data.advice || data.feedback || '',
          praiseComment: data.praiseComment || null,
          nutritionTip: data.nutritionTip || null,
        }),
      );
    } else if (data.status === 'error') {
      finish(() => onFailed(data.advice || data.feedback || FEEDBACK_ERROR_MESSAGE));
    }
  };

  // ポーリング（確実な経路）
  pollTimer = setInterval(() => {
    if (stopped) return;
    if (pollCount >= maxPolls) {
      finish(() => onFailed(FEEDBACK_TIMEOUT_MESSAGE));
      return;
    }
    pollCount++;
    void checkOnce();
  }, pollIntervalMs);

  // Realtime も設定（より高速な通知のため）。nutrition_feedback_cache は supabase_realtime publication に
  // 登録済みで、RLS により自分の行の UPDATE だけが届く。
  try {
    channelSeq += 1;
    const realtimeChannel = supabase.channel(`nutrition-feedback-${cacheId}-${channelSeq}`);
    // 以降のどこで例外が起きても stop() で除去できるよう、先に保持する
    channel = realtimeChannel;
    realtimeChannel
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'nutrition_feedback_cache',
          filter: `id=eq.${cacheId}`,
        },
        (payload: { new?: { status?: string; feedback?: string | null } }) => {
          if (stopped) return;

          const record = payload.new;
          if (!record) return;

          if (record.status === 'completed' && record.feedback) {
            const raw = record.feedback;
            const parsed = parseFeedbackColumn(raw);
            finish(() =>
              onResolved({
                advice: parsed.advice || raw,
                praiseComment: parsed.praiseComment || null,
                nutritionTip: parsed.nutritionTip || null,
              }),
            );
          } else if (record.status === 'error') {
            const raw = record.feedback || '';
            const parsed = parseFeedbackColumn(raw);
            finish(() => onFailed(parsed.advice || raw || FEEDBACK_ERROR_MESSAGE));
          }
        },
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // 通知は来ないがポーリングで結果は受け取れる
          console.warn('[nutrition-feedback-watch] realtime unavailable, polling only:', status);
        }
      });
  } catch (e) {
    // Realtime が張れなくても (例: 同名トピックの購読が残っていて .on() が例外を投げる場合)、
    // ポーリングだけで結果は受け取れる。例外を外へ出さずポーリングに任せる。
    console.warn('[nutrition-feedback-watch] realtime subscribe failed, polling only:', e);
  }

  // 購読を張った直後に現在の状態を確認する。サーバーが LLM の完了を待ってから POST に応答した場合、
  // その UPDATE は購読前に済んでいるため、通知を待っても届かない (次のポーリングまで 2 秒待たせない)
  void checkOnce();

  return stop;
}
