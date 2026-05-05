import { Sparkles, X } from "lucide-react-native";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { setItemWithTTL } from "../../lib/persistence";
import { colors, radius, spacing } from "../../theme";
import { MEAL_LABELS } from "@homegohan/shared";
import { getApiBaseUrl } from "../../lib/api";
import { supabase } from "../../lib/supabase";

// ============================================================
// Constants
// ============================================================

const CONDITIONS: { key: string; label: string }[] = [
  { key: "useFridgeFirst", label: "冷蔵庫の食材を優先" },
  { key: "quickMeals",     label: "時短メニュー中心" },
  { key: "japaneseStyle",  label: "和食多め" },
  { key: "healthy",        label: "ヘルシーに" },
];

// ============================================================
// Types
// ============================================================

interface PlannedMealLike {
  id: string;
  dish_name?: string | null;
  dishes?: Array<{ name: string }> | null;
  meal_type?: string;
}

interface Props {
  visible: boolean;
  meal: PlannedMealLike | null;
  onClose: () => void;
}

// ============================================================
// Component
// ============================================================

export const RegenerateMealModal: React.FC<Props> = ({ visible, meal, onClose }) => {
  const [selectedConditions, setSelectedConditions] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const mealName =
    meal?.dishes?.[0]?.name ?? meal?.dish_name ?? "食事";

  const mealLabel =
    meal?.meal_type && meal.meal_type in MEAL_LABELS
      ? MEAL_LABELS[meal.meal_type as keyof typeof MEAL_LABELS]
      : "食事";

  const toggleCondition = (key: string) => {
    setSelectedConditions(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  const handleClose = () => {
    if (submitting) return;
    setSelectedConditions([]);
    setNote("");
    onClose();
  };

  const submit = async () => {
    if (!meal || submitting) return;
    setSubmitting(true);
    try {
      const base = getApiBaseUrl();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const conditions = {
        useFridgeFirst: selectedConditions.includes("useFridgeFirst"),
        quickMeals: selectedConditions.includes("quickMeals"),
        japaneseStyle: selectedConditions.includes("japaneseStyle"),
        healthy: selectedConditions.includes("healthy"),
      };

      const r = await fetch(`${base}/api/ai/menu/meal/regenerate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token
            ? { Authorization: `Bearer ${session.access_token}` }
            : {}),
        },
        body: JSON.stringify({ mealId: meal.id, conditions, note }),
      });
      if (!r.ok) throw new Error("regenerate failed");
      await setItemWithTTL("singleMealGenerating", { mealId: meal.id }, 2 * 60 * 1000);
      handleClose();
    } catch (_e) {
      // エラー時は submitting をリセットして UI を壊さない
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={handleClose}
    >
      <View style={styles.backdrop}>
        <View testID="regenerate-meal-modal" style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>✨ {mealLabel}をAIで変更</Text>
            <Pressable
              testID="regenerate-meal-close"
              onPress={handleClose}
              style={styles.closeBtn}
            >
              <X size={20} color={colors.textLight} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* 現在の献立 */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>現在の献立</Text>
              <View style={styles.currentMealBox}>
                <Text style={styles.currentMealName}>{mealName}</Text>
              </View>
            </View>

            {/* 条件 4 ボタン */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>新しい条件を指定（複数選択可）</Text>
              {CONDITIONS.map(c => {
                const active = selectedConditions.includes(c.key);
                return (
                  <Pressable
                    key={c.key}
                    testID={`regenerate-condition-${c.key}`}
                    onPress={() => toggleCondition(c.key)}
                    style={[
                      styles.conditionBtn,
                      active ? styles.conditionBtnActive : styles.conditionBtnInactive,
                    ]}
                  >
                    <Text style={[
                      styles.conditionLabel,
                      { color: active ? "#FFF" : colors.accent },
                    ]}>{c.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {/* リクエスト */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>リクエスト（任意）</Text>
              <TextInput
                testID="regenerate-meal-note"
                multiline
                numberOfLines={3}
                value={note}
                onChangeText={setNote}
                placeholder="例: もっとヘルシーに、魚料理がいい..."
                placeholderTextColor={colors.textMuted}
                style={styles.textarea}
              />
            </View>
          </ScrollView>

          {/* Submit */}
          <View style={styles.footer}>
            <Pressable
              testID="regenerate-meal-submit"
              onPress={submit}
              disabled={submitting}
              style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
            >
              {submitting ? (
                <ActivityIndicator color="#FFF" />
              ) : (
                <>
                  <Sparkles size={18} color="#FFF" />
                  <Text style={styles.submitText}>AIで別の献立に変更</Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
};

// ============================================================
// Styles
// ============================================================

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  container: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: "80%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: spacing.lg,
  },
  section: {
    marginBottom: spacing.lg,
  },
  sectionLabel: {
    fontSize: 12,
    color: colors.textLight,
    marginBottom: spacing.sm,
  },
  currentMealBox: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  currentMealName: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  conditionBtn: {
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  conditionBtnInactive: {
    backgroundColor: colors.accentLight,
  },
  conditionBtnActive: {
    backgroundColor: colors.accent,
  },
  conditionLabel: {
    fontSize: 14,
    fontWeight: "600",
  },
  textarea: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: 13,
    color: colors.text,
    minHeight: 80,
    textAlignVertical: "top",
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  submitBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  submitBtnDisabled: {
    opacity: 0.7,
  },
  submitText: {
    color: "#FFF",
    fontSize: 14,
    fontWeight: "600",
  },
});
