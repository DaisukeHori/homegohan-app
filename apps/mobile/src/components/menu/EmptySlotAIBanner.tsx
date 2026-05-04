import { Ionicons } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";

import { colors, radius, spacing } from "../../theme";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  emptySlotCount: number;
  onPress: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function EmptySlotAIBanner({ emptySlotCount, onPress }: Props) {
  const hasEmpty = emptySlotCount > 0;

  return (
    <Pressable
      testID="empty-slot-ai-banner"
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        backgroundColor: hasEmpty
          ? colors.accentLight
          : colors.card,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: hasEmpty ? colors.accent : colors.border,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Ionicons
        name="sparkles"
        size={16}
        color={hasEmpty ? colors.accent : colors.textMuted}
      />
      <View style={{ flex: 1 }}>
        {hasEmpty ? (
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.accent }}>
            空欄{emptySlotCount}件 → AIに埋めてもらう
          </Text>
        ) : (
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.textMuted }}>
            AI献立アシスタント
          </Text>
        )}
      </View>
      <Ionicons
        name="chevron-forward"
        size={16}
        color={hasEmpty ? colors.accent : colors.textMuted}
      />
    </Pressable>
  );
}
