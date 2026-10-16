'use client';

// src/hooks/useFamilyMenu.ts
// 週間献立の「家族の表示」で、表示中の週の家族の献立 (GET /api/family/menu) を取る hook
// (#1584 の 1・設計書 docs/design/family/10-family-menu-view.md §14.3)。
//
// - 取り直すのは deps (enabled・範囲・reload の tick) が変わったときだけ。timer や画面の前面への復帰では取り直さない (§0.3・§10)。
// - cache はメモリ (useRef) だけ。localStorage / sessionStorage に書かない (ログアウトの掃除の対象を増やさない。§16.4)。
// - data は今の範囲の応答だけを返す (週を移った直後に前の週の応答を返さない。T-17)。
// - 取得中に deps が変わったら、その取得の応答は捨てる (T-20)。
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFamilyMenu, type FamilyMenuFetchResult } from '@/lib/membership/family-menu';
import type { FamilyMenuData } from '@/schemas/membership/family-menu';

/** 同じ週の取り直しを抑える時間。page.tsx の weekDataCache の CACHE_TTL (5 分) と同じ */
export const FAMILY_MENU_CACHE_TTL_MS = 5 * 60 * 1000;

export type FamilyMenuStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseFamilyMenuArgs {
  /** 取る範囲 (page.tsx の targetDate / endDate と同じ YYYY-MM-DD) */
  startDate: string;
  endDate: string;
  /** false なら取らない (家族に居ない・others が空・自分だけ) */
  enabled: boolean;
}

export interface UseFamilyMenuResult {
  status: FamilyMenuStatus;
  /**
   * 今の範囲 (key) の応答。別の範囲の応答は返さない (週を移った直後は、新しい範囲の応答が届くか cache が当たるまで null)。
   * 同じ範囲の取り直し (reload) の loading / error の間は、その範囲の直前の応答を返す
   */
  data: FamilyMenuData | null;
  reason: Extract<FamilyMenuFetchResult, { ok: false }>['reason'] | null;
  /** 全ての範囲の cache を捨てて、今の範囲を取り直す (切り替えの適用・[もう一度])。適用の前に取った別の週の応答を残さない (T-25) */
  reload: () => void;
}

export function useFamilyMenu({ startDate, endDate, enabled }: UseFamilyMenuArgs): UseFamilyMenuResult {
  const cache = useRef<Map<string, { data: FamilyMenuData; fetchedAt: number }>>(new Map());
  const [status, setStatus] = useState<FamilyMenuStatus>('idle');
  /** 最後に受け取った応答と、その範囲の key (data は key が今の key と同じときだけ返す) */
  const [loaded, setLoaded] = useState<{ key: string; data: FamilyMenuData } | null>(null);
  const [reason, setReason] = useState<UseFamilyMenuResult['reason']>(null);
  const [tick, setTick] = useState(0);
  const key = `${startDate}_${endDate}`;

  // 取り直すのは deps (enabled・key・tick) が変わったときだけ。timer や画面の前面への復帰では取り直さない (§0.3・§10)
  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return;
    }
    const cached = cache.current.get(key);
    if (cached && Date.now() - cached.fetchedAt < FAMILY_MENU_CACHE_TTL_MS) {
      setLoaded({ key, data: cached.data });
      setStatus('ready');
      setReason(null);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    void fetchFamilyMenu(startDate, endDate).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        cache.current.set(key, { data: result.data, fetchedAt: Date.now() });
        setLoaded({ key, data: result.data });
        setReason(null);
        setStatus('ready');
      } else {
        setReason(result.reason);
        setStatus('error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, key, startDate, endDate, tick]);

  // 今の key だけでなく Map を空にする: 適用で読み直した一覧 (share_menu など) と、TTL 内の別の週の古い応答が食い違わないように (T-25)
  const reload = useCallback(() => {
    cache.current.clear();
    setTick((t) => t + 1);
  }, []);
  const data = loaded !== null && loaded.key === key ? loaded.data : null;
  return { status, data, reason, reload };
}
