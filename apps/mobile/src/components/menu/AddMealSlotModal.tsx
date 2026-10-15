import { Ionicons } from "@expo/vector-icons";
import { KeyboardAvoidingView, Modal, Platform, Pressable, SafeAreaView, Text, View } from "react-native";

import { MEAL_LABELS, MEAL_ORDER, type MealType } from "@homegohan/shared";
import { MEAL_TYPE_COLORS, MEAL_TYPE_IONICONS } from "../../lib/meal-type-visuals";
import { colors, radius, spacing } from "../../theme";

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (mealType: MealType) => void;
  dayId: string | null;
}

// 選択肢は共有の MEAL_ORDER (5 値: 朝食 / 昼食 / 夕食 / おやつ / 夜食) から導く。
// 以前は 4 値を手書きしていて夜食 (midnight_snack) を選べなかった (#1446)。
// アイコン・色はモバイルの区分の見た目の表 (Record<MealType, …>) から引く (#1665)。MealType に値が増えると型で漏れが止まる。
const TYPES: readonly MealType[] = MEAL_ORDER;

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

          {/* 食事タイプのボタン (MEAL_ORDER の順) */}
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
                    backgroundColor: MEAL_TYPE_COLORS[t],
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Ionicons name={MEAL_TYPE_IONICONS[t]} size={20} color="#fff" />
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
