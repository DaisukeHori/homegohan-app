import { TextInput, TextInputProps, Text, View, ViewStyle } from 'react-native';
import { colors, radius, spacing } from '../../theme';

type InputProps = TextInputProps & {
  label?: string;
  containerStyle?: ViewStyle;
};

export function Input({ label, containerStyle, style, ...props }: InputProps) {
  return (
    <View style={[{ gap: 6 }, containerStyle]}>
      {label ? <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textMuted}
        style={[
          {
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.card,
            padding: spacing.md,
            borderRadius: radius.md,
            fontSize: 15,
            color: colors.text,
          },
          style,
        ]}
        {...props}
      />
    </View>
  );
}
