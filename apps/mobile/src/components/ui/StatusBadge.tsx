import { Text, View, ViewStyle } from 'react-native';
import { colors } from '../../theme';

type BadgeVariant = 'completed' | 'pending' | 'generating' | 'alert' | 'info' | 'ai' | 'manual';

type StatusBadgeProps = {
  variant: BadgeVariant;
  label?: string;
  style?: ViewStyle;
};

const CONFIG: Record<BadgeVariant, { bg: string; text: string; defaultLabel: string }> = {
  completed: { bg: colors.successLight, text: colors.success, defaultLabel: '完了' },
  pending: { bg: colors.bg, text: colors.textMuted, defaultLabel: '未完了' },
  generating: { bg: colors.warningLight, text: colors.warning, defaultLabel: '生成中' },
  alert: { bg: colors.errorLight, text: colors.error, defaultLabel: '要確認' },
  info: { bg: colors.blueLight, text: colors.blue, defaultLabel: '情報' },
  ai: { bg: colors.successLight, text: '#2E7D32', defaultLabel: 'AI' },
  manual: { bg: colors.warningLight, text: '#E65100', defaultLabel: '手動' },
};

export function StatusBadge({ variant, label, style }: StatusBadgeProps) {
  const c = CONFIG[variant];
  return (
    <View
      style={{
        backgroundColor: c.bg,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        alignSelf: 'flex-start',
        ...style,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: '700', color: c.text }}>{label ?? c.defaultLabel}</Text>
    </View>
  );
}
