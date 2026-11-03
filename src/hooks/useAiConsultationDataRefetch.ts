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
  /**
   * 取り直しの応答を置く前に呼ぶ (#2201 U1 + U2)。番兵 (入力の部品・モーダル。isAiConsultationRefetchBlocked) か書き込みの印が
   * いま立っている、またはこの取り直しを始めたあとに書き込み (書き込みの印の startedCount) が始まっていれば true を返し、
   * 止めた通知の印を付ける (番兵・書き込みの印が外れたら 1 回取り直す。もう外れていれば、すぐに 1 回取り直す)。
   * true ならページは応答を置かない (取り直しで置く値のうち、利用者が変えうる値だけでなく全部)。
   * 番兵と書き込みの印は通知の時点にしか見ないので、取り直しの応答を待つあいだに開いたモーダル・打ち始めた入力・始めた書き込み
   * (楽観的な更新) を、届いた応答 (それより前に読んだ値) で上書きしないため。
   * ページが自分で始めた取得 (beginFetch の札) では常に false (その応答は置く)。取り直しが開いたときの読み込みの役を引き継いだ回
   * (useAiConsultationLoading の refetchReadMode() が 'mount'・useAiConsultationRefetchRun が false の回) では呼ばない
   * (残すべき今の表示がまだ無いので、応答を置く)。
   * 1 回 true を返した札は、そのあとも true を返し、止めた通知の印を付け直さない (1 つの取り直しの応答を何か所かに分けて置くページ
   * (献立表など) が置く場所ごとに呼んでも、取り直しを足すのは 1 回)。
   * 書き込みの印 (writeInFlightRef) を渡すページは、取り直しの経路で応答を置く場所の全部でこれを見る
   * (見ないと上の決まりが効かない。tests/ai-consultation-refetch-placement-guard-2201.test.ts がソースで数える)。
   * これを見るときは、その前に順序 (最後に始めた取得か。isLatest()・useEffect の後片付けの cancelled) も見る
   * (古い応答で止めた通知の印を付けない・古い応答を置かない)。取得の流れを何本も持つページ (献立表など) は
   * useAiConsultationFetchStream の place で 2 つをまとめて見る (置く場所ごとに 2 つを書き分けない。同じ検査がソースで数える)
   */
  readonly deferIfHeld: () => boolean;
}

/**
 * 書き込みの間を知らせる印 (ページの useRef。書き込みを始めたら true、終わったら false にする)。
 * subscribeSettled を持つ印 (useAiConsultationPendingWrites) は、書き込みが全部終わったことを自分で知らせる
 * (ページが notifyWriteSettled を呼ばなくてよい)
 */
export interface AiConsultationWriteInFlightRef {
  readonly current: boolean;
  /** 書き込みが全部終わったときに呼ぶ関数を登録する。返す関数で登録をやめる */
  readonly subscribeSettled?: (listener: () => void) => () => void;
  /**
   * 書き込みを始めた回数 (useAiConsultationPendingWrites)。取り直しを始めたあとに増えていれば、その取り直しの応答は書き込みの前の値を
   * 読んだかもしれないので置かない (札の deferIfHeld。書き込みがもう終わっていても)。持たない印 (真偽の ref) は、
   * 応答を置く時点で書き込みの間 (current) かだけを見る
   */
  readonly startedCount?: number;
}

export interface AiConsultationRefetchOptions {
  /**
   * ページの書き込み (楽観的な更新と、その送信の応答まで) の間 true の印 (#2201 U2)。
   * true の間に来た通知 (と献立の生成の完了) では取り直さず、止めた印を付ける。書き込みが終わったら
   * (印を false に戻したあと) notifyWriteSettled を呼ぶと、止めた通知のぶん 1 回だけ取り直す
   * (subscribeSettled を持つ印は、書き込みが全部終わったときに hook が自分で取り直す)。
   * 印は useAiConsultationPendingWrites で作る (始めた回数を数えるので、取り直しの応答を待つあいだに始めて終えた書き込みも
   * 札の deferIfHeld が見分ける)。真偽の ref を渡すのは、取り直しそのものが印を立てて書き込みを止めるページ (家族・譲渡の承諾の画面。
   * 取り直しの応答を待つあいだに書き込みが始まらない) だけ (tests/ai-consultation-refetch-placement-guard-2201.test.ts が数える)
   */
  writeInFlightRef?: AiConsultationWriteInFlightRef;
}

