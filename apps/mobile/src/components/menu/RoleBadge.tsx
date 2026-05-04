import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { getDishConfig } from '@homegohan/shared';
import { ICON_MAP_IONICONS } from '../../lib/icon-map';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';

interface Props {
  role: string;
}

export const RoleBadge: React.FC<Props> = ({ role }) => {
  if (!role) return null;
  const cfg = getDishConfig(role);
  const color = colors[cfg.colorKey as keyof typeof colors] as string;
  const iconName = ICON_MAP_IONICONS[cfg.iconKey] ?? 'help-circle-outline';

  return (
    <View testID="role-badge" style={[styles.container, { backgroundColor: color + '22' }]}>
      <Ionicons name={iconName as any} size={10} color={color} />
      <Text style={[styles.label, { color }]}>{cfg.label}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 9999,
    alignSelf: 'flex-start',
  },
  label: {
    ...(typography.caption as object),
    fontSize: 10,
    fontWeight: '700',
  },
});
