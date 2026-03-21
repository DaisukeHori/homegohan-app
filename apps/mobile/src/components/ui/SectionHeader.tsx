import { ReactNode } from 'react';
import { Text, View, ViewStyle } from 'react-native';
import { colors, spacing } from '../../theme';

type SectionHeaderProps = {
  title: string;
  right?: ReactNode;
  style?: ViewStyle;
};

export function SectionHeader({ title, right, style }: SectionHeaderProps) {
  return (
    <View style={[{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.sm }, style]}>
      <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text }}>{title}</Text>
      {right ?? null}
    </View>
  );
}
