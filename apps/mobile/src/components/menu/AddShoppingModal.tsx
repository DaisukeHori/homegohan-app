import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { getApi } from '../../lib/api';
import { colors, radius, spacing, typography } from '../../theme';

// カテゴリ選択肢 (WEB page.tsx addShopping モーダルに合わせる)
const CATEGORIES = [
  '野菜',
  '肉',
  '魚',
  '乳製品',
  '卵',
  '豆腐・大豆',
  '麺・米',
  '調味料',
  '乾物',
  '飲料',
  'その他',
];

interface Props {
  visible: boolean;
  onClose: () => void;
  onAdded: () => void;
}

export const AddShoppingModal: React.FC<Props> = ({ visible, onClose, onAdded }) => {
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [category, setCategory] = useState('その他');
  const [submitting, setSubmitting] = useState(false);
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);

  function resetForm() {
    setName('');
    setQuantity('');
    setCategory('その他');
    setShowCategoryPicker(false);
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  async function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      const api = getApi();
      await api.post('/api/shopping-list', {
        itemName: trimmed,
        category: category || 'その他',
        quantity: quantity.trim() || null,
      });
      resetForm();
      onAdded();
    } catch (e: any) {
      Alert.alert('追加失敗', e?.message ?? '追加に失敗しました。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      testID="add-shopping-modal"
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <Pressable style={styles.overlay} onPress={handleClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          {/* ヘッダー */}
          <View style={styles.header}>
            <Text style={styles.title}>買い物アイテム追加</Text>
            <Pressable onPress={handleClose} style={styles.closeBtn} hitSlop={8}>
              <Ionicons name="close" size={18} color={colors.textLight} />
            </Pressable>
          </View>

          {/* フォーム */}
          <View style={styles.form}>
            {/* 品名 */}
            <TextInput
              testID="add-shopping-name-input"
              style={styles.input}
              placeholder="品名（例: もやし）"
              placeholderTextColor={colors.textMuted}
              value={name}
              onChangeText={setName}
              returnKeyType="next"
            />

            {/* 量 */}
            <TextInput
              testID="add-shopping-quantity-input"
              style={styles.input}
              placeholder="量（例: 2袋）"
              placeholderTextColor={colors.textMuted}
              value={quantity}
              onChangeText={setQuantity}
              returnKeyType="done"
            />

            {/* カテゴリ選択 */}
            <Pressable
              testID="add-shopping-category-select"
              style={styles.selectBtn}
              onPress={() => setShowCategoryPicker((prev) => !prev)}
            >
              <Text style={styles.selectText}>{category}</Text>
              <Ionicons
                name={showCategoryPicker ? 'chevron-up' : 'chevron-down'}
                size={16}
                color={colors.textMuted}
              />
            </Pressable>

            {/* カテゴリドロップダウン */}
            {showCategoryPicker && (
              <ScrollView style={styles.pickerList} nestedScrollEnabled>
                {CATEGORIES.map((cat) => (
                  <Pressable
                    key={cat}
                    style={[
                      styles.pickerItem,
                      cat === category && styles.pickerItemSelected,
                    ]}
                    onPress={() => {
                      setCategory(cat);
                      setShowCategoryPicker(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.pickerItemText,
                        cat === category && styles.pickerItemTextSelected,
                      ]}
                    >
                      {cat}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}

            {/* 送信ボタン */}
            <Pressable
              testID="add-shopping-submit-btn"
              style={[styles.submitBtn, (!name.trim() || submitting) && styles.submitBtnDisabled]}
              onPress={handleSubmit}
              disabled={!name.trim() || submitting}
            >
              <Text style={styles.submitBtnText}>
                {submitting ? '追加中...' : '追加する'}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius['2xl'],
    borderTopRightRadius: radius['2xl'],
    paddingBottom: spacing['2xl'],
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    ...typography.h3,
    color: colors.text,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: radius.full,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  form: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  input: {
    ...typography.body,
    color: colors.text,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
  },
  selectBtn: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
  },
  selectText: {
    ...typography.body,
    color: colors.text,
  },
  pickerList: {
    maxHeight: 200,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
  },
  pickerItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  pickerItemSelected: {
    backgroundColor: colors.accentLight,
  },
  pickerItemText: {
    ...typography.body,
    color: colors.text,
  },
  pickerItemTextSelected: {
    color: colors.accent,
    fontWeight: '700',
  },
  submitBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  submitBtnDisabled: {
    opacity: 0.5,
  },
  submitBtnText: {
    ...typography.bodyBold,
    color: '#fff',
  },
});
