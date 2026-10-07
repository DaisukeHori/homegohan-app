import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  watchNutritionFeedback,
  type FeedbackRealtimeClient,
  type NutritionFeedbackContent,
} from "@/lib/nutrition-feedback-watch";

// AI栄養士フィードバックの取得 (POST) から結果待ち (Realtime + ポーリング) までの「持ち主」を決めるフック (#1206)。
//
// 以前は献立ページの useEffect の cleanup が `if (!showNutritionDetailModal && ...)` と state を見て
// 解除するかどうかを決めていた。cleanup は effect 作成時点のクロージャで動くため、
// 「モーダルを開いたまま別ページへ移動 (アンマウント)」では常に「まだ開いている」と判断され、
// Realtime チャンネルもポーリングも解除されなかった。
// このフックでは state ではなく ref を見て、次のどれが起きても購読/ポーリングを必ず解除する。
//   - アンマウント
//   - フィードバックを見せているモーダル (栄養詳細 / サマリー) がすべて閉じた
//   - 別の取得が始まった (新しい取得が前の取得を置き換える)
// また、POST の応答を待っている間にこれらが起きた場合は、応答が戻ってから購読を張ってしまわないよう
// 「この取得はもう現役ではない」と呼び出し側 (request.isCurrent()) に伝える。

export interface NutritionFeedbackWatchHandlers {
  onResolved: (content: NutritionFeedbackContent) => void;
  onFailed: (message: string) => void;
}

/** startRequest() で始めた 1 回分の取得 */
export interface NutritionFeedbackRequest {
  /**
   * この取得がまだ現役か。アンマウント・モーダルを閉じた・別の取得の開始のいずれかで false になる。
   * await のあとに確認し、false なら state を触らず購読も張らずに終わる。
   */
  isCurrent: () => boolean;
  /** 生成待ち (Realtime + ポーリング) を始める。現役でなければ何もしない */
  watch: (cacheId: string, handlers: NutritionFeedbackWatchHandlers) => void;
}

export interface UseNutritionFeedbackWatchOptions {
  supabase: FeedbackRealtimeClient;
  /** フィードバックを見せているモーダル (栄養詳細 / サマリー) のどれかが開いているか */
  isViewing: boolean;
  /** フィードバックを取得中 (スピナー表示中) か */
  isLoading: boolean;
  /**
   * 取得中のままモーダルがすべて閉じられ、結果待ちをやめたときに呼ばれる。
   * スピナー表示を戻し、次に開いたとき取得し直せるようにする (戻さないと、同じ日を開き直しても
   * 再取得されずスピナーが止まらなくなる)。アンマウント時は呼ばない。
   */
  onAbandoned: () => void;
}

export function useNutritionFeedbackWatch({
  supabase,
  isViewing,
  isLoading,
  onAbandoned,
}: UseNutritionFeedbackWatchOptions) {
  const mountedRef = useRef(false);
  // 取得の世代。進めると、それ以前の取得は「現役ではない」ことになる
  const generationRef = useRef(0);
  // 進行中の生成待ちを止める関数
  const stopWatchRef = useRef<(() => void) | null>(null);

  // effect から最新の値を読むための ref (古いクロージャを掴まないため)
  const latestRef = useRef({ supabase, isLoading, onAbandoned });
  useEffect(() => {
    latestRef.current = { supabase, isLoading, onAbandoned };
  });

  // 進行中の取得を無効にし、購読/ポーリングを解除する (唯一の解除口)
  const cancel = useCallback(() => {
    generationRef.current += 1;
    const stop = stopWatchRef.current;
    stopWatchRef.current = null;
    stop?.();
  }, []);

  // アンマウント時は state を見ずに無条件で解除する (モーダルを開いたままの離脱もここで拾う)
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancel();
    };
  }, [cancel]);

  // モーダルがすべて閉じたら結果待ちをやめる。
  // サマリー → 栄養詳細への切り替え (片方を閉じて片方を開く) は同じ更新で起きて isViewing が
  // true のまま変わらないので、ここは動かず、進行中の購読は引き継がれる。
  useEffect(() => {
    if (isViewing) return;
    cancel();
    if (latestRef.current.isLoading) {
      latestRef.current.onAbandoned();
    }
  }, [isViewing, cancel]);

  const startRequest = useCallback((): NutritionFeedbackRequest => {
    // 前の取得の購読/ポーリングを解除し、前の取得を現役でなくする
    cancel();
    const generation = generationRef.current;
    const isCurrent = () => mountedRef.current && generationRef.current === generation;

    return {
      isCurrent,
      watch: (cacheId, handlers) => {
        if (!isCurrent()) return;
        // 同じ取得で watch が 2 回呼ばれても、前の購読/ポーリングを取り残さない
        stopWatchRef.current?.();
        stopWatchRef.current = watchNutritionFeedback({
          supabase: latestRef.current.supabase,
          cacheId,
          onResolved: handlers.onResolved,
          onFailed: handlers.onFailed,
        });
      },
    };
  }, [cancel]);

  return useMemo(() => ({ startRequest }), [startRequest]);
}
