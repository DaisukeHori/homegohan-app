import { Check, Trash2 } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, typography } from '../../theme';

export type QuantityVariant = {
  display: string;
  unit: string;
  value: number | null;
};

export type ShoppingItemData = {
  id: string;
  item_name: string;
  quantity: string | null;
  category: string | null;
  is_checked: boolean;
  source?: 'manual' | 'generated';
  quantity_variants?: QuantityVariant[];
  selected_variant_index?: number;
};

interface Props {
  item: ShoppingItemData;
  onToggleCheck: (id: string, next: boolean) => void;
  onToggleVariant: (item: ShoppingItemData) => void;
  onDelete: (id: string) => void;
}

export const ShoppingItem: React.FC<Props> = ({
  item,
  onToggleCheck,
  onToggleVariant,
  onDelete,
}) => {
  const hasVariants = item.quantity_variants && item.quantity_variants.length > 1;

  return (
    <View
      testID={`shopping-list-item-${item.id}`}
      style={[styles.row, item.is_checked && styles.rowChecked]}
    >
      {/* チェックボックス */}
      <Pressable
        testID={`shopping-list-checkbox-${item.id}`}
        onPress={() => onToggleCheck(item.id, !item.is_checked)}
        style={[styles.checkbox, item.is_checked && styles.checkboxChecked]}
        hitSlop={8}
      >
        {item.is_checked && (
          <Check size={12} color="#fff" />
        )}
      </Pressable>

      {/* 品名 */}
      <Text
        style={[styles.name, item.is_checked && styles.nameChecked]}
        numberOfLines={1}
      >
        {item.item_name}
      </Text>

      {/* 数量 / バリアントボタン */}
      <Pressable
        testID={`shopping-list-variant-${item.id}`}
        onPress={() => hasVariants && onToggleVariant(item)}
        disabled={!hasVariants}
        style={[styles.quantityBtn, hasVariants && styles.quantityBtnActive]}
      >
        <Text style={styles.quantityText}>
          {item.quantity ?? '適量'}
          {hasVariants ? ' ⟳' : ''}
        </Text>
      </Pressable>

      {/* AI/手動バッジ */}
      <View
        style={[
          styles.badge,
          item.source === 'generated' ? styles.badgeAi : styles.badgeManual,
        ]}
      >
        <Text
          style={[
            styles.badgeText,
            item.source === 'generated' ? styles.badgeAiText : styles.badgeManualText,
          ]}
        >
          {item.source === 'generated' ? 'AI' : '手動'}
        </Text>
      </View>

      {/* 削除ボタン */}
      <Pressable
        testID={`shopping-list-delete-${item.id}`}
        onPress={() => onDelete(item.id)}
        style={styles.deleteBtn}
        hitSlop={8}
      >
        <Trash2 size={14} color={colors.textMuted} />
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    marginBottom: 6,
  },
  rowChecked: {
    backgroundColor: colors.bg,
    borderWidth: 0,
    opacity: 0.6,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  checkboxChecked: {
    borderWidth: 0,
    backgroundColor: colors.success,
  },
  name: {
    flex: 1,
    ...typography.body,
    color: colors.text,
  },
  nameChecked: {
    color: colors.textMuted,
    textDecorationLine: 'line-through',
  },
  quantityBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  quantityBtnActive: {
    backgroundColor: colors.bg,
  },
  quantityText: {
    ...typography.small,
    color: colors.textMuted,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  badgeAi: {
    backgroundColor: '#E8F5E9',
  },
  badgeManual: {
    backgroundColor: '#FFF3E0',
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  badgeAiText: {
    color: '#2E7D32',
  },
  badgeManualText: {
    color: '#E65100',
  },
  deleteBtn: {
    width: 28,
    height: 28,
    borderRadius: radius.md,
    backgroundColor: 'rgba(0,0,0,0.05)',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