export interface AiConsultationRefetchControl {
  /**
   * 取得を始める: 世代を 1 つ進め、その取得の札を返す (#2201 U1)。ページの取得 (開いたとき・週の移動など) でも呼ぶ。
   * 取り直し (refetch) には hook が同じ世代を進めて作った札を渡す。札の isLatest() が false の応答は置かない。
   * この札の deferIfHeld() は常に false (ページが自分で始めた取得の応答は置く)
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
 *   - 世代番号: 取り直しのたびに (beginFetch と同じ世代を進めて) 札を作って refetch に渡す。ページは開いたときの読み込みなどでも
 *     beginFetch を呼び、応答を置く前に札の isLatest() を見る (古い応答が後から届いても新しい表示を上書きしない)。
 *     別々の取得を何本も持つページは、取得ごとに useAiConsultationFetchStream を作り、札を begin に渡して place で置く
 *   - 失敗: refetch が reject しても (同期で投げても) 拾って握る (未処理の Promise 拒否にしない)。
 *     ページは取り直しの失敗 (通信の失敗・5xx など) では今の表示を残す (取り直しの経路でだけ。開いたときの失敗はこれまでどおり)
 *   - 読み込み中の表示: 取り直しでは loading を立てない (画面全体をスピナーに置き換えない)。開いたときだけ出す。
 *     開いたときの読み込み中に始まった取り直しは、その読み込みの役 (失敗の表示・読み込み中の表示を下ろす) を引き継ぐ
 *     (useAiConsultationLoading / useAiConsultationRefetchRun の fullScreenLoading)
 *   - 止めた通知: 番兵 (入力の部品・モーダル) か書き込みの印 (writeInFlightRef) で止めた通知は捨てずに印を付け、
 *     番兵が外れたとき (DOM の変化で見る: モーダルを閉じた・入力の部品が消えた) / 書き込みが終わったとき (notifyWriteSettled) に
 *     1 回だけ取り直す。止めている間に何回通知が来ても、取り直しは 1 回
 *   - 応答を置く時点の番兵: 取り直しでは読み込み中の表示を出さないので、応答を待つあいだも入力欄・ボタンが出ている。
 *     ページは取り直しの応答を置く前に札の deferIfHeld() を見て、その間に開いたモーダル・打ち始めた入力・始めた書き込みがあれば
 *     置かない (止めた通知と同じく、外れたときに 1 回取り直す)
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
  /** 世代を 1 つ進め、その世代が最後の世代かを返す関数を返す */
  const nextGeneration = useCallback((): (() => boolean) => {
    generationRef.current += 1;
    const generation = generationRef.current;
    return () => generationRef.current === generation;
  }, []);
  // ページが自分で始めた取得の札。その応答は置く (応答を置く時点の番兵は見ない)
  const beginFetch = useCallback(
    (): AiConsultationFetchTicket => ({ isLatest: nextGeneration(), deferIfHeld: () => false }),
    [nextGeneration],
  );

  /** 止めた通知の取り直しを、いま試みる関数 (購読の間だけ入る。書き込みが終わったときに呼ぶ) */
  const flushDeferredRef = useRef<() => void>(() => undefined);
  const notifyWriteSettled = useCallback(() => {
    flushDeferredRef.current();
  }, []);

