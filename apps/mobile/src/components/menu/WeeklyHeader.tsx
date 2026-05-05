import { BarChart3, ChefHat, Flame, Refrigerator, ShoppingCart } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../../theme/colors';
import { spacing } from '../../theme/spacing';
import { typography } from '../../theme/typography';

interface Props {
  weekRangeLabel: string;
  weeklyStats: {
    cookRate: number;
    avgKcal: number;
  };
  expiringCount: number;
  uncheckedShoppingCount: number;
  onPressStats: () => void;
  onPressFridge: () => void;
  onPressShopping: () => void;
}

export const WeeklyHeader: React.FC<Props> = ({
  weekRangeLabel,
  weeklyStats,
  expiringCount,
  uncheckedShoppingCount,
  onPressStats,
  onPressFridge,
  onPressShopping,
}) => {
  const fridgeDanger = expiringCount > 0;

  return (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>献立表</Text>
        <Text style={styles.weekLabel}>{weekRangeLabel}</Text>
      </View>
      <View style={styles.statsRow}>
        <View style={styles.statItem}>
          <ChefHat size={14} color={colors.textLight} />
          <Text style={styles.statText}>自炊率 {weeklyStats.cookRate}%</Text>
        </View>
        <View style={styles.statItem}>
          <Flame size={14} color={colors.textLight} />
          <Text style={styles.statText}>平均 {weeklyStats.avgKcal} kcal</Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Pressable testID="header-stats-btn" onPress={onPressStats} style={styles.iconBtn}>
          <BarChart3 size={20} color={colors.text} />
        </Pressable>
        <Pressable
          testID="header-fridge-btn"
          onPress={onPressFridge}
          style={[styles.iconBtn, fridgeDanger && styles.iconBtnDanger]}
        >
          <Refrigerator size={20} color={fridgeDanger ? colors.error : colors.text} />
          {expiringCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{expiringCount}</Text>
            </View>
          )}
        </Pressable>
        <Pressable testID="header-shopping-btn" onPress={onPressShopping} style={styles.iconBtn}>
          <ShoppingCart size={20} color={colors.text} />
          {uncheckedShoppingCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{uncheckedShoppingCount}</Text>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  titleRow: {
    flexDirection: 'column',
    gap: spacing.xs,
  },
  title: {
    ...typography.h2,
    color: colors.text,
  },
  weekLabel: {
    ...typography.body,
    color: colors.textMuted,
  },
  statsRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginTop: spacing.xs,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statText: {
    ...typography.bodySmall,
    color: colors.textLight,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.card,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    borderWidth: 1,
    borderColor: colors.border,
  },
  iconBtnDanger: {
    backgroundColor: colors.errorLight,
    borderColor: colors.error,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  badgeText: {
    ...typography.caption,
    color: '#FFF',
    fontSize: 10,
    fontWeight: '700',
  },
});
