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
 * 読み取りの種類 (#2206 G1)。
 *   - 'mount': ページが始めた読み取り (開いたとき・対象の切り替え・書き込みのあとの読み直し)。応答は番兵を見ずに置く。
 *     失敗は失敗の表示を置く (置くのも place の中)
 *   - 'refetch': AI 相談の成功 (と献立の生成の完了) の取り直し。hook が始める。応答を置く直前に番兵・書き込みの印を見る。
 *     失敗では何も置かない (今の表示を残す)。読み込み中の表示を立てない
 */
export type AiConsultationReadMode = "mount" | "refetch";

/**
 * place の結果。'superseded' = 同じ鍵にもっと新しい読み取りが置いたあと (または hook がもう外れた)。
 * 'deferred' = 取り直しの応答を番兵・書き込みの印で置かなかった (止めた通知の印は付けた。外れたら 1 回取り直す)
 */
export type AiConsultationPlaceResult = "placed" | "superseded" | "deferred";

/** 1 回の読み取りにページが使えるもの (順序・番兵・読み込み中の印の判断は全部 place の中) */
export interface AiConsultationRead {
  readonly mode: AiConsultationReadMode;
  /**
   * 応答を置く。key は置き場所の名前 (対象を替えて出す表示は対象を含める)。apply は state・store・router への反映。
   * 鍵ごとに「置いた世代より新しい (同じ読み取りを含む)」ときだけ apply を呼ぶ。取り直しなら番兵・書き込みの印も見る。
   * apply が戻ってから置いた世代を進め、その鍵の読み込み中の印を下ろす
   */
  readonly place: (key: string, apply: () => void) => AiConsultationPlaceResult;
}

export interface AiConsultationReadOptions {
  /** 読み込み中の表示を立てる鍵。鍵が置かれたとき、またはこの読み取りが終わったときに下ろす */
  readonly loadingKeys?: readonly string[];
}

export type AiConsultationReadFn = (read: AiConsultationRead) => unknown;

/**
 * 受け手ごとに 1 回だけ使う設定。最初の描画でだけ読む (あとから変えても効かない)
 */
export interface AiConsultationReceiverOptions {
  /**
   * 最初の描画から読み込み中にする鍵 (今の受け手の読み込み中の表示の初期値 true を引き継ぐ。§9.3)。
   * 開いたときの読み取り (receiver.read) の loadingKeys に同じ鍵を入れる (その読み取りの終わりか、鍵が置かれたときに下りる)
   */
  readonly initialLoadingKeys?: readonly string[];
}

/** 受け手の公開の面。参照は受け手の一生で変わらない (useEffect の依存に入れても、読み込み中の鍵の変化で effect は走り直さない) */
export interface AiConsultationReceiver {
  /** ページが読み取りを 1 つ始める。fn が終わる (投げても) までが読み取り */
  readonly read: (options: AiConsultationReadOptions, fn: AiConsultationReadFn) => Promise<void>;
  /** 書き込みを 1 つ始める。返す関数を finally で呼ぶ (2 回呼んでも 1 回しか効かない) */
  readonly beginWrite: () => () => void;
  /** その鍵の読み込み中の表示を出すか。描画の中で直に呼ぶ (鍵の表が変わると受け手を描画し直す) */
  readonly isLoading: (key: string) => boolean;
}

/** initialLoadingKeys の鍵の立て主の世代 (どの読み取りも始めていない世代。読み取りの世代は 1 から数える) */
const INITIAL_LOADING_GENERATION = 0;

/**
 * 書き込みが 1 つでも進んでいる間、document.documentElement に付ける属性 (値は全受け手の合計)。
 * モバイルの読み込み直し (apps/mobile/src/lib/webViewBridge.ts) が止める要素として見る。Web の番兵は見ない
 */
export const AI_CONSULTATION_WRITES_ATTRIBUTE = "data-ai-consultation-writes";

let documentWriteCount = 0;

function syncDocumentWriteAttribute(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (documentWriteCount > 0) root.setAttribute(AI_CONSULTATION_WRITES_ATTRIBUTE, String(documentWriteCount));
  else root.removeAttribute(AI_CONSULTATION_WRITES_ATTRIBUTE);
}

function markDocumentWrite(): () => void {
  documentWriteCount += 1;
  syncDocumentWriteAttribute();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    documentWriteCount -= 1;
    syncDocumentWriteAttribute();
  };
}