  // 書き込みが全部終わったことを自分で知らせる印 (useAiConsultationPendingWrites) なら、終わったときに止めた通知を取り直す
  const subscribeSettled = options.writeInFlightRef?.subscribeSettled;
  useEffect(() => {
    if (subscribeSettled === undefined) return undefined;
    return subscribeSettled(() => flushDeferredRef.current());
  }, [subscribeSettled]);

  useEffect(() => {
    /** 購読の間か (ページを離れたあとに届いた取り直しの応答では、取り直しを足さない) */
    let active = true;
    const isHeld = () =>
      isAiConsultationRefetchBlocked(document) || writeInFlightRefRef.current?.current === true;
    const writesStarted = () => writeInFlightRefRef.current?.startedCount;

    const runRefetch = () => {
      const isLatest = nextGeneration();
      const writesStartedAtBegin = writesStarted();
      /** この札が一度 true を返したか (置く場所ごとに呼ばれても、止めた通知の印を付けるのは 1 回) */
      let deferredByThisTicket = false;
      const ticket: AiConsultationFetchTicket = {
        isLatest,
        deferIfHeld: () => {
          if (deferredByThisTicket) return true;
          const writeStartedSinceBegin = writesStartedAtBegin !== undefined && writesStarted() !== writesStartedAtBegin;
          if (!isHeld() && !writeStartedSinceBegin) return false;
          deferredByThisTicket = true;
          if (active) deferRefetch();
          return true;
        },
      };
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
    /**
     * 取り直しの応答を置かなかった (札の deferIfHeld): 止めた通知の印を付け、番兵・書き込みの印が外れたら 1 回取り直す。
     * もう外れていれば (書き込みを始めて終えたあとに応答が届いた)、すぐに 1 回取り直す
     */
    const deferRefetch = () => {
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
      active = false;
      window.removeEventListener(AI_CONSULTATION_DATA_CHANGED_EVENT, onDataChanged);
      for (const stop of stopWatching) stop();
      stopWatching.clear();
      deferred = false;
      stopObserving();
      flushDeferredRef.current = () => undefined;
    };
  }, [nextGeneration]);

  return useMemo(() => ({ beginFetch, notifyWriteSettled }), [beginFetch, notifyWriteSettled]);
}

/**
 * 取得の流れの順序の決まり (#2201 U1。useAiConsultationFetchStream)。
 *   - 'latestStarted': 最後に始めた取得の応答だけを置く (古い応答は、あとの取得がまだ何も置いていなくても置かない)
 *   - 'newerThanPlaced': もう置いたどの応答よりあとに始めた取得の応答を置く (あとの取得が失敗した・まだ届いていないときは、
 *     先に始めた取得の応答も置く。献立表の表示中の週の献立: 週を移った直後の週の読み込みの応答を、そのあとに始めて失敗した
 *     読み直しのために捨てない)
 */
export type AiConsultationFetchStreamOrder = "latestStarted" | "newerThanPlaced";

/**
 * 流れの札の place の結果。'superseded' は順序の決まりで置かなかった (あとに始めた取得がある・もう新しい応答を置いた)、
 * 'deferred' は取り直しの札が止めた (番兵・書き込みの印。止めた通知の印は札が付けたので、外れたときに 1 回取り直す)
 */
export type AiConsultationPlaceResult = "placed" | "superseded" | "deferred";

/** 流れの中の 1 回の取得の札 (useAiConsultationFetchStream の begin が返す) */
export interface AiConsultationStreamTicket {
  /** この取得のあとに、同じ流れ (同じ鍵) で別の取得が始まっていないか (読み込み中の印を下ろすかの判断などに使う) */
  readonly isLatest: () => boolean;
  /**
   * 応答を置く: 順序の決まりを見て、通れば取り直しの札 (begin に渡したとき) の deferIfHeld を見て、どちらも通れば apply を呼ぶ。
   * 応答を置く場所は全部これを通す (順序と、応答を置く時点の番兵の 2 つを、置く場所ごとに書き分けない)。
   * 1 つの取得の応答を何か所かに分けて置くとき (段ごとに置く読み込み) は、置くたびに呼ぶ
   */
  readonly place: (apply: () => void) => AiConsultationPlaceResult;
}

/** 取得の流れ (useAiConsultationFetchStream の戻り値) */
export interface AiConsultationFetchStream {
  /**
   * 取得を 1 つ始める (世代を 1 つ進める)。refetchTicket は AI 相談の成功の取り直しの札 (useAiConsultationDataRefetch が取り直しの
   * 関数に渡す札。取り直しの経路でだけ渡す。開いたとき・週の移動・書き込みのあとの読み直しでは渡さない)。
   * key は 1 つの流れの中で別々に順序を持つ範囲 (月のカレンダーの範囲など。省けば 1 つ)
   */
  readonly begin: (refetchTicket?: AiConsultationFetchTicket | null, key?: string) => AiConsultationStreamTicket;
}

/** 鍵を省いた流れの鍵 */
const SINGLE_STREAM_KEY = "";

/**
 * 取得の流れ (#2201 U1 + U2)。1 つのページが別々の取得 (献立・冷蔵庫・人数の設定・家族など) を持ち、AI 相談の成功の取り直しが
 * そのどれも読み直すとき、流れごとに 1 つ作る (useAiConsultationDataRefetch の beginFetch の世代はページに 1 つなので、
 * 別々の取得の開いたときの読み込みが互いの札を古くしてしまう)。
 * 流れは世代番号を持ち、begin で始めた取得の応答を place で置く: 順序の決まり (order) で古い応答を置かず、取り直しの札があれば
 * 応答を置く時点の番兵・書き込みの印も見る (止めたら、外れたときに 1 回取り直す)。開いたときの読み込みと取り直しは同じ流れで始める
 * (開いたときの読み込みの応答が取り直しの応答より後に届いても、古い答えで上書きしない)。
 * ページに世代番号の数 (useRef の数) を書かず、これを使う
 */
export function useAiConsultationFetchStream(order: AiConsultationFetchStreamOrder = "latestStarted"): AiConsultationFetchStream {
  /** 鍵ごとの、最後に始めた取得の世代 */
  const startedRef = useRef(new Map<string, number>());
  /** 鍵ごとの、応答を置いた取得のうち最も新しい世代 */
  const placedRef = useRef(new Map<string, number>());
  return useMemo<AiConsultationFetchStream>(
    () => ({
      begin: (refetchTicket = null, key = SINGLE_STREAM_KEY) => {
        const generation = (startedRef.current.get(key) ?? 0) + 1;
        startedRef.current.set(key, generation);
        const isLatest = () => startedRef.current.get(key) === generation;
        const inOrder = () => (order === "latestStarted" ? isLatest() : generation > (placedRef.current.get(key) ?? 0));
        return {
          isLatest,
          place: (apply) => {
            // 順序を先に見る: 古い応答では止めた通知の印を付けない (あとの取得の応答が置かれる / 置かれた)
            if (!inOrder()) return "superseded";
            if (refetchTicket?.deferIfHeld()) return "deferred";
            if (generation > (placedRef.current.get(key) ?? 0)) placedRef.current.set(key, generation);
            apply();
            return "placed";
          },
        };
      },
    }),
    [order],
  );
}

/** useAiConsultationRefetchKey の戻り値 */
export interface AiConsultationRefetchKeyState {
  /** 取り直すときに 1 つ増える数 (開いたときは 0) */
  refetchKey: number;
  /** 書き込みが終わったら呼ぶ (useAiConsultationDataRefetch の notifyWriteSettled と同じ) */
  notifyWriteSettled: () => void;
  /**
   * 最後に数を増やした取り直しの札 (まだ増やしていなければ null。#2201 U1 + U2)。取り直しで走った回 (useAiConsultationRefetchRun が
   * true の回) の始めに取り、応答を置く前に deferIfHeld() を見る (応答を待つあいだに開いたモーダル・始めた書き込みを上書きしない)。
   * 前の回の応答を捨てるのは useEffect の後片付けなので、isLatest() は見なくてよい
   */
  refetchTicket: () => AiConsultationFetchTicket | null;
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
  const refetchTicketRef = useRef<AiConsultationFetchTicket | null>(null);
  const bump = useCallback((ticket: AiConsultationFetchTicket) => {
    refetchTicketRef.current = ticket;
    setRefetchKey((key) => key + 1);
  }, []);
  const refetchTicket = useCallback(() => refetchTicketRef.current, []);
  const { notifyWriteSettled } = useAiConsultationDataRefetch(bump, options);
  return useMemo(
    () => ({ refetchKey, notifyWriteSettled, refetchTicket }),
    [refetchKey, notifyWriteSettled, refetchTicket],
  );
}

/**
 * useAiConsultationRefetchKey の数を依存に持つ useEffect の、その回が取り直し (数が前の回から増えた) で走ったかを返す関数を作る (#2201 U1)。
 * 1 つの useEffect ごとに 1 つ作り、その useEffect の始めに 1 回だけ呼ぶ (ほかの依存 (期間・id の切り替え) だけで走った回は false =
 * 開いたときと同じ扱い)。
 * fullScreenLoading にはページの全画面の読み込み中の表示 (loading) を渡す。読み込み中の表示を出している間 (開いたとき・期間 / id の
 * 切り替えの回の応答待ち) に数が増えた回は false (= その回の役を引き継ぐ): 前の回は後片付けで応答を捨てられ、読み込み中の表示を
 * 下ろさないので、増えた回が取り直しの扱い (失敗では今の表示を残す) をすると、失敗を隠して何も無い画面や前の期間 / id の内容を出す。
 * 読み込み中の表示を持たない部品は渡さない (常に数が増えたかだけで決める)。
 * この hook は取得の useEffect より前に呼ぶ (読み込み中の表示を覚える useEffect が、取得の useEffect より先に走るように)
 */
export function useAiConsultationRefetchRun(refetchKey: number, fullScreenLoading = false): () => boolean {
  const handledKeyRef = useRef(refetchKey);
  const fullScreenLoadingRef = useRef(fullScreenLoading);
  useEffect(() => {
    fullScreenLoadingRef.current = fullScreenLoading;
  });
  return useCallback(() => {
    const keyChanged = handledKeyRef.current !== refetchKey;
    handledKeyRef.current = refetchKey;
    return keyChanged && !fullScreenLoadingRef.current;
  }, [refetchKey]);
}

/**
 * 読み方 (#2201 U1)。'mount' は全画面の読み込み中の表示を出す読み込み (開いたとき・「再試行」・期間の切り替えなど。失敗は失敗の表示を出す)、
 * 'refetch' は AI 相談の成功の取り直し (読み込み中の表示を出さない・失敗では今の表示を残す)
 */
export type AiConsultationReadMode = "mount" | "refetch";

/** useAiConsultationLoading の戻り値 */
export interface AiConsultationLoadingState {
  /** 全画面の読み込み中の表示を出しているか */
  readonly loading: boolean;
  readonly setLoading: (loading: boolean) => void;
  /**
   * 取り直しの読み方。取り直しの始めに 1 回呼ぶ。読み込み中の表示を出している間は 'mount' (残すべき今の表示がまだ無いので、
   * 失敗は開いたときと同じく失敗の表示を出す)、出していなければ 'refetch'
   */
  readonly refetchReadMode: () => AiConsultationReadMode;
  /**
   * 取得が終わったら呼ぶ (開いたときの読み込みと取り直しの両方。別の画面へ移るときは呼ばない)。
   * 札が最後の札なら読み込み中の表示を下ろす
   */
  readonly settleLoading: (ticket: AiConsultationFetchTicket) => void;
}

/**
 * 全画面の読み込み中の表示 (loading) を持ち、取得の札 (beginFetch) を使うページの、読み込み中の表示と AI 相談の成功の取り直しの
 * 受け渡し (#2201 U1)。
 * 読み込み中の表示を出している間に取り直しが始まると、出していた読み込み (開いたとき・「再試行」など) の札は最後の札でなくなり、
 * その読み込みは応答を置かず、読み込み中の表示も下ろさない。そのときは取り直しがその読み込みの役を引き継ぐ:
 * 取り直しの読み方は 'mount' にし (refetchReadMode)、取り直しの側も終わったら settleLoading を呼ぶ (最後の札なら読み込み中の表示を下ろす)。
 * 下ろす判断はここに 1 つにまとめる (ページごとに「最後の札なら下ろす」を書き分けると、取り直しの側の下ろし忘れで読み込み中の表示のまま止まる)
 */
export function useAiConsultationLoading(): AiConsultationLoadingState {
  const [loading, setLoadingState] = useState(true);
  // 取り直しの始め (描画の前でもありうる) に今の値を見るための写し。setLoading の中で同時に変える
  const loadingRef = useRef(true);
  const setLoading = useCallback((next: boolean) => {
    loadingRef.current = next;
    setLoadingState(next);
  }, []);
  const refetchReadMode = useCallback((): AiConsultationReadMode => (loadingRef.current ? "mount" : "refetch"), []);
  const settleLoading = useCallback(
    (ticket: AiConsultationFetchTicket) => {
      if (ticket.isLatest()) setLoading(false);
    },
    [setLoading],
  );
  return useMemo(
    () => ({ loading, setLoading, refetchReadMode, settleLoading }),
    [loading, setLoading, refetchReadMode, settleLoading],
  );
}

/** 同時に重なりうる書き込みを数える印 (useAiConsultationPendingWrites の戻り値) */
export interface AiConsultationPendingWrites extends AiConsultationWriteInFlightRef {
  /** 書き込みを 1 つ始める。返す関数をその書き込みの終わり (finally) で 1 回呼ぶ */
  readonly begin: () => () => void;
  readonly subscribeSettled: (listener: () => void) => () => void;
  readonly startedCount: number;
}

/**
 * 書き込みが重なりうるページ (一覧の行ごとの削除・チェックなど) の書き込みの印 (#2201 U2)。
 * useAiConsultationDataRefetch の writeInFlightRef に渡す。current は始めて終わっていない書き込みが 1 つでもある間 true
 * (真偽の ref 1 つだと、先に終わった書き込みが後の書き込みの途中で印を下ろしてしまう)。
 * 最後の書き込みが終わったら、登録した関数 (useAiConsultationDataRefetch が登録する) を呼ぶ: 書き込みの間に止めた通知を 1 回取り直す
 * (ページは notifyWriteSettled を呼ばなくてよい)。
 * 始めた回数 (startedCount) も数える: 取り直しの応答を待つあいだに始めた書き込みは、応答が届く前に終わっていても、
 * その応答 (書き込みの前に読んだ値) を置かせない (札の deferIfHeld)
 */
export function useAiConsultationPendingWrites(): AiConsultationPendingWrites {
  const countRef = useRef(0);
  const startedRef = useRef(0);
  const listenersRef = useRef(new Set<() => void>());
  return useMemo<AiConsultationPendingWrites>(
    () => ({
      get current() {
        return countRef.current > 0;
      },
      get startedCount() {
        return startedRef.current;
      },
      begin: () => {
        countRef.current += 1;
        startedRef.current += 1;
        let ended = false;
        return () => {
          if (ended) return;
          ended = true;
          countRef.current -= 1;
          if (countRef.current > 0) return;
          for (const listener of [...listenersRef.current]) listener();
        };
      },
      subscribeSettled: (listener) => {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
    }),
    [],
  );
}
