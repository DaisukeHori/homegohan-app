'use client';

// src/hooks/useFamilyView.ts
// (設計書 membership/03-ui-spec.md §4.2)
// 家族ビュー切替状態を localStorage に永続化する hook

import { useState, useEffect, useCallback } from 'react';

export type FamilyViewPreset =
  | 'self'
  | 'self_partner'
  | 'self_children'
  | 'children_only'
  | 'all'
  | 'custom';

export interface FamilyViewState {
  preset: FamilyViewPreset;
  visible_member_ids: string[]; // family_members.id の配列
}

const DEFAULT_STATE: FamilyViewState = {
  preset: 'all',
  visible_member_ids: [],
};

function getStorageKey(familyId: string): string {
  return `familyViewState_${familyId}`;
}

export function useFamilyView(familyId: string | null | undefined) {
  const [viewState, setViewStateInternal] = useState<FamilyViewState>(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);

  // localStorage から復元
  useEffect(() => {
    if (!familyId) {
      setViewStateInternal(DEFAULT_STATE);
      setLoaded(true);
      return;
    }
    try {
      const raw = localStorage.getItem(getStorageKey(familyId));
      if (raw) {
        const parsed = JSON.parse(raw) as FamilyViewState;
        setViewStateInternal(parsed);
      }
    } catch {
      // parse 失敗はデフォルト値で続行
    }
    setLoaded(true);
  }, [familyId]);

  const setView = useCallback(
    (next: FamilyViewState) => {
      setViewStateInternal(next);
      if (!familyId) return;
      try {
        localStorage.setItem(getStorageKey(familyId), JSON.stringify(next));
      } catch {
        // QuotaExceededError などは無視
      }
    },
    [familyId],
  );

  return { viewState, setView, loaded };
}
