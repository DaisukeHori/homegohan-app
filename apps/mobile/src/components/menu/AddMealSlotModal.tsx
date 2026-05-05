import { Ionicons } from "@expo/vector-icons";
import { KeyboardAvoidingView, Modal, Platform, Pressable, SafeAreaView, Text, View } from "react-native";

import { MEAL_LABELS, type MealType } from "@homegohan/shared";
import { colors, radius, spacing } from "../../theme";

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (mealType: MealType) => void;
  dayId: string | null;
}

const TYPES: MealType[] = ["breakfast", "lunch", "dinner", "snack"];

const MEAL_ICONS: Record<MealType, keyof typeof Ionicons.glyphMap> = {
  breakfast: "sunny",
  lunch: "partly-sunny",
  dinner: "moon",
  snack: "cafe",
  midnight_snack: "cloudy-night",
};

const MEAL_COLORS: Record<MealType, string> = {
  breakfast: "#FF9800",
  lunch: "#4CAF50",
  dinner: "#7C4DFF",
  snack: "#E91E63",
  midnight_snack: "#3F51B5",
};

export function AddMealSlotModal({ visible, onClose, onSelect, dayId: _dayId }: Props) {
  return (
    <Modal
      testID="add-meal-slot-modal"
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          {/* ヘッダー */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              padding: spacing.lg,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
              backgroundColor: colors.bg,
            }}
          >
            <Text style={{ fontSize: 17, fontWeight: "700", color: colors.text }}>
              食事タイプを選択
            </Text>
            <Pressable onPress={onClose} style={{ padding: 4 }}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>

          {/* 4 ボタン */}
          <View style={{ padding: spacing.lg, gap: spacing.sm }}>
            {TYPES.map((t) => (
              <Pressable
                key={t}
                testID={`add-meal-slot-${t}`}
                onPress={() => onSelect(t)}
                style={({ pressed }: { pressed: boolean }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: spacing.md,
                  padding: spacing.md,
                  borderRadius: radius.lg,
                  backgroundColor: pressed ? colors.card : colors.bg,
                  borderWidth: 1,
                  borderColor: colors.border,
                })}
              >
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: radius.md,
                    backgroundColor: MEAL_COLORS[t],
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Ionicons name={MEAL_ICONS[t]} size={20} color="#fff" />
                </View>
                <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>
                  {MEAL_LABELS[t]}
                </Text>
              </Pressable>
            ))}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
