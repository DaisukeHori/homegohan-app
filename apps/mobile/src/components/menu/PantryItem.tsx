import { Trash2 } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { classifyPantryExpiry, formatLocalDate, parseLocalDate, todayCalendarDate, todayLocal, type PantryExpiryStatus } from '@homegohan/shared';

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

/** 期限の状態 (#1602。Web・モバイルの全画面で共通の PantryExpiryStatus) */
export type ExpiryStatus = PantryExpiryStatus;

/** 1 日のミリ秒 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 期限 (YYYY-MM-DD か ISO 8601 の時刻) が、日本の今日から何日後か (過去は負、今日は 0)。
 * 期限も今日も日本の暦日にしてから数える (#1049 F7-21)。以前は new Date("YYYY-MM-DD") (UTC の 0 時) と
 * 端末の今日を端末のローカル時刻で比べていて、日本より西の端末では期限が 1 日前にずれた。
 * YYYY-MM-DD は UTC の 0 時 = 日本の同じ日の 9 時として読まれるので、日本の暦日にすると同じ日になる。
 * 暦日の差は、夏時間のある端末でも 23・25 時間の日があるだけなので、四捨五入で日数にする
 */
export function daysFromToday(expiryDate: string): number {
  const expiryDay = parseLocalDate(formatLocalDate(new Date(expiryDate)));
  return Math.round((expiryDay.getTime() - todayCalendarDate().getTime()) / MS_PER_DAY);
}

/**
 * 期限の状態 (期限切れ / 期限間近 / それ以外)。判定は全画面共通の classifyPantryExpiry (#1602)。
 * 「期限間近」は今日から PANTRY_EXPIRING_SOON_DAYS (3 日) 後の期限まで (以前はこの表示だけ 1 日以内だった)。
 * 期限は daysFromToday と同じく日本の暦日にしてから比べる (YYYY-MM-DD は同じ日、ISO 8601 の時刻はその時刻の日本の日付)
 */
export function getExpiryStatus(expiryDate: string | null): ExpiryStatus {
  if (!expiryDate) return 'normal';
  return classifyPantryExpiry(formatLocalDate(new Date(expiryDate)), todayLocal());
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
          <Trash2 size={16} color={colors.textMuted} />
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
