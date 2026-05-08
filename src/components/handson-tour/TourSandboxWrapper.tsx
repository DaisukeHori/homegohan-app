'use client';

import React from 'react';
import type { TourSandboxWrapperProps } from '@homegohan/handson-tour-shared';
import { TourOverlay } from './TourOverlay';

export function TourSandboxWrapper<T extends Record<string, unknown>>(
  props: TourSandboxWrapperProps<T> & {
    children: React.ReactElement<Record<string, unknown>>;
  },
) {
  const { children, childProps, subStep, overlay, subStepToTarget, onSandboxComplete } = props;

  const rawTarget = subStepToTarget[subStep];
  const targetTestId = typeof rawTarget === 'string' ? rawTarget : null;
  const targetTestIds = Array.isArray(rawTarget) ? rawTarget : undefined;

  const clonedChild = React.cloneElement(children, {
    ...childProps,
    mode: 'sandbox',
    onSandboxComplete,
  });

  return (
    <>
      {clonedChild}
      <TourOverlay
        {...overlay}
        targetTestId={targetTestId}
        targetTestIds={targetTestIds}
      />
    </>
  );
}
