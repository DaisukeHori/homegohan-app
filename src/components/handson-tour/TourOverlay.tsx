'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import FocusTrap from 'focus-trap-react';
import type { TourOverlayProps, TargetRect } from '@homegohan/handson-tour-shared';
import { TourBubble } from './TourBubble';
import { useTourOverlayLogic } from './useTourOverlayLogic';
import { useReducedMotion } from './useReducedMotion';

function buildSpotlightMask(rect: TargetRect, padding: number): string {
  const x = rect.x - padding;
  const y = rect.y - padding;
  const w = rect.width + padding * 2;
  const h = rect.height + padding * 2;

  return `
    linear-gradient(black, black),
    linear-gradient(black, black)
  `;
}

function buildSpotlightStyle(rect: TargetRect | null, padding: number): React.CSSProperties {
  if (!rect) {
    return {};
  }

  const x = rect.x - padding;
  const y = rect.y - padding;
  const w = rect.width + padding * 2;
  const h = rect.height + padding * 2;

  return {
    WebkitMaskImage: `linear-gradient(black, black), linear-gradient(black, black)`,
    WebkitMaskPosition: `0 0, ${x}px ${y}px`,
    WebkitMaskSize: `100% 100%, ${w}px ${h}px`,
    WebkitMaskComposite: 'xor',
    maskImage: `linear-gradient(black, black), linear-gradient(black, black)`,
    maskPosition: `0 0, ${x}px ${y}px`,
    maskSize: `100% 100%, ${w}px ${h}px`,
    maskComposite: 'exclude',
  };
}

export function TourOverlay(props: TourOverlayProps) {
  const {
    targetTestId,
    targetTestIds,
    bubble,
    primaryAction,
    autoAdvanceMs,
    onAutoAdvance,
    autoAdvanceTappable,
    showSkip,
    onSkip,
    progress,
    dimOpacity = 0.6,
    spotlightPadding = 8,
    bubbleOffset = 12,
    accessibilityLabel = '使い方ガイド',
    forceReducedMotion,
    scrollRecalcIntervalMs,
  } = props;

  const prefersReducedMotion = useReducedMotion(forceReducedMotion);

  const { targetRect, isVisible, measureTarget } = useTourOverlayLogic({
    targetTestId,
    targetTestIds,
    autoAdvanceMs,
    onAutoAdvance,
    scrollRecalcIntervalMs,
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onSkip) {
        onSkip();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onSkip]);

  if (typeof document === 'undefined') return null;

  const overlayTransition = prefersReducedMotion
    ? { duration: 0.1 }
    : { duration: 0.2 };

  const spotlightStyle = targetRect
    ? buildSpotlightStyle(targetRect, spotlightPadding)
    : {};

  const handleOverlayClick = () => {
    if (autoAdvanceTappable && onAutoAdvance) {
      onAutoAdvance();
    }
  };

  return createPortal(
    <AnimatePresence>
      {isVisible && (
        <FocusTrap
          focusTrapOptions={{
            allowOutsideClick: true,
            escapeDeactivates: false,
          }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-live="polite"
            aria-label={accessibilityLabel}
            data-testid="tour-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={overlayTransition}
            className="fixed inset-0 z-50"
            style={targetRect ? spotlightStyle : undefined}
            onClick={handleOverlayClick}
          >
            <div
              className="absolute inset-0"
              style={{ backgroundColor: `rgba(0,0,0,${dimOpacity})` }}
            />

            {targetRect ? (
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: targetRect.x - spotlightPadding,
                  top: targetRect.y - spotlightPadding,
                  width: targetRect.width + spotlightPadding * 2,
                  height: targetRect.height + spotlightPadding * 2,
                  borderRadius: 8,
                  boxShadow: `0 0 0 9999px rgba(0,0,0,${dimOpacity})`,
                  pointerEvents: 'none',
                  zIndex: 51,
                }}
              />
            ) : null}

            <div
              className="absolute inset-0"
              style={{ backgroundColor: targetRect ? 'transparent' : `rgba(0,0,0,${dimOpacity})` }}
              aria-hidden="true"
            />

            <TourBubble
              target={targetRect}
              bubble={bubble}
              position={bubble.position}
              primaryAction={primaryAction}
              progress={progress}
              offset={bubbleOffset}
            />

            {showSkip && (
              <button
                data-testid="tour-skip-button"
                onClick={onSkip}
                className="absolute top-4 right-4 text-white/80 hover:text-white text-sm py-3 px-4 min-h-[44px] min-w-[44px] z-[60]"
                aria-label="チュートリアルを終了する"
              >
                あとで
              </button>
            )}
          </motion.div>
        </FocusTrap>
      )}
    </AnimatePresence>,
    document.body,
  );
}
