"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AI_CONSULTATION_DATA_CHANGED_EVENT,
  AI_CONSULTATION_DEFERRED_REFETCH_OBSERVED_ATTRIBUTES,
  isAiConsultationRefetchBlocked,
} from "@/lib/ai/consultation-data-refetch";
import {
  aiConsultationAcceptedGenerationRequestIdOf,
  watchAiConsultationGeneration,
} from "@/lib/ai/consultation-generation-watch";

/**
 * 1 回の取得 (開いたときの読み込み・取り直し) の札 (#2201 U1)。
 * isLatest() が false になったら、その取得のあとに別の取得が始まっている: 応答を画面に置かない (最後に始めた取得の応答だけを置く)
 */
export interface AiConsultationFetchTicket {
  readonly isLatest: () => boolean;
}

/** 書き込みの間を知らせる印 (ページの useRef。書き込みを始めたら true、終わったら false にする) */
export interface AiConsultationWriteInFlightRef {
  readonly current: boolean;
}

export interface AiConsultationRefetchOptions {
  /**
   * ページの書き込み (楽観的な更新と、その送信の応答まで) の間 true の印 (#2201 U2)。
   * true の間に来た通知 (と献立の生成の完了) では取り直さず、止めた印を付ける。書き込みが終わったら
   * (印を false に戻したあと) notifyWriteSettled を呼ぶと、止めた通知のぶん 1 回だけ取り直す
   */
  writeInFlightRef?: AiConsultationWriteInFlightRef;
}

export interface AiConsultationRefetchControl {
  /**
   * 取得を始める: 世代を 1 つ進め、その取得の札を返す (#2201 U1)。ページの取得 (開いたとき・週の移動など) でも呼ぶ。
   * 取り直し (refetch) には hook がこれで作った札を渡す。札の isLatest() が false の応答は置かない
   */
  beginFetch: () => AiConsultationFetchTicket;
  /**
   * 書き込みが終わったら (writeInFlightRef を false に戻したあと) 呼ぶ (#2201 U2)。書き込みの間に止めた通知があれば、
   * 番兵 (isAiConsultationRefetchBlocked) が外れていれば 1 回だけ取り直す (外れていなければ、外れたときに取り直す)
   */
  notifyWriteSettled: () => void;
}

/**
 * Web の AI 相談の提案の実行でデータが変わったら (AI_CONSULTATION_DATA_CHANGED_EVENT)、refetch を呼ぶ (#2195 V1)。
 * 入力の部品・開いているモーダルがページにある間は呼ばない (isAiConsultationRefetchBlocked。AI 相談の吹き出しの中と、
 * 何も変えていない入力欄の部品の中 (AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE) の入力の部品は数えない)。
 * refetch にはページの既存の取得の関数を渡す (ページ全体の reload はしない)。
 * refetch は描画のたびに作り直してよい (最新のものを呼ぶ。購読はし直さない)。
 *
 * 通知が献立の生成の受付 (detail.result が { requestId, status: 'processing' }。generate_day_menu・generate_week_menu・
 * generate_single_meal) なら、献立は裏の処理が後から書くので、その依頼を生成が終わるまで見張り
 * (src/lib/ai/consultation-generation-watch.ts の watchAiConsultationGeneration)、終わったらもう一度 refetch を呼ぶ。
 * 完了のときにも同じ番兵・書き込みの印・世代番号・失敗の扱いを効かせる。ページを離れたら (アンマウント) 見張りをやめる
 *
 * 取り直しの決まり (#2201 U1 + U2):
 *   - 世代番号: 取り直しのたびに beginFetch で札を作って refetch に渡す。ページは開いたときの読み込みなどでも beginFetch を呼び、
 *     応答を置く前に札の isLatest() を見る (古い応答が後から届いても新しい表示を上書きしない)
 *   - 失敗: refetch が reject しても (同期で投げても) 拾って握る (未処理の Promise 拒否にしない)。
 *     ページは取り直しの失敗 (通信の失敗・5xx など) では今の表示を残す (取り直しの経路でだけ。開いたときの失敗はこれまでどおり)
 *   - 読み込み中の表示: 取り直しでは loading を立てない (画面全体をスピナーに置き換えない)。開いたときだけ出す
 *   - 止めた通知: 番兵 (入力の部品・モーダル) か書き込みの印 (writeInFlightRef) で止めた通知は捨てずに印を付け、
 *     番兵が外れたとき (DOM の変化で見る: モーダルを閉じた・入力の部品が消えた) / 書き込みが終わったとき (notifyWriteSettled) に
 *     1 回だけ取り直す。止めている間に何回通知が来ても、取り直しは 1 回
 */