/** テスト用: いま進んでいる書き込みの数 (全受け手の合計) */
export function aiConsultationDocumentWriteCountForTests(): number {
  return documentWriteCount;
}

interface ActiveRead {
  readonly read: AiConsultationRead;
  readonly end: () => void;
}

/**
 * AI 相談の成功の取り直しの受け手 (#2206 G1)。受け手のページ・部品・hook はこれだけを使う。
 * refetch は取り直しのたびに呼ばれる (描画のたびに作り直してよい)。
 * 順序・番兵・書き込みの印・止めた通知・読み込み中の印の判断は全部この中 (ページは鍵を決めて place で置き、書き込みを窓で囲む)
 */
export function useAiConsultationReceiver(
  refetch: AiConsultationReadFn,
  options: AiConsultationReceiverOptions = {},
): AiConsultationReceiver {
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  });

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 最後に始めた読み取りの世代 (ページの読み取りも取り直しも同じ数) */
  const generationRef = useRef(0);
  /** 鍵ごとの、置いた読み取りのうち最も新しい世代 */
  const placedRef = useRef(new Map<string, number>());
  /** 読み込み中の鍵 → それを最後に立てた読み取りの世代 (最初の描画の initialLoadingKeys は INITIAL_LOADING_GENERATION) */
  const [initialLoadingCarriers] = useState(
    () =>
      new Map<string, number>(
        (options.initialLoadingKeys ?? []).map((key) => [key, INITIAL_LOADING_GENERATION] as const),
      ),
  );
  const loadingCarriersRef = useRef(initialLoadingCarriers);
  /**
   * 鍵の表が変わった回数。変わったら受け手を描画し直すためだけの state (isLoading は鍵の表 (ref) を読むので、
   * isLoading と receiver の参照は変わらない。#2206 G1: 参照が変わると、receiver を依存に持つ開いたときの effect が走り直し続ける)
   */
  const [, setLoadingVersion] = useState(0);
  const syncLoadingKeys = useCallback(() => {
    if (!mountedRef.current) return;
    setLoadingVersion((version) => version + 1);
  }, []);

  /** 進んでいる書き込みの数と、始めた回数 */
  const writeCountRef = useRef(0);
  const writesStartedRef = useRef(0);
  /** 止めた通知の取り直しを試みる関数 (購読の間だけ入る) */
  const flushDeferredRef = useRef<() => void>(() => undefined);
  /** 取り直しの応答を置かなかったときに、止めた通知の印を付ける関数 (購読の間だけ入る) */
  const deferRefetchRef = useRef<() => void>(() => undefined);

  const isHeld = useCallback(() => isAiConsultationRefetchBlocked(document) || writeCountRef.current > 0, []);

  const beginRead = useCallback(
    (mode: AiConsultationReadMode, keys: readonly string[]): ActiveRead => {
      generationRef.current += 1;
      const generation = generationRef.current;
      const writesStartedAtBegin = writesStartedRef.current;
      /** この取り直しが一度 'deferred' を返したか (以後は全部 'deferred'。印を付けるのは 1 回) */
      let deferred = false;
      /** 鍵の表に新しく入った鍵があるか (立て主が替わるだけなら isLoading は変わらないので描画し直さない) */
      let added = false;
      for (const key of keys) {
        if (!loadingCarriersRef.current.has(key)) added = true;
        loadingCarriersRef.current.set(key, generation);
      }
      if (added) syncLoadingKeys();
      const place = (key: string, apply: () => void): AiConsultationPlaceResult => {
        if (!mountedRef.current) return "superseded";
        if (generation < (placedRef.current.get(key) ?? 0)) return "superseded";
        if (mode === "refetch") {
          if (deferred) return "deferred";
          if (isHeld() || writesStartedRef.current !== writesStartedAtBegin) {
            deferred = true;
            deferRefetchRef.current();
            return "deferred";
          }
        }
        apply();
        placedRef.current.set(key, generation);
        if (loadingCarriersRef.current.delete(key)) syncLoadingKeys();
        return "placed";
      };
      const end = () => {
        let changed = false;
        for (const key of keys) {
          if (loadingCarriersRef.current.get(key) !== generation) continue;
          loadingCarriersRef.current.delete(key);
          changed = true;
        }
        if (changed) syncLoadingKeys();
      };
      return { read: { mode, place }, end };
    },
    [isHeld, syncLoadingKeys],
  );

  const read = useCallback(
    async (options: AiConsultationReadOptions, fn: AiConsultationReadFn): Promise<void> => {
      const active = beginRead("mount", options.loadingKeys ?? []);
      try {
        await fn(active.read);
      } finally {
        active.end();
      }
    },
    [beginRead],
  );

  const beginWrite = useCallback((): (() => void) => {
    writeCountRef.current += 1;
    writesStartedRef.current += 1;
    const unmarkDocument = markDocumentWrite();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      writeCountRef.current -= 1;
      unmarkDocument();
      if (writeCountRef.current > 0) return;
      flushDeferredRef.current();
    };
  }, []);

  useEffect(() => {
    /** 購読の間か (離れたあとに届いた応答では印を付けない・取り直さない) */
    let active = true;
    const runRefetch = () => {
      const current = beginRead("refetch", []);
      void (async () => {
        try {
          await refetchRef.current(current.read);
        } catch (error) {
          // 取り直しの失敗はページが今の表示を残す (何も置かない)。ここでは未処理の Promise 拒否にしないだけ
          console.warn("[ai-consultation-refetch] refetch failed:", error);
        } finally {
          current.end();
        }
      })();
    };

    /** 止めた通知があるか (止めている間に何回来ても 1 つ) */
    let deferred = false;
    let observer: MutationObserver | null = null;
    const stopObserving = () => {
      observer?.disconnect();
      observer = null;
    };
    const flushDeferred = () => {
      if (!active || !deferred || isHeld()) return;
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
    /** 取り直しの応答を置かなかった: 印を付け、外れていればすぐ 1 回取り直す */
    const deferRefetch = () => {
      if (!active) return;
      deferred = true;
      if (isHeld()) {
        startObserving();
        return;
      }
      flushDeferred();
    };
    const refetchUnlessHeld = () => {
      if (isHeld()) {
        deferred = true;
        startObserving();
        return;
      }
      runRefetch();
    };
    flushDeferredRef.current = flushDeferred;
    deferRefetchRef.current = deferRefetch;

    /** 見張っている生成の見張りをやめる関数 (離れるときに全部やめる) */
    const stopWatching = new Set<() => void>();
    const onDataChanged = (event: Event) => {
      refetchUnlessHeld();
      const requestId = aiConsultationAcceptedGenerationRequestIdOf(event instanceof CustomEvent ? event.detail : null);
      if (requestId === null) return;
      const stop = watchAiConsultationGeneration(requestId, () => {
        stopWatching.delete(stop);
        refetchUnlessHeld();
      });
      stopWatching.add(stop);
    };
    window.addEventListener(AI_CONSULTATION_DATA_CHANGED_EVENT, onDataChanged);
    return () => {
      active = false;
      window.removeEventListener(AI_CONSULTATION_DATA_CHANGED_EVENT, onDataChanged);
      for (const stop of stopWatching) stop();
      stopWatching.clear();
      deferred = false;
      stopObserving();
      flushDeferredRef.current = () => undefined;
      deferRefetchRef.current = () => undefined;
    };
  }, [beginRead, isHeld]);

  /** 鍵の表 (ref) を読む。依存が無いので参照は一生同じ (描画し直しは syncLoadingKeys の版数が受け持つ) */
  const isLoading = useCallback((key: string) => loadingCarriersRef.current.has(key), []);

  // read・beginWrite・isLoading はどれも依存が変わらない useCallback なので、receiver の参照は受け手の一生で同じ
  return useMemo(() => ({ read, beginWrite, isLoading }), [read, beginWrite, isLoading]);
}
