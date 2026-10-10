import { Ionicons } from '@expo/vector-icons';
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { MEAL_LABELS } from '@homegohan/shared';

import { isAiConsentRequiredError } from '../../lib/ai-consent';
import {
  IMPROVE_MEAL_TYPES,
  isImproveMealRejectedError,
  type ImproveMealRequest,
  type ImproveMealType,
} from '../../lib/improve-meal';
import { colors } from '../../theme/colors';
import { radius, spacing } from '../../theme/spacing';
import { typography } from '../../theme/typography';

type MealType = ImproveMealType;

const MEAL_TYPES: readonly MealType[] = IMPROVE_MEAL_TYPES;

interface Props {
  visible: boolean;
  onClose: () => void;
  selectedDate: string; // 改善対象日 (YYYY-MM-DD)
  /**
   * 「改善」を押したときの処理 (献立の生成を始める)。
   * このモーダルは API を直接呼ばず、親に任せる (#1138: 以前は存在しない API を直接呼んでいた)。
   * リクエストが受け付けられるまで待ち、成功したらモーダルを閉じる。
   * 失敗 (reject) したらエラーを表示し、モーダルは開いたままにして再試行できるようにする。
   * 利用者に見せたい理由があるときは ImproveMealRejectedError を投げる。
   * 「同意が必要です」(403 AI_CONSENT_REQUIRED。T15 / #1154) で reject したら、失敗は表示せず、モーダルを閉じてから
   * onAiConsentRequired を呼ぶ (週の画面の onSubmit は、同意で止められても reject しない。案内は生成のフックが出す)。
   */
  onSubmit: (request: ImproveMealRequest) => Promise<void>;
  /**
   * onSubmit が「同意が必要です」で reject したときに呼ぶ (T15 / #1154)。このモーダルは自分を閉じてから呼ぶ。
   * 呼ばれた側 (このモーダルを開いた画面・モーダル) が、自分も同意画面を隠さないように閉じてから、同意画面への案内を出す
   * (このモーダルだけを閉じて案内を出すと、下に開いたままの栄養分析の詳細が、案内から開いた同意画面を隠す。
   * src/lib/ai-consent.ts の規則)
   */
  onAiConsentRequired: () => void;
  /** 画面に表示中の AI栄養士の提案。あれば onSubmit にそのまま渡し、生成の要望として使われる */
  advice?: string | null;
}