export function useAiConsultationDataRefetch(
  refetch: (ticket: AiConsultationFetchTicket) => unknown,
  options: AiConsultationRefetchOptions = {},
): AiConsultationRefetchControl {
  const refetchRef = useRef(refetch);
  const writeInFlightRefRef = useRef(options.writeInFlightRef);
  useEffect(() => {
    refetchRef.current = refetch;
    writeInFlightRefRef.current = options.writeInFlightRef;
  });

  /** 最後に始めた取得の世代 */
  const generationRef = useRef(0);
  const beginFetch = useCallback((): AiConsultationFetchTicket => {
    generationRef.current += 1;
    const generation = generationRef.current;
    return { isLatest: () => generationRef.current === generation };
  }, []);

  /** 止めた通知の取り直しを、いま試みる関数 (購読の間だけ入る。書き込みが終わったときに呼ぶ) */
  const flushDeferredRef = useRef<() => void>(() => undefined);
  const notifyWriteSettled = useCallback(() => {
    flushDeferredRef.current();
  }, []);

  useEffect(() => {
    const isHeld = () =>
      isAiConsultationRefetchBlocked(document) || writeInFlightRefRef.current?.current === true;

    const runRefetch = () => {
      const ticket = beginFetch();
      try {
        void Promise.resolve(refetchRef.current(ticket)).catch((error: unknown) => {
          // 取り直しの失敗はページが今の表示を残す。ここでは未処理の Promise 拒否にしないだけ
          console.warn("[ai-consultation-refetch] refetch failed:", error);
        });
      } catch (error) {
        console.warn("[ai-consultation-refetch] refetch failed:", error);
      }
    };

    /** 止めた通知があるか (止めている間に何回来ても 1 つ) */
    let deferred = false;
    let observer: MutationObserver | null = null;
    const stopObserving = () => {
      observer?.disconnect();
      observer = null;
    };
    const flushDeferred = () => {
      if (!deferred || isHeld()) return;
      deferred = false;
      stopObserving();
      runRefetch();
    };
    const startObserving = () => {
      if (observer !== null || typeof MutationObserver === "undefined") return;
      observer = new MutationObserver(flushDeferred);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [...AI_CONSULTATION_DEFERRED_REFETCH_OBSERVED_ATTRIBUTES],
      });
    };
    flushDeferredRef.current = flushDeferred;

    const refetchUnlessHeld = () => {
      if (isHeld()) {
        deferred = true;
        startObserving();
        return;
      }
      runRefetch();
    };
    /** 見張っている生成の見張りをやめる関数 (アンマウントで全部やめる) */
    const stopWatching = new Set<() => void>();
    const onDataChanged = (event: Event) => {
      refetchUnlessHeld();
      const requestId = aiConsultationAcceptedGenerationRequestIdOf(
        event instanceof CustomEvent ? event.detail : null,
      );
      if (requestId === null) return;
      const stop = watchAiConsultationGeneration(requestId, () => {
        stopWatching.delete(stop);
        refetchUnlessHeld();
      });
      stopWatching.add(stop);
    };
    window.addEventListener(AI_CONSULTATION_DATA_CHANGED_EVENT, onDataChanged);
    return () => {
      window.removeEventListener(AI_CONSULTATION_DATA_CHANGED_EVENT, onDataChanged);
      for (const stop of stopWatching) stop();
      stopWatching.clear();
      deferred = false;
      stopObserving();
      flushDeferredRef.current = () => undefined;
    };
  }, [beginFetch]);

  return useMemo(() => ({ beginFetch, notifyWriteSettled }), [beginFetch, notifyWriteSettled]);
}

