import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  CATEGORY_LABELS,
  NUTRIENT_BY_CATEGORY,
  NUTRIENT_DEFINITIONS,
} from '@homegohan/shared';

import { getApi } from '../../lib/api';
import { colors } from '../../theme/colors';
import { radius, spacing } from '../../theme/spacing';
import { typography } from '../../theme/typography';

// ============================================================
// RadarKeyPicker
// ============================================================

interface RadarKeyPickerProps {
  /** 現在選択中の栄養素キー一覧 */
  selectedKeys: string[];
  /** 変更が保存されたときに呼ばれる */
  onSaved: (keys: string[]) => void;
}

export const RadarKeyPicker: React.FC<RadarKeyPickerProps> = ({
  selectedKeys,
  onSaved,
}) => {
  const [editing, setEditing] = useState(false);
  const [tempKeys, setTempKeys] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setTempKeys([...selectedKeys]);
    setEditing(true);
  };

  const toggleKey = (key: string) => {
    setTempKeys((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= 8) return prev;
      return [...prev, key];
    });
  };

  const save = async () => {
    if (tempKeys.length < 3) {
      Alert.alert('エラー', '3 個以上選択してください');
      return;
    }
    setSaving(true);
    try {
      const api = getApi();
      await api.post('/api/profile', { radarChartNutrients: tempKeys });
      onSaved(tempKeys);
      setEditing(false);
    } catch {
      Alert.alert('エラー', '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <View style={styles.viewRow}>
        <Text style={styles.viewHint}>
          レーダーチャート（{selectedKeys.length}角形）
        </Text>
        <Pressable
          testID="nutrition-detail-radar-edit"
          onPress={startEdit}
          style={styles.editBtn}
          hitSlop={8}
        >
          <Text style={styles.editBtnText}>編集</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.editContainer}>
      <Text style={styles.editHint}>3〜8 個を選択（選択順で表示）</Text>
      {Object.entries(NUTRIENT_BY_CATEGORY).map(([cat, defs]) => (
        <View key={cat} style={styles.catBlock}>
          <Text style={styles.catLabel}>{CATEGORY_LABELS[cat]}</Text>
          <View style={styles.chipRow}>
            {defs.map((def) => {
              const selected = tempKeys.includes(def.key);
              const idx = tempKeys.indexOf(def.key);
              const disabled = !selected && tempKeys.length >= 8;
              return (
                <Pressable
                  key={def.key}
                  onPress={() => toggleKey(def.key)}
                  disabled={disabled}
                  style={[
                    styles.chip,
                    selected && styles.chipSelected,
                    disabled && styles.chipDisabled,
                  ]}
                >
                  {selected && (
                    <Text style={styles.chipIdx}>{idx + 1}</Text>
                  )}
                  <Text
                    style={[
                      styles.chipText,
                      selected && styles.chipTextSelected,
                    ]}
                  >
                    {def.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      <View style={styles.actionRow}>
        <Pressable
          onPress={() => setEditing(false)}
          style={[styles.actionBtn, styles.cancelBtn]}
        >
          <Text style={styles.cancelText}>キャンセル</Text>
        </Pressable>
        <Pressable
          onPress={save}
          disabled={tempKeys.length < 3 || saving}
          style={[
            styles.actionBtn,
            styles.saveBtn,
            (tempKeys.length < 3 || saving) && styles.saveBtnDisabled,
          ]}
        >
          {saving ? (
            <ActivityIndicator color="#FFF" size="small" />
          ) : (
            <Text style={styles.saveText}>
              保存（{tempKeys.length}角形）
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  viewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  viewHint: {
    ...typography.caption,
    color: colors.textMuted,
  },
  editBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
  },
  editBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.accent,
  },
  editContainer: {
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  editHint: {
    ...typography.caption,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  catBlock: {
    marginBottom: spacing.xs,
  },
  catLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    backgroundColor: colors.bg,
  },
  chipSelected: {
    backgroundColor: colors.accent,
  },
  chipDisabled: {
    opacity: 0.4,
  },
  chipIdx: {
    fontSize: 9,
    color: '#FFF',
    fontWeight: '700',
  },
  chipText: {
    fontSize: 10,
    color: colors.textLight,
  },
  chipTextSelected: {
    color: '#FFF',
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtn: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelText: {
    ...typography.caption,
    color: colors.textMuted,
  },
  saveBtn: {
    backgroundColor: colors.accent,
  },
  saveBtnDisabled: {
    opacity: 0.5,
  },
  saveText: {
    ...typography.caption,
    color: '#FFF',
    fontWeight: '700',
  },
});
