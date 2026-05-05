import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { getApi } from "../../lib/api";
import { colors, radius, shadows, spacing } from "../../theme";

export interface ServingsConfig {
  default: number;
  weekday: {
    [day: string]: {
      breakfast?: number;
      lunch?: number;
      dinner?: number;
    };
  };
}

interface Props {
  visible: boolean;
  onClose: () => void;
  initialConfig?: ServingsConfig;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_LABELS_JP: Record<string, string> = {
  Mon: "月",
  Tue: "火",
  Wed: "水",
  Thu: "木",
  Fri: "金",
  Sat: "土",
  Sun: "日",
};
const MEAL_TYPES = ["breakfast", "lunch", "dinner"] as const;
const MEAL_LABELS_JP: Record<string, string> = {
  breakfast: "朝",
  lunch: "昼",
  dinner: "夕",
};

function clamp(value: number): number {
  return Math.max(1, Math.min(10, value));
}

export const ServingsModal: React.FC<Props> = ({
  visible,
  onClose,
  initialConfig,
}) => {
  const [config, setConfig] = useState<ServingsConfig>(
    initialConfig ?? { default: 1, weekday: {} }
  );
  const [saving, setSaving] = useState(false);

  const updateCell = (
    day: string,
    mealType: (typeof MEAL_TYPES)[number],
    value: number
  ) => {
    setConfig((c) => ({
      ...c,
      weekday: {
        ...c.weekday,
        [day]: { ...(c.weekday[day] ?? {}), [mealType]: clamp(value) },
      },
    }));
  };

  const updateDefault = (value: number) => {
    setConfig((c) => ({ ...c, default: clamp(value) }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const api = getApi();
      await api.patch<unknown>("/api/profile", { servingsConfig: config });
      onClose();
    } catch {
      Alert.alert("保存失敗", "もう一度お試しください");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
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
        <View testID="servings-modal" style={styles.container}>
          {/* ヘッダー */}
          <View style={styles.header}>
            <Text style={styles.title}>人数設定</Text>
            <Pressable
              testID="servings-close"
              onPress={onClose}
              hitSlop={8}
              style={styles.closeBtn}
            >
              <Ionicons name="close" size={24} color={colors.text} />
            </Pressable>
          </View>

          <Text style={styles.subtitle}>
            各セルをタップして人数を変更（0=作らない/外食）
          </Text>

          {/* デフォルト人数 */}
          <View style={styles.defaultRow}>
            <Text style={styles.defaultLabel}>デフォルト人数</Text>
            <View style={styles.stepper}>
              <Pressable
                testID="servings-default-decrement"
                onPress={() => updateDefault(config.default - 1)}
                style={styles.stepperBtn}
              >
                <Ionicons name="remove" size={20} color={colors.accent} />
              </Pressable>
              <Text testID="servings-default-value" style={styles.stepperValue}>
                {config.default}
              </Text>
              <Pressable
                testID="servings-default-increment"
                onPress={() => updateDefault(config.default + 1)}
                style={styles.stepperBtn}
              >
                <Ionicons name="add" size={20} color={colors.accent} />
              </Pressable>
            </View>
          </View>

          {/* グリッド */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              {/* グリッドヘッダー行 */}
              <View style={styles.gridHeaderRow}>
                <View style={styles.cellDay} />
                {MEAL_TYPES.map((m) => (
                  <View key={m} style={styles.cellHeader}>
                    <Text style={styles.cellHeaderText}>
                      {MEAL_LABELS_JP[m]}
                    </Text>
                  </View>
                ))}
              </View>

              {/* 曜日行 */}
              {DAYS.map((day) => (
                <View key={day} style={styles.gridRow}>
                  <View style={styles.cellDay}>
                    <Text
                      style={[
                        styles.cellDayText,
                        day === "Sat" && styles.satText,
                        day === "Sun" && styles.sunText,
                      ]}
                    >
                      {DAY_LABELS_JP[day]}
                    </Text>
                  </View>
                  {MEAL_TYPES.map((m) => {
                    const rawVal = config.weekday[day]?.[m];
                    const displayVal =
                      rawVal !== undefined ? rawVal : config.default;
                    return (
                      <View key={m} style={styles.cell}>
                        <View style={styles.cellInner}>
                          <Pressable
                            onPress={() => updateCell(day, m, displayVal - 1)}
                            style={styles.cellStepBtn}
                          >
                            <Ionicons
                              name="remove"
                              size={14}
                              color={colors.accent}
                            />
                          </Pressable>
                          <TextInput
                            testID={`servings-cell-${day}-${m}`}
                            value={String(displayVal)}
                            onChangeText={(t) => {
                              const n = parseInt(t, 10);
                              updateCell(day, m, isNaN(n) ? 1 : n);
                            }}
                            keyboardType="number-pad"
                            style={styles.cellInput}
                            selectTextOnFocus
                          />
                          <Pressable
                            onPress={() => updateCell(day, m, displayVal + 1)}
                            style={styles.cellStepBtn}
                          >
                            <Ionicons
                              name="add"
                              size={14}
                              color={colors.accent}
                            />
                          </Pressable>
                        </View>
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          </ScrollView>

          {/* 保存ボタン */}
          <Pressable
            testID="servings-save-btn"
            onPress={save}
            disabled={saving}
            style={[styles.submitBtn, saving && styles.submitBtnDisabled]}
          >
            {saving ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <Text style={styles.submitText}>保存する</Text>
            )}
          </Pressable>
        </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.xs,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    color: colors.text,
  },
  closeBtn: {
    padding: 4,
  },
  subtitle: {
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
  defaultRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  defaultLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  stepperBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperValue: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
    minWidth: 24,
    textAlign: "center",
  },
  gridHeaderRow: {
    flexDirection: "row",
    marginBottom: 2,
  },
  gridRow: {
    flexDirection: "row",
    marginBottom: 4,
  },
  cellDay: {
    width: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  cellDayText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  satText: {
    color: "#3B82F6",
  },
  sunText: {
    color: "#EF4444",
  },
  cellHeader: {
    width: 88,
    alignItems: "center",
    paddingVertical: 4,
  },
  cellHeaderText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textMuted,
  },
  cell: {
    width: 88,
    paddingHorizontal: 4,
  },
  cellInner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  cellStepBtn: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  cellInput: {
    flex: 1,
    textAlign: "center",
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
    paddingVertical: 0,
  },
  submitBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
    ...shadows.sm,
  },
  submitBtnDisabled: {
    opacity: 0.6,
  },
  submitText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#FFF",
  },
});
