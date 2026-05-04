import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../../theme/colors';
import { radius } from '../../theme/spacing';
import { spacing } from '../../theme/spacing';

export type PantryItemData = {
  id: string;
  name: string;
  amount: string | null;
  category: string | null;
  expirationDate: string | null;
  addedAt: string | null;
};

export type ExpiryStatus = 'expired' | 'expiringSoon' | 'normal';

export function daysFromToday(expiryDate: string): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const exp = new Date(expiryDate);
  exp.setHours(0, 0, 0, 0);
  return Math.round((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

export function getExpiryStatus(expiryDate: string | null): ExpiryStatus {
  if (!expiryDate) return 'normal';
  const days = daysFromToday(expiryDate);
  if (days < 0) return 'expired';
  if (days <= 1) return 'expiringSoon';
  return 'normal';
}

interface Props {
  item: PantryItemData;
  onDelete: (id: string) => void;
}

export const PantryItem: React.FC<Props> = ({ item, onDelete }) => {
  const status = getExpiryStatus(item.expirationDate);
  const days = item.expirationDate ? daysFromToday(item.expirationDate) : null;

  let badgeEl: React.ReactNode = null;
  if (item.expirationDate) {
    if (status === 'expired') {
      badgeEl = (
        <View style={styles.badgeExpired}>
          <Text style={styles.badgeExpiredText}>期限切れ</Text>
        </View>
      );
    } else if (status === 'expiringSoon') {
      const label = days === 0 ? 'あと 0 日' : `あと ${days} 日`;
      badgeEl = (
        <View style={styles.badgeExpiringSoon}>
          <Text style={styles.badgeExpiringSoonText}>{label}</Text>
        </View>
      );
    } else {
      const label = `あと ${days} 日`;
      badgeEl = (
        <View style={styles.badgeNormal}>
          <Text style={styles.badgeNormalText}>{label}</Text>
        </View>
      );
    }
  }

  return (
    <View testID={`pantry-item-${item.id}`} style={styles.row}>
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>
          {item.name}
          {item.amount ? (
            <Text style={styles.amount}>{'  '}{item.amount}</Text>
          ) : null}
        </Text>
      </View>
      <View style={styles.right}>
        {badgeEl}
        <Pressable
          testID={`pantry-delete-${item.id}`}
          onPress={() => onDelete(item.id)}
          hitSlop={8}
          style={styles.deleteBtn}
        >
          <Ionicons name="trash-outline" size={16} color={colors.textMuted} />
        </Pressable>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  info: {
    flex: 1,
    marginRight: spacing.sm,
  },
  name: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  amount: {
    fontSize: 13,
    fontWeight: '400',
    color: colors.textLight,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  badgeExpired: {
    backgroundColor: '#EF9A9A',
    borderRadius: radius.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeExpiredText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#B71C1C',
  },
  badgeExpiringSoon: {
    backgroundColor: colors.warningLight,
    borderRadius: radius.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeExpiringSoonText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.warning,
  },
  badgeNormal: {
    borderRadius: radius.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeNormalText: {
    fontSize: 11,
    color: colors.textMuted,
  },
  deleteBtn: {
    padding: 4,
  },
});
