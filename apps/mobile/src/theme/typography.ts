import { TextStyle } from 'react-native';
import { colors } from './colors';
import { fontFamilies } from './fonts';

export const typography = {
  // --- 設計書 COMMON.md Section 2 準拠 ---
  // 字形の名前は src/theme/fonts.ts。共通の部品 (src/components/ui/Text.tsx) が、読み込みに失敗したときはシステムの字形に戻す
  h1:       { fontFamily: fontFamilies.bold, fontSize: 24, lineHeight: 32 },
  h2:       { fontFamily: fontFamilies.bold, fontSize: 20, lineHeight: 28 },
  h3:       { fontFamily: fontFamilies.bold, fontSize: 16, lineHeight: 22 },
  body:     { fontFamily: fontFamilies.regular, fontSize: 14, lineHeight: 20 },
  bodyBold: { fontFamily: fontFamilies.bold, fontSize: 14, lineHeight: 20 },
  small:    { fontFamily: fontFamilies.regular, fontSize: 12, lineHeight: 16 },
  smallBold:{ fontFamily: fontFamilies.bold, fontSize: 12, lineHeight: 16 },
  tiny:     { fontFamily: fontFamilies.bold, fontSize: 10, lineHeight: 14 },

  // --- 後方互換 (既存スクリーンで参照中のキー) ---
  bodySmall: {
    fontFamily: fontFamilies.regular,
    fontSize: 13,
    color: colors.textMuted,
  } as TextStyle,
  caption: {
    fontFamily: fontFamilies.medium,
    fontSize: 12,
    color: colors.textMuted,
  } as TextStyle,
  label: {
    fontFamily: fontFamilies.medium,
    fontSize: 14,
    color: colors.text,
  } as TextStyle,
  number: {
    fontFamily: fontFamilies.bold,
    fontSize: 24,
    color: colors.text,
  } as TextStyle,
} as const;
