import { TextStyle } from 'react-native';
import { colors } from './colors';

export const typography = {
  h1: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.text,
  } as TextStyle,
  h2: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.text,
  } as TextStyle,
  h3: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
  } as TextStyle,
  body: {
    fontSize: 15,
    fontWeight: '400',
    color: colors.textLight,
  } as TextStyle,
  bodySmall: {
    fontSize: 13,
    fontWeight: '400',
    color: colors.textMuted,
  } as TextStyle,
  caption: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textMuted,
  } as TextStyle,
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  } as TextStyle,
  number: {
    fontSize: 24,
    fontWeight: '900',
    color: colors.text,
  } as TextStyle,
} as const;
