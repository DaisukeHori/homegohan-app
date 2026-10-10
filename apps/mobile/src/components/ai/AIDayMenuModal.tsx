import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { colors, radius, shadows, spacing } from "../../theme";
import { useV4MenuGeneration } from "../../hooks/useV4MenuGeneration";

// ============================================================
// Props
// ============================================================

interface Props {
  visible: boolean;
  onClose: () => void;
  /**
   * 作成が「同意が必要です」で止められたときに呼ぶ (T15 / #1154)。このモーダルは自分を閉じてから呼ぶ。
   * 呼ばれた側 (このモーダルを開いた画面・シート) が、自分も同意画面を隠さないように閉じてから、同意画面への案内を出す
   * (このモーダルだけを閉じて案内を出すと、下に開いたままのシートが、案内から開いた同意画面を隠す。src/lib/ai-consent.ts の規則)
   */
  onAiConsentRequired: () => void;
}

// ============================================================
// Component
// ============================================================

export const AIDayMenuModal: React.FC<Props> = ({ visible, onClose, onAiConsentRequired }) => {
  // 今日の日付をデフォルト
  const today = new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(today);
  const [dateError, setDateError] = useState<string | null>(null);

  const { generate, isGenerating } = useV4MenuGeneration({
    onGenerationStart: () => {
      Alert.alert(
        "献立生成開始",
        "1日分の献立を生成しています。しばらくお待ちください。"
      );
      onClose();
    },
    // 同意が必要で止められた (T15 / #1154): このモーダルを閉じてから、開いた側に知らせる (案内は開いた側が出す)
    onAiConsentRequired: () => {
      onClose();
      onAiConsentRequired();
    },
    onError: (err) => {
      Alert.alert("エラー", err ?? "献立の生成に失敗しました。");
    },
  });

  function validateDate(value: string): boolean {
    // YYYY-MM-DD 形式チェック
    const regex = /^\d{4}-\d{2}-\d{2}$/;
    if (!regex.test(value)) {
      setDateError("日付は YYYY-MM-DD 形式で入力してください");
      return false;
    }
    const d = new Date(value);
    if (isNaN(d.getTime())) {
      setDateError("有効な日付を入力してください");
      return false;
    }
    setDateError(null);
    return true;
  }

  async function handleGenerate() {
    if (!validateDate(selectedDate)) return;

    const mealTypes = ["breakfast", "lunch", "dinner"] as const;
    const targetSlots = mealTypes.map((mealType) => ({
      date: selectedDate,
      mealType,
    }));

    try {
      await generate({
        targetSlots,
        constraints: {},
        note: "",
        ultimateMode: false,
        resolveExistingMeals: false,
      });
    } catch {
      // 失敗はフックの onError が表示済み (ボタンの onPress から呼ばれるので、ここで止めないと未処理の reject になる)。
      // 同意が必要で止められたときは、フックが例外にせず onAiConsentRequired を呼ぶ
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          {/* ヘッダー */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Ionicons name="calendar" size={18} color={colors.accent} />
              <Text style={styles.headerTitle}>1日献立を作成</Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={18} color={colors.textLight} />
            </Pressable>
          </View>

          {/* 日付入力 */}
          <View style={styles.body}>
            <Text style={styles.label}>対象日</Text>
            <TextInput
              style={[styles.dateInput, dateError != null && styles.dateInputError]}
              value={selectedDate}
              onChangeText={(v) => {
                setSelectedDate(v);
                if (dateError) validateDate(v);
              }}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              maxLength={10}
            />
            {dateError != null && (
              <Text style={styles.errorText}>{dateError}</Text>
            )}
            <Text style={styles.hint}>朝・昼・夕の3食分を自動生成します</Text>
          </View>

          {/* ボタン */}
          <View style={styles.footer}>
            <Pressable onPress={onClose} style={styles.cancelBtn}>
              <Text style={styles.cancelBtnText}>キャンセル</Text>
            </Pressable>
            <Pressable
              onPress={handleGenerate}
              disabled={isGenerating}
              style={[styles.generateBtn, isGenerating && styles.generateBtnDisabled]}
            >
              {isGenerating ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <Text style={styles.generateBtnText}>作成する</Text>
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
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
  },
  sheet: {
    width: "100%",
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    overflow: "hidden",
    ...shadows.md,
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
    gap: spacing.xs,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textLight,
    marginBottom: spacing.xs,
  },
  dateInput: {
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  dateInputError: {
    borderColor: colors.error,
  },
  errorText: {
    fontSize: 12,
    color: colors.error,
  },
  hint: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  footer: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.lg,
    paddingTop: 0,
  },
  cancelBtn: {
    flex: 1,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelBtnText: {
    fontSize: 14,
    color: colors.textLight,
    fontWeight: "600",
  },
  generateBtn: {
    flex: 2,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  generateBtnDisabled: {
    backgroundColor: colors.textMuted,
  },
  generateBtnText: {
    fontSize: 14,
    color: "#FFF",
    fontWeight: "700",
  },
});
