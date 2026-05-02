import { ReactNode } from 'react';
import { Text, View, ViewStyle } from 'react-native';
import { colors, radius, shadows, spacing } from '../../theme';

type StatCardProps = {
  icon?: ReactNode;
  label: string;
  value: string | number;
  unit?: string;
  trend?: ReactNode;
  borderColor?: string;
  accentColor?: string;
  style?: ViewStyle;
  testID?: string;
};

export function StatCard({ icon, label, value, unit, trend, borderColor, accentColor, style, testID }: StatCardProps) {
  return (
    <View
      testID={testID}
      style={{
        flex: 1,
        backgroundColor: colors.card,
        borderRadius: radius.xl,
        padding: spacing.lg,
        borderWidth: 1,
        borderColor: borderColor ?? colors.border,
        ...shadows.sm,
        ...style,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        {icon ? (
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: radius.md,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: accentColor ?? colors.accentLight,
            }}
          >
            {icon}
          </View>
        ) : null}
        <View>
          <Text style={{ fontSize: 11, fontWeight: '500', color: colors.textMuted }}>{label}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 2 }}>
            <Text style={{ fontSize: 22, fontWeight: '900', color: colors.text }}>{value}</Text>
            {unit ? <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textMuted }}>{unit}</Text> : null}
          </View>
        </View>
      </View>
      {trend ?? null}
    </View>
  );
}
