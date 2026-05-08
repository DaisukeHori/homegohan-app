// TourSandboxWrapper — Mobile 版 HOC
// Canonical: docs/design/family/09-onboarding-handson-tour/07-components.md §5

import React from 'react';
import { View } from 'react-native';

import type { TourSandboxWrapperProps } from '@homegohan/handson-tour-shared';

import { TourOverlay } from './TourOverlay';

type TourSandboxWrapperPropsWithChildren<T> = TourSandboxWrapperProps<T> & {
  children: React.ReactElement;
};

export function TourSandboxWrapper<T>(props: TourSandboxWrapperPropsWithChildren<T>) {
  const { childProps, subStep, overlay, subStepToTarget, onSandboxComplete, children } = props;

  const target = subStepToTarget[subStep];
  const targetTestId = typeof target === 'string' ? target : null;
  const targetTestIds = Array.isArray(target) ? target : undefined;

  // children に mode='sandbox' + onSandboxComplete を注入
  const sandboxChild = React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
    ...(childProps as object),
    mode: 'sandbox',
    onSandboxComplete,
  });

  return (
    <View style={{ flex: 1 }}>
      {sandboxChild}
      <TourOverlay
        {...overlay}
        targetTestId={targetTestId}
        targetTestIds={targetTestIds}
      />
    </View>
  );
}
