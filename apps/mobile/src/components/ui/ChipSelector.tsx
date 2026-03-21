import { Pressable, ScrollView, Text, View, ViewStyle } from 'react-native';
import { colors, radius, spacing } from '../../theme';

type ChipOption<T extends string = string> = {
  value: T;
  label: string;
};

type ChipSelectorProps<T extends string = string> = {
  options: ChipOption<T>[];
  selected: T | T[];
  onSelect: (value: T) => void;
  multiple?: boolean;
  scrollable?: boolean;
  style?: ViewStyle;
};

export function ChipSelector<T extends string = string>({
  options,
  selected,
  onSelect,
  scrollable,
  style,
}: ChipSelectorProps<T>) {
  const isSelected = (value: T) => (Array.isArray(selected) ? selected.includes(value) : selected === value);

  const chips = options.map((opt) => {
    const active = isSelected(opt.value);
    return (
      <Pressable
        key={opt.value}
        onPress={() => onSelect(opt.value)}
        style={{
          paddingVertical: 8,
          paddingHorizontal: 14,
          borderRadius: radius.full,
          backgroundColor: active ? colors.accent : colors.bg,
          borderWidth: 1,
          borderColor: active ? colors.accent : colors.border,
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: '700', color: active ? '#FFFFFF' : colors.textLight }}>{opt.label}</Text>
      </Pressable>
    );
  });

  if (scrollable) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[{ gap: spacing.sm }, style]}>
        {chips}
      </ScrollView>
    );
  }

  return <View style={[{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }, style]}>{chips}</View>;
}
