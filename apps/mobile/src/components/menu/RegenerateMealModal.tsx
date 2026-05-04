import { Ionicons } from "@expo/vector-icons";
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
import type { MenuGenerationConstraints } from "../../../../../types/domain";
import { ConditionPills } from "./ConditionPills";
import { getApiBaseUrl } from "../../lib/api";
import { supabase } from "../../lib/supabase";

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
  const [conditions, setConditions] = useState<MenuGenerationConstraints>({
    useFridgeFirst: false,
    quickMeals: false,
    japaneseStyle: false,
    healthy: false,
  });
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const mealName =
    meal?.dishes?.[0]?.name ?? meal?.dish_name ?? "食事";

  const handleClose = () => {
    if (submitting) return;
    setConditions({ useFridgeFirst: false, quickMeals: false, japaneseStyle: false, healthy: false });
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
            <View style={styles.headerLeft}>
              <Ionicons name="sparkles" size={18} color={colors.accent} />
              <Text style={styles.title}>AIで変更</Text>
            </View>
            <Pressable
              testID="regenerate-meal-close"
              onPress={handleClose}
              style={styles.closeBtn}
            >
              <Ionicons name="close" size={20} color={colors.textLight} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* 現在の献立 */}
            <View style={styles.currentMealBox}>
              <Text style={styles.currentMealLabel}>現在の献立</Text>
              <Text style={styles.currentMealName}>{mealName}</Text>
            </View>

            {/* 条件 */}
            <Text style={styles.sectionLabel}>新しい条件を指定（複数選択可）</Text>
            <ConditionPills values={conditions} onChange={setConditions} />

            {/* メモ */}
            <Text style={[styles.sectionLabel, { marginTop: spacing.lg }]}>
              リクエスト（任意）
            </Text>
            <TextInput
              testID="regenerate-meal-note"
              multiline
              numberOfLines={4}
              value={note}
              onChangeText={setNote}
              placeholder="例: もっとヘルシーに、魚料理がいい..."
              placeholderTextColor={colors.textMuted}
              style={styles.textarea}
            />
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
                  <Ionicons name="sparkles" size={16} color="#FFF" />
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
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
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
  currentMealBox: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  currentMealLabel: {
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: 4,
  },
  currentMealName: {
    fontSize: 14,
    fontWeight: "500",
    color: colors.text,
  },
  sectionLabel: {
    fontSize: 13,
    color: colors.textMuted,
    marginBottom: spacing.sm,
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
