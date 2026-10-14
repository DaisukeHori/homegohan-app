// AI栄養士フィードバックの「生成待ち」を Realtime + ポーリングのハイブリッドで見守る (#1206)。
//
// 献立ページ (menus/weekly/page.tsx) はフィードバックの生成をサーバー側のバックグラウンド処理に任せ、
// 完了を nutrition_feedback_cache の UPDATE (Realtime) と 2 秒間隔の GET ポーリング (フォールバック) の
// 両方で待つ。以前はこの購読/ポーリングがページ本体にインライン実装されており、次の漏れがあった。
//   - 結果が届いても Realtime チャンネルは外されず、ポーリングだけが止まっていた
//   - モーダルを開いたまま別ページへ移動 (アンマウント) すると、購読もポーリングも解除されなかった
//     (cleanup が effect 作成時点の古い state を見て「まだモーダルが開いている」と判断していたため)
// ここでは「どの終わり方 (成功 / 失敗 / タイムアウト / 呼び出し側の stop) でも、
// ポーリングの停止と Realtime チャンネルの除去が必ず行われる」ことを 1 か所で保証する。

import type { RealtimeChannel } from '@supabase/supabase-js';

/** ポーリング間隔 (フォールバック用) */
export const FEEDBACK_POLL_INTERVAL_MS = 2000;
/** ポーリングの上限回数 (2 秒 × 20 回 = 40 秒でタイムアウト) */
export const FEEDBACK_MAX_POLLS = 20;
export const FEEDBACK_ERROR_MESSAGE = '分析中にエラーが発生しました。';
export const FEEDBACK_TIMEOUT_MESSAGE = '分析がタイムアウトしました。再分析をお試しください。';

/** 画面に出すフィードバックの 3 要素 */
export interface NutritionFeedbackContent {
  advice: string;
  praiseComment: string | null;
  nutritionTip: string | null;
}

/** watch が使う Supabase クライアントの最小部分 (テストで差し替えやすくするため) */
export interface FeedbackRealtimeClient {
  channel: (name: string) => RealtimeChannel;
  removeChannel: (channel: RealtimeChannel) => unknown;
}

export interface WatchNutritionFeedbackOptions {
  supabase: FeedbackRealtimeClient;
  cacheId: string;
  /** 生成が完了したとき (1 回だけ) */
  onResolved: (content: NutritionFeedbackContent) => void;
  /** 生成の失敗・タイムアウトのとき (1 回だけ)。画面に出すメッセージを渡す */
  onFailed: (message: string) => void;
  pollIntervalMs?: number;
  maxPolls?: number;
}

type FeedbackColumn = { advice?: string; praiseComment?: string; nutritionTip?: string };

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
      console.error('Failed to remove nutrition feedback channel:', e);
    });
  } catch (e) {
    console.error('Failed to remove nutrition feedback channel:', e);
  }
}

/**
 * フィードバック生成の完了を Realtime + ポーリングで待つ。戻り値は stop 関数。
 *
 * - Realtime は高速化のための補助、ポーリングが確実な経路 (Realtime が張れなくても結果は届く)。
 * - 成功・失敗・タイムアウトのいずれで終わるときも、先にポーリング停止 + チャンネル除去をしてから
 *   onResolved / onFailed を 1 回だけ呼ぶ。
 * - stop() は何度呼んでも安全。stop() 後に届いた応答 (遅れて返ってきたポーリング結果など) は捨てる。
 */
export function watchNutritionFeedback(options: WatchNutritionFeedbackOptions): () => void {
  const {
    supabase,
    cacheId,
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
    notify();
  };

  // ポーリング（フォールバック用）
  pollTimer = setInterval(async () => {
    if (stopped) return;

    pollCount++;

    try {
      const res = await fetch(`/api/ai/nutrition/feedback?cacheId=${encodeURIComponent(cacheId)}`);
      if (stopped) return; // 応答を待つ間に止められた
      if (res.ok) {
        const data = await res.json();
        if (stopped) return;

        if (data.status === 'completed' && (data.feedback || data.praiseComment)) {
          finish(() => {
            console.log('Nutrition feedback received via polling');
            onResolved({
              advice: data.advice || data.feedback || '',
              praiseComment: data.praiseComment || null,
              nutritionTip: data.nutritionTip || null,
            });
          });
          return;
        }
        if (data.status === 'error') {
          finish(() => onFailed(data.advice || data.feedback || FEEDBACK_ERROR_MESSAGE));
          return;
        }
      }
    } catch (e) {
      console.error('Polling error:', e);
    }

    // タイムアウト
    if (pollCount >= maxPolls) {
      finish(() => onFailed(FEEDBACK_TIMEOUT_MESSAGE));
    }
  }, pollIntervalMs);

  // Realtimeも設定（より高速な通知のため）
  try {
    const realtimeChannel = supabase.channel(`nutrition_feedback_${cacheId}`);
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
          console.log('Realtime update received:', record.status);

          if (record.status === 'completed' && record.feedback) {
            const raw = record.feedback;
            const parsed = parseFeedbackColumn(raw);
            finish(() => {
              console.log('Nutrition feedback received via Realtime');
              onResolved({
                advice: parsed.advice || raw,
                praiseComment: parsed.praiseComment || null,
                nutritionTip: parsed.nutritionTip || null,
              });
            });
          } else if (record.status === 'error') {
            const raw = record.feedback || '';
            const parsed = parseFeedbackColumn(raw);
            finish(() => onFailed(parsed.advice || raw || FEEDBACK_ERROR_MESSAGE));
          }
        }
      )
      .subscribe((status) => {
        console.log('Realtime subscription status:', status);
      });
  } catch (e) {
    // Realtime が張れなくても (例: 同名トピックの購読が残っていて .on() が例外を投げる場合)、
    // ポーリングだけで結果は受け取れる。例外を外へ出さずポーリングに任せる。
    console.error('Realtime subscribe failed, falling back to polling only:', e);
  }

  return stop;
}
