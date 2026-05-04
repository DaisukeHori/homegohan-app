import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
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

import { getApi } from '../../lib/api';
import { colors } from '../../theme/colors';
import { radius, spacing } from '../../theme/spacing';
import { typography } from '../../theme/typography';

type MealType = 'breakfast' | 'lunch' | 'dinner';

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner'];

interface Props {
  visible: boolean;
  onClose: () => void;
  selectedDate: string; // 改善対象日 (YYYY-MM-DD)
}

export const ImproveMealModal: React.FC<Props> = ({ visible, onClose, selectedDate }) => {
  const [selectedMeals, setSelectedMeals] = useState<MealType[]>(['breakfast', 'lunch', 'dinner']);
  const [improveNextDay, setImproveNextDay] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const toggleMeal = (m: MealType) => {
    setSelectedMeals(prev =>
      prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]
    );
  };

  const submit = async () => {
    if (selectedMeals.length === 0) {
      Alert.alert('エラー', '食事タイプを 1 つ以上選択してください');
      return;
    }
    setSubmitting(true);
    try {
      const api = getApi();
      await api.post('/api/ai/menu/meal/improve', {
        date: selectedDate,
        mealTypes: selectedMeals,
        nextDay: improveNextDay,
      });
      onClose();
    } catch (e) {
      console.error('ImproveMealModal submit error:', e);
      Alert.alert('エラー', '改善に失敗しました。もう一度お試しください。');
    } finally {
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
