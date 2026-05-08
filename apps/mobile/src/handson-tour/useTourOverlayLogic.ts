// Mobile 版 useTourOverlayLogic
// Canonical: docs/design/family/09-onboarding-handson-tour/07-components.md §2.3 §7.3
// measureInWindow + 100ms ポーリング + onLayout 連動

import { useCallback, useEffect, useRef, useState } from 'react';
import { findNodeHandle, UIManager } from 'react-native';

import type { TargetRect, TourOverlayProps } from '@homegohan/handson-tour-shared';

type UseTourOverlayLogicResult = {
  targetRect: TargetRect | null;
  isVisible: boolean;
};

function mergeRects(rects: TargetRect[]): TargetRect {
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * testID からネイティブの measureInWindow で矩形を取得する。
 * 100ms 間隔でポーリングし、targetTestId 変更時に再計算する。
 */
export function useTourOverlayLogic(
  props: Pick<
    TourOverlayProps,
    | 'targetTestId'
    | 'targetTestIds'
    | 'autoAdvanceMs'
    | 'onAutoAdvance'
    | 'scrollRecalcIntervalMs'
  >
): UseTourOverlayLogicResult {
  const { targetTestId, targetTestIds, autoAdvanceMs, onAutoAdvance, scrollRecalcIntervalMs } =
    props;

  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRecalcTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * testID で指定された要素の矩形を measureInWindow で取得する。
   * 見つからない場合は null を返す。
   */
  const measureSingleElement = useCallback((testId: string): TargetRect | null => {
    // RN での testID 検索: __getDefaultDisplayName__ 等がないため
    // React Native の findNodeHandle / UIManager.measure を利用する
    // ただし testID から ref なしに要素を取得するには
    // @testing-library 的アプローチが必要なため、ここでは
    // グローバル登録された ref を使うパターンを採用する。
    const ref = tourTargetRefRegistry.get(testId);
    if (!ref) return null;

    return new Promise<TargetRect | null>((resolve) => {
      const handle = findNodeHandle(ref);
      if (!handle) {
        resolve(null);
        return;
      }
      UIManager.measure(handle, (_x, _y, width, height, pageX, pageY) => {
        if (width === 0 && height === 0) {
          resolve(null);
          return;
        }
        resolve({ x: pageX, y: pageY, width, height });
      });
    }) as unknown as TargetRect | null;
  }, []);

  const measureTarget = useCallback(() => {
    const ids = targetTestIds ?? (targetTestId ? [targetTestId] : null);
    if (!ids || ids.length === 0) {
      setTargetRect(null);
      return;
    }

    // 同期的に取得できる場合のフォールバック
    const results: TargetRect[] = [];
    let pending = ids.length;

    ids.forEach((id) => {
      const ref = tourTargetRefRegistry.get(id);
      if (!ref) {
        pending--;
        if (pending === 0 && results.length > 0) {
          setTargetRect(results.length === 1 ? results[0]! : mergeRects(results));
        } else if (pending === 0) {
          setTargetRect(null);
        }
        return;
      }

      const handle = findNodeHandle(ref);
      if (!handle) {
        pending--;
        if (pending === 0 && results.length > 0) {
          setTargetRect(results.length === 1 ? results[0]! : mergeRects(results));
        } else if (pending === 0) {
          setTargetRect(null);
        }
        return;
      }

      UIManager.measure(handle, (_x, _y, width, height, pageX, pageY) => {
        if (width > 0 || height > 0) {
          results.push({ x: pageX, y: pageY, width, height });
        }
        pending--;
        if (pending === 0) {
          if (results.length > 0) {
            setTargetRect(results.length === 1 ? results[0]! : mergeRects(results));
          } else {
            setTargetRect(null);
          }
        }
      });
    });
  }, [targetTestId, targetTestIds]);

  useEffect(() => {
    // Entrance アニメーション開始
    setIsVisible(true);

    // target 計測
    measureTarget();

    // Auto-advance タイマー
    if (autoAdvanceMs !== undefined && onAutoAdvance) {
      autoAdvanceTimerRef.current = setTimeout(() => {
        onAutoAdvance();
      }, autoAdvanceMs);
    }

    // Scroll 監視 (100ms 間隔)
    const interval = scrollRecalcIntervalMs ?? 100;
    scrollRecalcTimerRef.current = setInterval(() => {
      measureTarget();
    }, interval);

    return () => {
      if (autoAdvanceTimerRef.current) clearTimeout(autoAdvanceTimerRef.current);
      if (scrollRecalcTimerRef.current) clearInterval(scrollRecalcTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetTestId, targetTestIds?.join(',')]);

  return { targetRect, isVisible };
}

// ============================================================
// グローバル ref レジストリ
// TourTarget コンポーネントがここに ref を登録することで
// useTourOverlayLogic が testID から要素を取得できるようにする。
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tourTargetRefRegistry = new Map<string, any>();

export function registerTourTarget(testId: string, ref: unknown): void {
  tourTargetRefRegistry.set(testId, ref);
}

export function unregisterTourTarget(testId: string): void {
  tourTargetRefRegistry.delete(testId);
}
