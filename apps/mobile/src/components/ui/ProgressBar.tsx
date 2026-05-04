import { Text, View, ViewStyle } from 'react-native';
import { colors } from '../../theme';

type ProgressBarProps = {
  value: number;
  max: number;
  color?: string;
  bgColor?: string;
  height?: number;
  label?: string;
  showPercentage?: boolean;
  style?: ViewStyle;
  testID?: string;
};

export function ProgressBar({
  value,
  max,
  color = colors.accent,
  bgColor = colors.border,
  height = 6,
  label,
  showPercentage,
  style,
  testID,
}: ProgressBarProps) {
  const pct = max > 0 ? Math.min(Math.round((value / max) * 100), 100) : 0;

  return (
    <View testID={testID} style={[{ gap: 4 }, style]}>
      {(label || showPercentage) && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {label ? <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textLight }}>{label}</Text> : null}
          {showPercentage ? <Text style={{ fontSize: 12, fontWeight: '600', color }}>{pct}%</Text> : null}
        </View>
      )}
      <View style={{ height, backgroundColor: bgColor, borderRadius: height / 2, overflow: 'hidden' }}>
        <View style={{ height: '100%', width: `${pct}%`, backgroundColor: color, borderRadius: height / 2 }} />
      </View>
    </View>
  );
}
