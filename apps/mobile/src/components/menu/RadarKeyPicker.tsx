import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { NUTRIENT_DEFINITIONS } from '@homegohan/shared';

import { colors } from '../../theme/colors';
import { radius, spacing } from '../../theme/spacing';
import { typography } from '../../theme/typography';

interface Props {
  selected: string[];
  onChange: (keys: string[]) => void;
}

const MIN_KEYS = 3;
const MAX_KEYS = 8;

export const RadarKeyPicker: React.FC<Props> = ({ selected, onChange }) => {
  const toggle = (key: string) => {
    if (selected.includes(key)) {
      if (selected.length > MIN_KEYS) {
        onChange(selected.filter((k) => k !== key));
      }
    } else {
      if (selected.length < MAX_KEYS) {
        onChange([...selected, key]);
      }
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.hint}>
        {selected.length}/{MAX_KEYS} 選択中（最低 {MIN_KEYS}、最大 {MAX_KEYS}）
      </Text>
      <View style={styles.grid}>
        {NUTRIENT_DEFINITIONS.map((def) => {
          const isSelected = selected.includes(def.key);
          const isDisabled = isSelected
            ? selected.length <= MIN_KEYS
            : selected.length >= MAX_KEYS;
          return (
            <Pressable
              key={def.key}
              testID={`stats-radar-key-${def.key}`}
              onPress={() => toggle(def.key)}
              disabled={isDisabled && !isSelected}
              style={[
                styles.chip,
                isSelected && styles.chipActive,
                isDisabled && !isSelected && styles.chipDisabled,
              ]}
            >
              <Text
                style={[
                  styles.chipText,
                  isSelected && styles.chipTextActive,
                  isDisabled && !isSelected && styles.chipTextDisabled,
                ]}
              >
                {def.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  hint: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  chipActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentLight,
  },
  chipDisabled: {
    opacity: 0.4,
  },
  chipText: {
    fontSize: 12,
    color: colors.textLight,
    fontWeight: '500',
  },
  chipTextActive: {
    color: colors.accent,
    fontWeight: '700',
  },
  chipTextDisabled: {
    color: colors.textMuted,
  },
});
