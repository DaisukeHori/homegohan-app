import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { ReactNode } from 'react';
import { Pressable, Text, View, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing } from '../../theme';

type PageHeaderProps = {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  style?: ViewStyle;
  showBack?: boolean;
};

export function PageHeader({ title, subtitle, right, style, showBack = true }: PageHeaderProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[{
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingTop: insets.top + 8,
      paddingBottom: spacing.sm,
      paddingHorizontal: spacing.lg,
      backgroundColor: colors.card,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    }, style]}>
      {showBack && (
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>{title}</Text>
        {subtitle ? <Text style={{ fontSize: 12, color: colors.textMuted }}>{subtitle}</Text> : null}
      </View>
      {right ?? null}
    </View>
  );
}