export const ImproveMealModal: React.FC<Props> = ({ visible, onClose, selectedDate, onSubmit, onAiConsentRequired, advice }) => {
  const [selectedMeals, setSelectedMeals] = useState<MealType[]>(['breakfast', 'lunch', 'dinner']);
  const [improveNextDay, setImproveNextDay] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // state の更新は次の描画まで反映されないため、同じフレームでの連打は ref で止める
  const inFlightRef = useRef(false);

  const toggleMeal = (m: MealType) => {
    setSelectedMeals(prev =>
      prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]
    );
  };

  const submit = async () => {
    if (inFlightRef.current) return;
    if (selectedMeals.length === 0) {
      Alert.alert('エラー', '食事タイプを 1 つ以上選択してください');
      return;
    }
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit({
        date: selectedDate,
        // 選んだ順ではなく 朝→昼→夕 の順で渡す
        mealTypes: MEAL_TYPES.filter(m => selectedMeals.includes(m)),
        nextDay: improveNextDay,
        advice,
      });
      onClose();
    } catch (e) {
      if (isAiConsentRequiredError(e)) {
        // 同意が必要で止められた: 「改善に失敗しました」は出さない。モーダルを閉じてから、開いた側に知らせる (案内は開いた側が出す)
        onClose();
        onAiConsentRequired();
        return;
      }
      if (isImproveMealRejectedError(e)) {
        // 生成中・過去の日付など、利用者に見せたい理由がある失敗
        Alert.alert('エラー', e.message);
      } else {
        console.error('ImproveMealModal submit error:', e);
        Alert.alert('エラー', '改善に失敗しました。もう一度お試しください。');
      }
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const submitLabel = improveNextDay
    ? `翌日 ${selectedMeals.length} 食分を改善`
    : `${selectedMeals.length} 食分を改善`;

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent>
      <View style={styles.backdrop}>
        <View testID="improve-meal-modal" style={styles.container}>
          {/* ヘッダー */}
          <View style={styles.header}>
            <View style={styles.headerIcon}>
              <Ionicons name="refresh" size={18} color={colors.accent} />
            </View>
            <Text style={styles.title}>献立を改善</Text>
            <Pressable testID="improve-meal-close" onPress={onClose} style={styles.closeBtn} hitSlop={8}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>

          {/* 対象日 */}
          <View style={styles.dateRow}>
            <Text style={styles.dateLabel}>対象日</Text>
            <Text style={styles.dateValue}>{selectedDate}</Text>
          </View>

          {/* 食事タイプ選択 */}
          <Text style={styles.sectionLabel}>どの食事を改善しますか？</Text>
          {MEAL_TYPES.map(m => {
            const checked = selectedMeals.includes(m);
            return (
              <Pressable
                key={m}
                testID={`improve-meal-type-${m}`}
                onPress={() => toggleMeal(m)}
                style={[styles.checkboxRow, checked && styles.checkboxRowActive]}
              >
                <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                  {checked && <Ionicons name="checkmark" size={14} color="#FFF" />}
                </View>
                <Text style={[styles.checkboxLabel, checked && styles.checkboxLabelActive]}>
                  {MEAL_LABELS[m]}
                </Text>
                {checked && (
                  <Ionicons
                    name="checkmark"
                    size={16}
                    color={colors.accent}
                    style={styles.checkRowEnd}
                  />
                )}
              </Pressable>
            );
          })}

          {/* 翌日トグル */}
          <Pressable
            testID="improve-meal-next-day-toggle"
            onPress={() => setImproveNextDay(v => !v)}
            style={[styles.toggleRow, improveNextDay && styles.toggleRowActive]}
          >
            <View style={styles.toggleCalIcon}>
              <Ionicons name="calendar-outline" size={16} color={improveNextDay ? colors.accent : colors.textMuted} />
            </View>
            <Text style={[styles.toggleLabel, improveNextDay && styles.toggleLabelActive]}>
              翌日 1 日を対象
            </Text>
            <View style={[styles.toggle, improveNextDay && styles.toggleActive]}>
              <View style={[styles.toggleKnob, improveNextDay && styles.toggleKnobActive]} />
            </View>
          </Pressable>

          {/* フッターボタン */}
          <View style={styles.footer}>
            <Pressable onPress={onClose} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>キャンセル</Text>
            </Pressable>
            <Pressable
              testID="improve-meal-submit"
              onPress={submit}
              disabled={submitting || selectedMeals.length === 0}
              style={[
                styles.submitBtn,
                (submitting || selectedMeals.length === 0) && styles.submitBtnDisabled,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color="#FFF" size="small" />
              ) : (
                <>
                  <Ionicons name="refresh" size={16} color="#FFF" style={styles.submitIcon} />
                  <Text style={styles.submitText}>{submitLabel}</Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  container: {
    width: '100%',
    backgroundColor: colors.bg,
    borderRadius: radius.xl,
    paddingHorizontal: spacing['2xl'],
    paddingTop: spacing['2xl'],
    paddingBottom: spacing.lg,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  headerIcon: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    backgroundColor: colors.accentLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    ...typography.h3,
    flex: 1,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  dateLabel: {
    ...typography.caption,
    color: colors.textMuted,
  },
  dateValue: {
    ...typography.label,
    color: colors.text,
  },
  sectionLabel: {
    ...typography.label,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    gap: spacing.sm,
    backgroundColor: colors.bg,
  },
  checkboxRowActive: {
    borderColor: colors.accent,
    backgroundColor: '#FFF8F5',
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.bg,
  },
  checkboxChecked: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  checkboxLabel: {
    ...typography.body,
    flex: 1,
    color: colors.textLight,
  },
  checkboxLabelActive: {
    color: colors.text,
    fontWeight: '600',
  },
  checkRowEnd: {
    marginLeft: 'auto',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
    gap: spacing.sm,
    backgroundColor: colors.bg,
  },
  toggleRowActive: {
    borderColor: colors.accent,
    backgroundColor: '#FFF8F5',
  },
  toggleCalIcon: {
    width: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  toggleLabel: {
    ...typography.body,
    flex: 1,
    color: colors.textLight,
  },
  toggleLabelActive: {
    color: colors.text,
    fontWeight: '600',
  },
  toggle: {
    width: 44,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.border,
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  toggleActive: {
    backgroundColor: colors.accent,
  },
  toggleKnob: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#FFF',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
    alignSelf: 'flex-start',
  },
  toggleKnobActive: {
    alignSelf: 'flex-end',
  },
  footer: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelText: {
    ...typography.label,
    color: colors.textMuted,
  },
  submitBtn: {
    flex: 2,
    flexDirection: 'row',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xs,
  },
  submitBtnDisabled: {
    backgroundColor: colors.accentLight,
  },
  submitIcon: {
    marginRight: 2,
  },
  submitText: {
    ...typography.label,
    color: '#FFF',
  },
});
