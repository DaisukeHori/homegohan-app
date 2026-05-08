'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TourOverlayProps, TourOverlayState, TargetRect } from '@homegohan/handson-tour-shared';

type UseTourOverlayLogicReturn = TourOverlayState & {
  measureTarget: () => void;
};

function measureSingleElement(testId: string): TargetRect | null {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function mergeRects(rects: TargetRect[]): TargetRect {
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function useTourOverlayLogic(
  props: Pick<
    TourOverlayProps,
    | 'targetTestId'
    | 'targetTestIds'
    | 'autoAdvanceMs'
    | 'onAutoAdvance'
    | 'scrollRecalcIntervalMs'
  >,
): UseTourOverlayLogicReturn {
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const autoAdvanceTimerIdRef = useRef<number | null>(null);
  const scrollRecalcTimerIdRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const { targetTestId, targetTestIds, autoAdvanceMs, onAutoAdvance, scrollRecalcIntervalMs } =
    props;

  const measureTarget = useCallback(() => {
    if (!targetTestId && (!targetTestIds || targetTestIds.length === 0)) {
      setTargetRect(null);
      return;
    }
    const ids = targetTestIds ?? (targetTestId ? [targetTestId] : []);
    const rects = ids.map((id) => measureSingleElement(id)).filter((r): r is TargetRect => r !== null);
    if (rects.length === 0) {
      setTargetRect(null);
      return;
    }
    const merged = mergeRects(rects);
    setTargetRect(merged);
  }, [targetTestId, targetTestIds]);

  useEffect(() => {
    measureTarget();
    setIsVisible(true);

    if (autoAdvanceMs && onAutoAdvance) {
      autoAdvanceTimerIdRef.current = window.setTimeout(() => {
        onAutoAdvance();
      }, autoAdvanceMs);
    }

    const interval = scrollRecalcIntervalMs ?? 100;
    scrollRecalcTimerIdRef.current = window.setInterval(measureTarget, interval);

    return () => {
      if (autoAdvanceTimerIdRef.current !== null) {
        clearTimeout(autoAdvanceTimerIdRef.current);
      }
      if (scrollRecalcTimerIdRef.current !== null) {
        clearInterval(scrollRecalcTimerIdRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetTestId, targetTestIds, measureTarget, autoAdvanceMs, onAutoAdvance, scrollRecalcIntervalMs]);

  useEffect(() => {
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
    }

    const ids = targetTestIds ?? (targetTestId ? [targetTestId] : []);
    if (ids.length === 0) return;

    const observer = new ResizeObserver(() => {
      measureTarget();
    });

    ids.forEach((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (el) observer.observe(el);
    });

    resizeObserverRef.current = observer;

    return () => {
      observer.disconnect();
    };
  }, [targetTestId, targetTestIds, measureTarget]);

  return {
    targetRect,
    isVisible,
    autoAdvanceTimerId: autoAdvanceTimerIdRef.current,
    scrollRecalcTimerId: scrollRecalcTimerIdRef.current,
    measureTarget,
  };
}
