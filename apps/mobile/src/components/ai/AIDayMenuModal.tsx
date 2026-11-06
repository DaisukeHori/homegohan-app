import { Ionicons } from "@expo/vector-icons";
import { todayLocal } from "@homegohan/shared";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { Text, TextInput } from "../ui/Text";

import { colors, radius, shadows, spacing } from "../../theme";
import { useV4MenuGeneration } from "../../hooks/useV4MenuGeneration";
import {
  DAY_MENU_DATE_RANGE_HINT,
  DAY_MENU_DATE_UNSELECTABLE_MESSAGE,
  dayMenuDateRangeOf,
  defaultDayMenuDateOf,
  isDayMenuDateSelectable,
} from "../../lib/ai-day-menu-date";

/**
 * 日付の欄の既定の日 (#2283。Web の #2245 L1 と同じ決め)。JST の今日 (#1433) を 1 回だけ読み、明日にする。
 * このモーダルはタブの上の丸いボタンから開く相談のシートの上に開き、献立表の表示の日を受け取らないので、表示の日は無い (undefined)
 */
function computeDefaultDayMenuDate(): string {
  return defaultDayMenuDateOf(todayLocal(), undefined);
}

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
  /**
   * 作成を今始めてはいけないか (#2245 K1)。開いた側 (AIAdvisorSheet) が、送信中・取り直しの最中・アーカイブの応答待ちの最中に真を返す。
   * 「作成する」の入口で見て、真なら作らない。無ければ止めない
   */
  isStartBlocked?: () => boolean;
}

// ============================================================
// Component
// ============================================================

export const AIDayMenuModal: React.FC<Props> = ({ visible, onClose, onAiConsentRequired, isStartBlocked }) => {
  // 既定は明日 (#2283。Web と同じ。以前は今日で、今日の献立を黙って作り直せた)。JST の暦日 (#1433)
  const [selectedDate, setSelectedDate] = useState<string>(computeDefaultDayMenuDate);

  // 開くたびに既定の日を求め直す (Web の openDayMenuModal と同じ。このモーダルは閉じても外されないので、前に開いたときの日・
  // 日をまたいだ前の日の明日が残らないように)
  useEffect(() => {
    if (visible) setSelectedDate(computeDefaultDayMenuDate());
  }, [visible]);

  // 日付の欄が空・形の崩れ・範囲 (JST の今日〜14 日後) の外か (#2283。Web の #2245 K1・L1 と同じ。欄の下に理由の一文を出し、
  // 「作成する」を止める)
  const dateUnselectable = !isDayMenuDateSelectable(selectedDate, dayMenuDateRangeOf(todayLocal()));

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

  async function handleGenerate() {
    // 開いた側が止めている間は作らない (#2245 K1。アーカイブの応答待ちの間などに、モーダルの「作成する」から始めさせない)
    if (isStartBlocked?.()) return;
    // 日付の欄が空・範囲の外なら作らない (#2283。ボタンも止めている。押した時点の JST の今日で見る)
    if (!isDayMenuDateSelectable(selectedDate, dayMenuDateRangeOf(todayLocal()))) return;

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
              style={[styles.dateInput, dateUnselectable && styles.dateInputError]}
              value={selectedDate}
              onChangeText={setSelectedDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              maxLength={10}
            />
            <Text style={styles.hint}>{DAY_MENU_DATE_RANGE_HINT}</Text>
            {dateUnselectable && (
              <Text style={styles.errorText} accessibilityRole="alert" testID="ai-day-menu-date-unselectable">
                {DAY_MENU_DATE_UNSELECTABLE_MESSAGE}
              </Text>
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
              disabled={isGenerating || dateUnselectable}
              accessibilityState={{ disabled: isGenerating || dateUnselectable }}
              testID="ai-day-menu-generate"
              style={[styles.generateBtn, (isGenerating || dateUnselectable) && styles.generateBtnDisabled]}
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
