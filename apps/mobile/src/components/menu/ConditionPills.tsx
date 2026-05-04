import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radius, spacing } from "../../theme";
import type { MenuGenerationConstraints } from "../../../../../types/domain";

// ============================================================
// Pill definitions
// ============================================================

const FILTERS: {
  key: keyof MenuGenerationConstraints;
  label: string;
  iconName: keyof typeof Ionicons.glyphMap;
}[] = [
  { key: "useFridgeFirst", label: "冷蔵庫優先", iconName: "snow" },
  { key: "quickMeals", label: "時短中心", iconName: "flash" },
  { key: "japaneseStyle", label: "和食多め", iconName: "restaurant" },
  { key: "healthy", label: "ヘルシー", iconName: "heart" },
] as const;

// ============================================================
// Props
// ============================================================

interface Props {
  values: MenuGenerationConstraints;
  onChange: (values: MenuGenerationConstraints) => void;
}

// ============================================================
// Component
// ============================================================

export const ConditionPills: React.FC<Props> = ({ values, onChange }) => {
  return (
    <View style={styles.row}>
      {FILTERS.map((f) => {
        const active = values[f.key];
        return (
          <Pressable
            key={f.key}
            testID={`v4-condition-${f.key}`}
            onPress={() => onChange({ ...values, [f.key]: !active })}
            style={({ pressed }) => [
              styles.pill,
              active ? styles.pillActive : styles.pillInactive,
              pressed && styles.pillPressed,
            ]}
          >
            <Ionicons
              name={f.iconName}
              size={14}
              color={active ? "#FFFFFF" : colors.text}
            />
            <Text style={[styles.label, active && styles.labelActive]}>
              {f.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
};

// ============================================================
// Styles
// ============================================================

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  pillInactive: {
    backgroundColor: "#FFFFFF",
    borderColor: colors.border,
  },
  pillActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  pillPressed: {
    opacity: 0.8,
  },
  label: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.text,
  },
  labelActive: {
    color: "#FFFFFF",
  },
});
