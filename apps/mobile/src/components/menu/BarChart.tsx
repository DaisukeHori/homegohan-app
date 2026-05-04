import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../../theme/colors';
import { radius, spacing } from '../../theme/spacing';
import { typography } from '../../theme/typography';

interface Props {
  values: number[];
  labels: string[];
  /** バーの最大高さ (px) */
  maxBarHeight?: number;
}

export const BarChart: React.FC<Props> = ({ values, labels, maxBarHeight = 120 }) => {
  const max = Math.max(...values, 1);

  return (
    <View style={styles.container}>
      <View style={styles.barsRow}>
        {values.map((v, i) => {
          const heightRatio = v / max;
          const barH = Math.max(heightRatio * maxBarHeight, 4);
          return (
            <View key={i} style={styles.barWrapper}>
              <Text style={styles.barValue}>{v > 0 ? Math.round(v) : ''}</Text>
              <View style={[styles.barTrack, { height: maxBarHeight }]}>
                <View
                  style={[
                    styles.barFill,
                    { height: barH },
                  ]}
                />
              </View>
              <Text style={styles.barLabel}>{labels[i] ?? ''}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingVertical: spacing.md,
  },
  barsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-around',
    gap: spacing.xs,
  },
  barWrapper: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  barValue: {
    fontSize: 9,
    color: colors.textMuted,
    textAlign: 'center',
  },
  barTrack: {
    width: '100%',
    justifyContent: 'flex-end',
    backgroundColor: colors.border,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  barFill: {
    width: '100%',
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    opacity: 0.85,
  },
  barLabel: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
  },
});
