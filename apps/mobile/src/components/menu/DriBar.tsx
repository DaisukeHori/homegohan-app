import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  NUTRIENT_DEFINITIONS,
  type NutrientDefinition,
} from '@homegohan/shared';

import { colors } from '../../theme/colors';
import { radius, spacing } from '../../theme/spacing';

// ============================================================
// helpers
// ============================================================

function getDriPercent(key: string, value: number): number {
  const def = NUTRIENT_DEFINITIONS.find((d) => d.key === key);
  if (!def || def.dri === 0) return 0;
  return Math.round((value / def.dri) * 100);
}

function getBarColor(pct: number): string {
  if (pct > 150) return colors.error;
  if (pct >= 80 && pct <= 120) return colors.success;
  if (pct < 50) return colors.warning;
  return colors.accent;
}

// ============================================================
// DriBar
// ============================================================

interface DriBarProps {
  def: NutrientDefinition;
  value: number;
}

export const DriBar: React.FC<DriBarProps> = ({ def, value }) => {
  const pct = getDriPercent(def.key, value);
  const barColor = getBarColor(pct);

  return (
    <View
      testID={`nutrition-detail-bar-${def.key}`}
      style={styles.container}
    >
      <View style={styles.labelRow}>
        <Text style={styles.label}>{def.label}</Text>
        <View style={styles.valueRow}>
          <Text style={styles.value}>
            {value.toFixed(def.decimals)}
            {def.unit}
          </Text>
          <Text style={[styles.pct, { color: barColor }]}>{pct}%</Text>
        </View>
      </View>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { width: `${Math.min(pct, 100)}%`, backgroundColor: barColor },
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
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    fontSize: 12,
    color: colors.textLight,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
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
