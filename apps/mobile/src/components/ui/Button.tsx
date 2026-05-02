import { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, ViewStyle } from 'react-native';
import { colors, radius } from '../../theme';

type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost' | 'outline';

type ButtonProps = {
  children: ReactNode;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg';
  style?: ViewStyle;
  testID?: string;
};

const VARIANT_STYLES: Record<ButtonVariant, { bg: string; bgPressed: string; text: string; border?: string }> = {
  primary: { bg: colors.accent, bgPressed: colors.accentDark, text: '#FFFFFF' },
  secondary: { bg: colors.bg, bgPressed: '#EDEDED', text: colors.text, border: colors.border },
  destructive: { bg: colors.error, bgPressed: '#D32F2F', text: '#FFFFFF' },
  ghost: { bg: 'transparent', bgPressed: colors.bg, text: colors.textLight },
  outline: { bg: 'transparent', bgPressed: colors.bg, text: colors.accent, border: colors.accent },
};

const SIZE_STYLES: Record<string, { paddingV: number; paddingH: number; fontSize: number }> = {
  sm: { paddingV: 8, paddingH: 12, fontSize: 13 },
  md: { paddingV: 12, paddingH: 16, fontSize: 15 },
  lg: { paddingV: 16, paddingH: 20, fontSize: 16 },
};

export function Button({ children, onPress, variant = 'primary', disabled, loading, size = 'md', style, testID }: ButtonProps) {
  const v = VARIANT_STYLES[variant];
  const s = SIZE_STYLES[size];
  const isDisabled = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      testID={testID}
      style={({ pressed }) => {
        const base: ViewStyle = {
          backgroundColor: isDisabled ? colors.textMuted : pressed ? v.bgPressed : v.bg,
          paddingVertical: s.paddingV,
          paddingHorizontal: s.paddingH,
          borderRadius: radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 8,
          ...(v.border && !isDisabled ? { borderWidth: 1, borderColor: v.border } : {}),
          ...style,
        };
        return base;
      }}
    >
      {loading ? <ActivityIndicator size="small" color={v.text} /> : null}
      {typeof children === 'string' ? (
        <Text style={{ color: isDisabled ? '#FFFFFF' : v.text, fontSize: s.fontSize, fontWeight: '700' }}>{children}</Text>
      ) : (
        children
      )}
    </Pressable>
  );
}
