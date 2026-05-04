import { ReactNode } from 'react';
import { Pressable, View, ViewStyle } from 'react-native';
import { colors, radius, shadows, spacing } from '../../theme';

type CardProps = {
  children: ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  variant?: 'default' | 'accent' | 'success' | 'warning' | 'error' | 'purple';
  padding?: keyof typeof spacing;
  testID?: string;
};

const BORDER_COLORS: Record<string, string> = {
  default: colors.border,
  accent: '#FED7AA',
  success: '#C8E6C9',
  warning: '#FFE0B2',
  error: '#FFCDD2',
  purple: '#D1C4E9',
};

export function Card({ children, onPress, style, variant = 'default', padding = 'lg', testID }: CardProps) {
  const cardStyle: ViewStyle = {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing[padding],
    borderWidth: 1,
    borderColor: BORDER_COLORS[variant] ?? colors.border,
    ...shadows.sm,
    ...style,
  };

  if (onPress) {
    return (
      <Pressable testID={testID} onPress={onPress} style={({ pressed }) => [cardStyle, pressed && { opacity: 0.9, transform: [{ scale: 0.99 }] }]}>
        {children}
      </Pressable>
    );
  }

  return <View testID={testID} style={cardStyle}>{children}</View>;
}
