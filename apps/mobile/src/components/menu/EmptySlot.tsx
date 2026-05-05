import { ActivityIndicator, Pressable, Text } from "react-native";

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
      style={{
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: spacing.lg,
        paddingHorizontal: spacing.lg,
        backgroundColor: colors.card,
        borderRadius: radius.lg,
        borderWidth: 2,
        borderColor: isGenerating ? colors.accent : colors.border,
        borderStyle: "dashed",
      }}
    >
      {isGenerating ? (
        <ActivityIndicator size="small" color={colors.accent} />
      ) : (
        <Text style={{ fontSize: 14, color: colors.textMuted }}>
          {`+ ${mealLabel}を追加`}
        </Text>
      )}
    </Pressable>
  );
}
