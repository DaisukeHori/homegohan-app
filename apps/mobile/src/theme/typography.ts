import { TextStyle } from 'react-native';
import { colors } from './colors';

export const typography = {
  // --- 設計書 COMMON.md Section 2 準拠 ---
  h1:       { fontFamily: 'NotoSansJP_700Bold',    fontSize: 24, lineHeight: 32 },
  h2:       { fontFamily: 'NotoSansJP_700Bold',    fontSize: 20, lineHeight: 28 },
  h3:       { fontFamily: 'NotoSansJP_700Bold',    fontSize: 16, lineHeight: 22 },
  body:     { fontFamily: 'NotoSansJP_400Regular', fontSize: 14, lineHeight: 20 },
  bodyBold: { fontFamily: 'NotoSansJP_700Bold',    fontSize: 14, lineHeight: 20 },
  small:    { fontFamily: 'NotoSansJP_400Regular', fontSize: 12, lineHeight: 16 },
  smallBold:{ fontFamily: 'NotoSansJP_700Bold',    fontSize: 12, lineHeight: 16 },
  tiny:     { fontFamily: 'NotoSansJP_700Bold',    fontSize: 10, lineHeight: 14 },

  // --- 後方互換 (既存スクリーンで参照中のキー) ---
  bodySmall: {
    fontFamily: 'NotoSansJP_400Regular',
    fontSize: 13,
    color: colors.textMuted,
  } as TextStyle,
  caption: {
    fontFamily: 'NotoSansJP_500Medium',
    fontSize: 12,
    color: colors.textMuted,
  } as TextStyle,
  label: {
    fontFamily: 'NotoSansJP_500Medium',
    fontSize: 14,
    color: colors.text,
  } as TextStyle,
  number: {
    fontFamily: 'NotoSansJP_700Bold',
    fontSize: 24,
    color: colors.text,
  } as TextStyle,
} as const;
