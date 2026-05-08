'use client';

import type { TourBubbleProps, TargetRect } from '@homegohan/handson-tour-shared';
import { TourProgress } from './TourProgress';

type ActualPosition = 'top' | 'bottom' | 'left' | 'right' | 'center';

type BubblePositionResult = {
  x: number;
  y: number;
  actualPosition: ActualPosition;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function calculateBubblePosition(
  target: TargetRect | null,
  preferredPosition: 'top' | 'bottom' | 'left' | 'right' | 'auto',
  bubbleSize: { width: number; height: number },
  viewportSize: { width: number; height: number },
  offset: number,
): BubblePositionResult {
  if (!target) {
    return {
      x: (viewportSize.width - bubbleSize.width) / 2,
      y: (viewportSize.height - bubbleSize.height) / 2,
      actualPosition: 'center',
    };
  }

  let resolved: 'top' | 'bottom' | 'left' | 'right' = 'bottom';

  if (preferredPosition === 'auto') {
    const spaceBelow = viewportSize.height - (target.y + target.height);
    const spaceAbove = target.y;
    if (spaceBelow >= bubbleSize.height + offset + 16) {
      resolved = 'bottom';
    } else if (spaceAbove >= bubbleSize.height + offset + 16) {
      resolved = 'top';
    } else {
      resolved = 'bottom';
    }
  } else {
    resolved = preferredPosition;
  }

  switch (resolved) {
    case 'top':
      return {
        x: clamp(
          target.x + target.width / 2 - bubbleSize.width / 2,
          16,
          viewportSize.width - bubbleSize.width - 16,
        ),
        y: target.y - bubbleSize.height - offset,
        actualPosition: 'top',
      };
    case 'bottom':
      return {
        x: clamp(
          target.x + target.width / 2 - bubbleSize.width / 2,
          16,
          viewportSize.width - bubbleSize.width - 16,
        ),
        y: target.y + target.height + offset,
        actualPosition: 'bottom',
      };
    case 'left':
      return {
        x: target.x - bubbleSize.width - offset,
        y: clamp(
          target.y + target.height / 2 - bubbleSize.height / 2,
          16,
          viewportSize.height - bubbleSize.height - 16,
        ),
        actualPosition: 'left',
      };
    case 'right':
      return {
        x: target.x + target.width + offset,
        y: clamp(
          target.y + target.height / 2 - bubbleSize.height / 2,
          16,
          viewportSize.height - bubbleSize.height - 16,
        ),
        actualPosition: 'right',
      };
  }
}

function Spinner() {
  return (
    <span
      className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"
      aria-hidden="true"
    />
  );
}

function ArrowElement({ position }: { position: ActualPosition }) {
  if (position === 'center') return null;

  const baseStyle: React.CSSProperties = {
    position: 'absolute',
    width: 0,
    height: 0,
  };

  if (position === 'bottom') {
    return (
      <div
        aria-hidden="true"
        style={{
          ...baseStyle,
          top: -8,
          left: '50%',
          transform: 'translateX(-50%)',
          borderLeft: '8px solid transparent',
          borderRight: '8px solid transparent',
          borderBottom: '8px solid white',
        }}
      />
    );
  }

  if (position === 'top') {
    return (
      <div
        aria-hidden="true"
        style={{
          ...baseStyle,
          bottom: -8,
          left: '50%',
          transform: 'translateX(-50%)',
          borderLeft: '8px solid transparent',
          borderRight: '8px solid transparent',
          borderTop: '8px solid white',
        }}
      />
    );
  }

  if (position === 'right') {
    return (
      <div
        aria-hidden="true"
        style={{
          ...baseStyle,
          left: -8,
          top: '50%',
          transform: 'translateY(-50%)',
          borderTop: '8px solid transparent',
          borderBottom: '8px solid transparent',
          borderRight: '8px solid white',
        }}
      />
    );
  }

  if (position === 'left') {
    return (
      <div
        aria-hidden="true"
        style={{
          ...baseStyle,
          right: -8,
          top: '50%',
          transform: 'translateY(-50%)',
          borderTop: '8px solid transparent',
          borderBottom: '8px solid transparent',
          borderLeft: '8px solid white',
        }}
      />
    );
  }

  return null;
}

const BUBBLE_WIDTH = 280;
const BUBBLE_ESTIMATED_HEIGHT = 160;

export function TourBubble(props: TourBubbleProps) {
  const { target, bubble, position, primaryAction, progress, offset } = props;

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 375;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 812;

  const pos = calculateBubblePosition(
    target,
    position,
    { width: bubble.maxWidth ?? BUBBLE_WIDTH, height: BUBBLE_ESTIMATED_HEIGHT },
    { width: viewportWidth, height: viewportHeight },
    offset,
  );

  return (
    <div
      data-testid="tour-bubble"
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        left: pos.x,
        top: pos.y,
        maxWidth: bubble.maxWidth ?? BUBBLE_WIDTH,
        width: bubble.maxWidth ?? BUBBLE_WIDTH,
        background: 'white',
        borderRadius: 12,
        padding: 16,
        boxShadow: '0 8px 16px rgba(0,0,0,0.12)',
        zIndex: 60,
      }}
    >
      <ArrowElement position={pos.actualPosition} />

      {progress && (
        <TourProgress current={progress.current} total={progress.total} />
      )}

      {bubble.title && (
        <h3
          data-testid="tour-bubble-title"
          className="text-base font-semibold mb-2 text-gray-900"
        >
          {bubble.title}
        </h3>
      )}

      <p
        data-testid="tour-bubble-body"
        className="text-sm text-gray-700 mb-3 leading-relaxed"
        style={{ maxHeight: 180, overflowY: 'auto', wordBreak: 'break-word' }}
      >
        {bubble.body}
      </p>

      {primaryAction && (
        <button
          data-testid="tour-next-button"
          onClick={primaryAction.onPress}
          disabled={primaryAction.disabled}
          aria-label={primaryAction.label}
          className="bg-blue-600 text-white px-6 py-3 rounded-lg w-full font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {primaryAction.showSpinner ? <Spinner /> : primaryAction.label}
        </button>
      )}
    </div>
  );
}