/** useAiConsultationRefetchKey の戻り値 */
export interface AiConsultationRefetchKeyState {
  /** 取り直すときに 1 つ増える数 (開いたときは 0) */
  refetchKey: number;
  /** 書き込みが終わったら呼ぶ (useAiConsultationDataRefetch の notifyWriteSettled と同じ) */
  notifyWriteSettled: () => void;
}

/**
 * useAiConsultationDataRefetch の、取得を useEffect の中に書いているページ向けの形 (#2195 V1)。
 * 取り直すときに 1 つ増える数 (refetchKey) を返す。ページはこれを取得の useEffect の依存に足す
 * (取得の関数を外へ出さずに、既存の取得をそのままもう一度走らせる)。献立の生成の完了でも 1 つ増える。
 * 番兵・書き込みの印で止めた通知は、外れたときに 1 回だけ増える (#2201 U2)。
 * ページは useEffect の後片付け (cleanup) で前の回の応答を捨てる (最後に走った回の応答だけを置く。#2201 U1)。
 * その回が取り直しで走ったかは useAiConsultationRefetchRun で見る (取り直しでは loading を立てず、失敗では今の表示を残す)
 */
export function useAiConsultationRefetchKey(options: AiConsultationRefetchOptions = {}): AiConsultationRefetchKeyState {
  const [refetchKey, setRefetchKey] = useState(0);
  const bump = useCallback(() => setRefetchKey((key) => key + 1), []);
  const { notifyWriteSettled } = useAiConsultationDataRefetch(bump, options);
  return useMemo(() => ({ refetchKey, notifyWriteSettled }), [refetchKey, notifyWriteSettled]);
}

/**
 * useAiConsultationRefetchKey の数を依存に持つ useEffect の、その回が取り直し (数が前の回から増えた) で走ったかを返す関数を作る (#2201 U1)。
 * 1 つの useEffect ごとに 1 つ作り、その useEffect の始めに 1 回だけ呼ぶ (ほかの依存 (期間・id の切り替え) だけで走った回は false =
 * 開いたときと同じ扱い)
 */
export function useAiConsultationRefetchRun(refetchKey: number): () => boolean {
  const handledKeyRef = useRef(refetchKey);
  return useCallback(() => {
    const isRefetch = handledKeyRef.current !== refetchKey;
    handledKeyRef.current = refetchKey;
    return isRefetch;
  }, [refetchKey]);
}

/** 同時に重なりうる書き込みを数える印 (useAiConsultationPendingWrites の戻り値) */
export interface AiConsultationPendingWrites extends AiConsultationWriteInFlightRef {
  /** 書き込みを 1 つ始める。返す関数をその書き込みの終わり (finally) で 1 回呼ぶ */
  readonly begin: () => () => void;
}

/**
 * 書き込みが重なりうるページ (一覧の行ごとの削除・チェックなど) の書き込みの印 (#2201 U2)。
 * useAiConsultationDataRefetch の writeInFlightRef に渡す。current は始めて終わっていない書き込みが 1 つでもある間 true
 * (真偽の ref 1 つだと、先に終わった書き込みが後の書き込みの途中で印を下ろしてしまう)
 */
export function useAiConsultationPendingWrites(): AiConsultationPendingWrites {
  const countRef = useRef(0);
  return useMemo<AiConsultationPendingWrites>(
    () => ({
      get current() {
        return countRef.current > 0;
      },
      begin: () => {
        countRef.current += 1;
        let ended = false;
        return () => {
          if (ended) return;
          ended = true;
          countRef.current -= 1;
        };
      },
    }),
    [],
  );
}
