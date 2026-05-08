'use client';

import type { TourProgressProps } from '@homegohan/handson-tour-shared';

export function TourProgress(props: TourProgressProps) {
  const {
    current,
    total,
    size = 8,
    spacing = 8,
    activeColor,
    inactiveColor,
  } = props;

  return (
    <div
      data-testid="tour-progress-dots"
      role="progressbar"
      aria-valuenow={current}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuetext={`ステップ ${current} / ${total}`}
      className="flex justify-center mb-2"
      style={{ gap: spacing }}
    >
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="rounded-full transition-colors duration-200"
          style={{
            width: size,
            height: size,
            backgroundColor:
              i + 1 <= current
                ? (activeColor ?? '#2563EB')
                : (inactiveColor ?? '#D1D5DB'),
          }}
        />
      ))}
    </div>
  );
}
