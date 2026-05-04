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
  testID?: string;
};

export function EmptyState({ icon, message, actionLabel, onAction, style, testID }: EmptyStateProps) {
  return (
    <View testID={testID} style={[{ alignItems: 'center', paddingVertical: spacing['3xl'], gap: spacing.md }, style]}>
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
