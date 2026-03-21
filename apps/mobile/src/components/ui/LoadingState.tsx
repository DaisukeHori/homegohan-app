import { ActivityIndicator, Text, View, ViewStyle } from 'react-native';
import { colors, spacing } from '../../theme';

type LoadingStateProps = {
  message?: string;
  style?: ViewStyle;
};

export function LoadingState({ message, style }: LoadingStateProps) {
  return (
    <View style={[{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing['4xl'] }, style]}>
      <ActivityIndicator size="large" color={colors.accent} />
      {message ? <Text style={{ marginTop: spacing.md, fontSize: 14, color: colors.textMuted }}>{message}</Text> : null}
    </View>
  );
}
