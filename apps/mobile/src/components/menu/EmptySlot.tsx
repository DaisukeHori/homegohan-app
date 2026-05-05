import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { colors, radius, spacing } from "../../theme";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  mealType: "breakfast" | "lunch" | "dinner" | "snack";
  dayId: string | null;
  dayDate: string;
  onPress: () => void;
  isGenerating?: boolean;
  mealLabel: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function EmptySlot({ mealType: _mealType, dayId, dayDate: _dayDate, onPress, isGenerating = false, mealLabel }: Props) {
  return (
    <Pressable
      testID={`empty-slot-${dayId}-${_mealType}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
        padding: spacing.lg,
        backgroundColor: isGenerating
          ? colors.accentLight
          : pressed
          ? colors.card
          : colors.bg,
        borderRadius: radius.lg,
        borderWidth: 2,
        borderColor: isGenerating ? colors.accent : colors.border,
        borderStyle: "dashed",
      })}
    >
      {/* 食事タイプアイコン (グレー小型) */}
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: radius.sm,
          backgroundColor: colors.border,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {isGenerating ? (
          <ActivityIndicator size="small" color={colors.textMuted} />
        ) : (
          <Ionicons name="add" size={16} color={colors.textMuted} />
        )}
      </View>

      {/* テキスト */}
      <Text style={{ flex: 1, fontSize: 14, color: isGenerating ? colors.accent : colors.textMuted }}>
        {isGenerating ? "AI が生成中..." : `+ ${mealLabel}を追加`}
      </Text>
    </Pressable>
  );
}

