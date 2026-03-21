import { ReactNode } from 'react';
import { Text, View, ViewStyle } from 'react-native';
import { colors, spacing } from '../../theme';
import { Button } from './Button';

type EmptyStateProps = {
  icon?: ReactNode;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: ViewStyle;
};

export function EmptyState({ icon, message, actionLabel, onAction, style }: EmptyStateProps) {
  return (
    <View style={[{ alignItems: 'center', paddingVertical: spacing['3xl'], gap: spacing.md }, style]}>
      {icon ?? null}
      <Text style={{ fontSize: 15, color: colors.textMuted, textAlign: 'center' }}>{message}</Text>
      {actionLabel && onAction ? (
        <Button onPress={onAction} variant="outline" size="sm">
          {actionLabel}
        </Button>
      ) : null}
    </View>
  );
}
