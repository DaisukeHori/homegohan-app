import { BarChart3, Calendar, ChefHat, Flame, Refrigerator, ShoppingCart } from 'lucide-react-native';
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
      <View style={styles.row}>
        {/* 左カラム */}
        <View style={styles.leftColumn}>
          <View style={styles.titleRow}>
            <Calendar size={20} color={colors.accent} />
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
              <Text style={styles.statText}>平均 {weeklyStats.avgKcal} kcal/日</Text>
            </View>
          </View>
        </View>
        {/* 右カラム */}
        <View style={styles.actions}>
          <Pressable testID="header-stats-btn" onPress={onPressStats} style={styles.iconBtn}>
            <BarChart3 size={20} color={colors.text} />
          </Pressable>
          <Pressable
            testID="header-fridge-btn"
            onPress={onPressFridge}
            style={[styles.iconBtn, fridgeDanger && styles.iconBtnDanger]}
          >
            <Refrigerator size={20} color={fridgeDanger ? colors.danger : colors.text} />
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
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  leftColumn: {
    flex: 1,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
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
    gap: spacing.xs,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconBtnDanger: {
    backgroundColor: colors.dangerLight,
    borderColor: colors.danger,
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
