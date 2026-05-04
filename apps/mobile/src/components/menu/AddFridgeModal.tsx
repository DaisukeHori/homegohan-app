import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { getApi } from '../../lib/api';
import { colors } from '../../theme/colors';
import { radius, spacing } from '../../theme/spacing';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const AddFridgeModal: React.FC<Props> = ({ visible, onClose, onSuccess }) => {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setName('');
    setAmount('');
    setExpiryDate('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    const n = name.trim();
    if (!n) {
      Alert.alert('入力エラー', '食材名を入力してください。');
      return;
    }
    setSubmitting(true);
    try {
      const api = getApi();
      await api.post('/api/pantry', {
        name: n,
        amount: amount.trim() || null,
        expirationDate: expiryDate.trim() || null,
      });
      reset();
      onSuccess();
    } catch (e: any) {
      Alert.alert('追加失敗', e?.message ?? '追加に失敗しました。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      testID="add-fridge-modal"
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={handleClose}
    >
      <View style={styles.overlay}>
        <View style={styles.dialog}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>食材を追加</Text>
            <Pressable onPress={handleClose} hitSlop={8} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </Pressable>
          </View>

          {/* Divider */}
          <View style={styles.divider} />

          {/* Form */}
          <View style={styles.form}>
            <View style={styles.field}>
              <Text style={styles.label}>名前</Text>
              <TextInput
                testID="add-fridge-name-input"
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="例: キャベツ"
                placeholderTextColor={colors.textMuted}
                autoFocus
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>量</Text>
              <TextInput
                testID="add-fridge-amount-input"
                style={styles.input}
                value={amount}
                onChangeText={setAmount}
                placeholder="例: 1/2 個"
                placeholderTextColor={colors.textMuted}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>賞味期限</Text>
              <TextInput
                testID="add-fridge-expiry-input"
                style={styles.input}
                value={expiryDate}
                onChangeText={setExpiryDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.textMuted}
                keyboardType="numbers-and-punctuation"
              />
            </View>
          </View>

          {/* Actions */}
          <View style={styles.actions}>
            <Pressable onPress={handleClose} style={[styles.btn, styles.cancelBtn]}>
              <Text style={styles.cancelBtnText}>キャンセル</Text>
            </Pressable>
            <Pressable
              testID="add-fridge-submit-btn"
              onPress={handleSubmit}
              disabled={submitting}
              style={[styles.btn, styles.submitBtn, submitting && styles.btnDisabled]}
            >
              <Text style={styles.submitBtnText}>
                {submitting ? '追加中...' : '追加'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  dialog: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.lg,
  },
  form: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  field: {
    gap: spacing.xs,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textLight,
  },
  input: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 15,
    color: colors.text,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  btn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtn: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textLight,
  },
  submitBtn: {
    backgroundColor: colors.accent,
  },
  submitBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  btnDisabled: {
    opacity: 0.6,
  },
});
