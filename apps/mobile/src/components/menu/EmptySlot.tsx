import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { colors, radius, spacing } from "../../theme";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  mealType: "breakfast" | "lunch" | "dinner" | "snack";
  dayId: string;
  dayDate: string;
  onPress: () => void;
  isGenerating?: boolean;
  mealLabel: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function EmptySlot({ mealType, dayId, dayDate: _dayDate, onPress, isGenerating = false, mealLabel }: Props) {
  const mealCfgColor = MEAL_COLORS[mealType] ?? colors.textMuted;
  const mealCfgIcon = MEAL_ICONS[mealType] ?? "ellipse";

  return (
    <Pressable
      testID={`empty-slot-${dayId}-${mealType}`}
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
      {/* 食事タイプアイコン */}
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: radius.md,
          backgroundColor: mealCfgColor,
          alignItems: "center",
          justifyContent: "center",
          opacity: isGenerating ? 0.8 : 0.3,
        }}
      >
        {isGenerating ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Ionicons name={mealCfgIcon} size={22} color="#fff" />
        )}
      </View>

      {/* テキスト */}
      <Text style={{ flex: 1, fontSize: 14, color: isGenerating ? colors.accent : colors.textMuted }}>
        {isGenerating ? "AI が生成中..." : `+ ${mealLabel}を追加`}
      </Text>

      {!isGenerating && (
        <Ionicons name="add-circle-outline" size={20} color={colors.textMuted} />
      )}
    </Pressable>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MEAL_COLORS: Record<string, string> = {
  breakfast: "#FF9800",
  lunch: "#4CAF50",
  dinner: "#7C4DFF",
  snack: "#E91E63",
};

const MEAL_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  breakfast: "sunny",
  lunch: "partly-sunny",
  dinner: "moon",
  snack: "cafe",
};
