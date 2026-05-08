// TourProgress — Mobile 版 進捗ドット
// Canonical: docs/design/family/09-onboarding-handson-tour/07-components.md §4

import React from 'react';
import { StyleSheet, View } from 'react-native';

import type { TourProgressProps } from '@homegohan/handson-tour-shared';

const DEFAULT_ACTIVE_COLOR = '#2563EB';
const DEFAULT_INACTIVE_COLOR = '#D1D5DB';

export function TourProgress(props: TourProgressProps) {
  const {
    current,
    total,
    size = 8,
    spacing = 8,
    activeColor = DEFAULT_ACTIVE_COLOR,
    inactiveColor = DEFAULT_INACTIVE_COLOR,
  } = props;

  return (
    <View
      testID="tour-progress-dots"
      accessibilityRole="progressbar"
      accessibilityValue={{
        min: 1,
        max: total,
        now: current,
        text: `ステップ ${current} / ${total}`,
      }}
      style={styles.container}
    >
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          accessible={false}
          importantForAccessibility="no"
          style={[
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: i + 1 <= current ? activeColor : inactiveColor,
              marginHorizontal: spacing / 2,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 4,
  },
});
