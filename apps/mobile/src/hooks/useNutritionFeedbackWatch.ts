import { useCallback, useEffect, useMemo, useRef } from 'react';

import { getApi } from '../lib/api';
import {
  watchNutritionFeedback,
  type NutritionFeedbackContent,
  type NutritionFeedbackStatusResponse,
} from '../lib/nutrition-feedback-watch';
import { supabase } from '../lib/supabase';

// AI栄養フィードバックの取得 (POST) から結果待ち (Realtime + ポーリング) までの「持ち主」を決めるフック (#1221)。
// Web の src/hooks/useNutritionFeedbackWatch.ts (#1206) のモバイル版で、栄養分析モーダル 2 種
// (NutritionDetailModal / StatsModal) が使う。
//
// 次のどれが起きても、購読とポーリングは必ず解除される。
//   - アンマウント
//   - cancel() (モーダルを閉じた / タブや日付を切り替えた)
//   - 別の取得が始まった (新しい取得が前の取得を置き換える)
// また、POST の応答を待っている間にこれらが起きた場合は、応答が戻ってから購読やポーリングを
// 始めてしまわないよう、呼び出し側に「この取得はもう現役ではない」と伝える (request.isCurrent())。
// 遅れて届いた応答で、閉じたモーダルや別の日の state を書き換えることも防ぐ。

export interface NutritionFeedbackWatchHandlers {
  /** 生成が完了したとき (1 回だけ) */
  onResolved: (content: NutritionFeedbackContent) => void;
  /** 生成の失敗・タイムアウトのとき (1 回だけ)。画面に出すメッセージを渡す */
  onFailed: (message: string) => void;
}

/** startRequest() で始めた 1 回分の取得 */
export interface NutritionFeedbackRequest {
  /**
   * この取得がまだ現役か。アンマウント・cancel()・別の取得の開始のいずれかで false になる。
   * await のあとに確認し、false なら state を触らず購読も張らずに終わる。
   */
  isCurrent: () => boolean;
  /** 生成待ち (Realtime + ポーリング) を始める。現役でなければ何もしない */
  watch: (cacheId: string, handlers: NutritionFeedbackWatchHandlers) => void;
}

/** GET /api/ai/nutrition/feedback?cacheId= で現在の状態を取る (認証付きの API クライアント経由) */
function fetchFeedbackStatus(cacheId: string): Promise<NutritionFeedbackStatusResponse> {
  return getApi().get<NutritionFeedbackStatusResponse>(
    `/api/ai/nutrition/feedback?cacheId=${encodeURIComponent(cacheId)}`,
  );
}

export function useNutritionFeedbackWatch() {
  // 初期値を true にしておく (呼び出し側の effect がこのフックの effect より先に走っても現役と判定されるように)
  const mountedRef = useRef(true);
  // 取得の世代。進めると、それ以前の取得は「現役ではない」ことになる
  const generationRef = useRef(0);
  // 進行中の生成待ちを止める関数
  const stopWatchRef = useRef<(() => void) | null>(null);

  // 進行中の取得を無効にし、購読/ポーリングを解除する (唯一の解除口)
  const cancel = useCallback(() => {
    generationRef.current += 1;
    const stop = stopWatchRef.current;
    stopWatchRef.current = null;
    stop?.();
  }, []);

  // アンマウント時は無条件で解除する
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancel();
    };
  }, [cancel]);

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
          supabase,
          cacheId,
          fetchStatus: fetchFeedbackStatus,
          onResolved: handlers.onResolved,
          onFailed: handlers.onFailed,
        });
      },
    };
  }, [cancel]);

  return useMemo(() => ({ startRequest, cancel }), [startRequest, cancel]);
}
