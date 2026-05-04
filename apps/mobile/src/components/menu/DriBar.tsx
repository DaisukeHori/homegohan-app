import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { NUTRIENT_DEFINITIONS, calculateDriPercentage } from '@homegohan/shared';

import { colors } from '../../theme/colors';
import { radius, spacing } from '../../theme/spacing';
import { typography } from '../../theme/typography';

interface Props {
  nutrientKey: string;
  value: number | null | undefined;
}

function barColor(pct: number): string {
  if (pct > 150) return colors.error;
  if (pct >= 80 && pct <= 120) return colors.success;
  if (pct < 50) return colors.warning;
  return colors.accent;
}

export const DriBar: React.FC<Props> = ({ nutrientKey, value }) => {
  const def = NUTRIENT_DEFINITIONS.find((d) => d.key === nutrientKey);
  if (!def) return null;

  const v = value ?? 0;
  const pct = calculateDriPercentage(nutrientKey, v);
  const fillColor = barColor(pct);
  const displayVal = v.toFixed(def.decimals);

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Text style={styles.label}>{def.label}</Text>
        <View style={styles.valueRow}>
          <Text style={styles.value}>
            {displayVal}{def.unit}
          </Text>
          <Text style={[styles.pct, { color: fillColor }]}>{pct}%</Text>
        </View>
      </View>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { width: `${Math.min(pct, 100)}%`, backgroundColor: fillColor },
          ]}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    ...typography.caption,
    color: colors.textLight,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  value: {
    fontSize: 11,
    color: colors.textMuted,
  },
  pct: {
    fontSize: 11,
    fontWeight: '700',
    minWidth: 36,
    textAlign: 'right',
  },
  track: {
    height: 6,
    backgroundColor: colors.border,
    borderRadius: 3,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
  },
});
