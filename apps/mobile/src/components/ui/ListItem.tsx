import { ReactNode } from 'react';
import { Pressable, Text, View, ViewStyle } from 'react-native';
import { colors, radius, shadows, spacing } from '../../theme';

type ListItemProps = {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  left?: ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  highlighted?: boolean;
};

export function ListItem({ title, subtitle, right, left, onPress, style, highlighted }: ListItemProps) {
  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        padding: spacing.lg,
        backgroundColor: highlighted ? colors.successLight : colors.card,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        ...shadows.sm,
        ...style,
      }}
    >
      {left ?? null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 15, fontWeight: '700', color: colors.text }}>{title}</Text>
        {subtitle ? <Text style={{ fontSize: 13, color: colors.textMuted }}>{subtitle}</Text> : null}
      </View>
      {right ?? null}
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => (pressed ? { opacity: 0.9, transform: [{ scale: 0.99 }] } : {})}>
        {content}
      </Pressable>
    );
  }

  return content;
}
