import { TextStyle } from 'react-native';
import { colors } from './colors';

export const typography = {
  // --- 設計書 COMMON.md Section 2 準拠 ---
  h1:       { fontSize: 24, fontWeight: '800' as const, lineHeight: 32 },
  h2:       { fontSize: 20, fontWeight: '700' as const, lineHeight: 28 },
  h3:       { fontSize: 16, fontWeight: '700' as const, lineHeight: 22 },
  body:     { fontSize: 14, fontWeight: '400' as const, lineHeight: 20 },
  bodyBold: { fontSize: 14, fontWeight: '700' as const, lineHeight: 20 },
  small:    { fontSize: 12, fontWeight: '400' as const, lineHeight: 16 },
  smallBold:{ fontSize: 12, fontWeight: '700' as const, lineHeight: 16 },
  tiny:     { fontSize: 10, fontWeight: '700' as const, lineHeight: 14 },

  // --- 後方互換 (既存スクリーンで参照中のキー) ---
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
