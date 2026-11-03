"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AI_CONSULTATION_DATA_CHANGED_EVENT,
  isAiConsultationRefetchBlocked,
} from "@/lib/ai/consultation-data-refetch";

/**
 * Web の AI 相談の提案の実行でデータが変わったら (AI_CONSULTATION_DATA_CHANGED_EVENT)、refetch を呼ぶ (#2195 V1)。
 * 入力の部品・開いているモーダルがページにある間は呼ばない (isAiConsultationRefetchBlocked。AI 相談の吹き出しの中と、
 * 何も変えていない入力欄の部品の中 (AI_CONSULTATION_UNEDITED_INPUTS_ATTRIBUTE) の入力の部品は数えない)。
 * refetch にはページの既存の取得の関数を渡す (ページ全体の reload はしない)。
 * refetch は描画のたびに作り直してよい (最新のものを呼ぶ。購読はし直さない)
 */
export function useAiConsultationDataRefetch(refetch: () => unknown): void {
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  });

  useEffect(() => {
    const onDataChanged = () => {
      if (isAiConsultationRefetchBlocked(document)) return;
      void refetchRef.current();
    };
    window.addEventListener(AI_CONSULTATION_DATA_CHANGED_EVENT, onDataChanged);
    return () => window.removeEventListener(AI_CONSULTATION_DATA_CHANGED_EVENT, onDataChanged);
  }, []);
}

/**
 * useAiConsultationDataRefetch の、取得を useEffect の中に書いているページ向けの形 (#2195 V1)。
 * 取り直すときに 1 つ増える数を返す。ページはこれを取得の useEffect の依存に足す
 * (取得の関数を外へ出さずに、既存の取得をそのままもう一度走らせる)
 */
export function useAiConsultationRefetchKey(): number {
  const [refetchKey, setRefetchKey] = useState(0);
  const bump = useCallback(() => setRefetchKey((key) => key + 1), []);
  useAiConsultationDataRefetch(bump);
  return refetchKey;
}
