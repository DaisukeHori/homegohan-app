import { StyleSheet } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';

/**
 * モバイルの文字の書体 (#588)。web (src/app/layout.tsx の next/font) と同じ Noto Sans JP の
 * Regular (400) / Medium (500) / Bold (700) の 3 つの字形だけを読み込む。
 *
 * 値は expo-font に登録する名前で、そのまま style の fontFamily に書く名前でもある
 * (読み込みは app/_layout.tsx、字形のファイルは src/theme/fontSources.ts)。
 */
export const fontFamilies = {
  regular: 'NotoSansJP_400Regular',
  medium: 'NotoSansJP_500Medium',
  bold: 'NotoSansJP_700Bold',
} as const;

export type FontFace = keyof typeof fontFamilies;
export type NotoSansJpFamily = (typeof fontFamilies)[FontFace];

type FontWeight = NonNullable<TextStyle['fontWeight']>;

/**
 * fontWeight → 読み込んである 3 つの字形のどれを使うか。
 * CSS の字形の選び方 (font-matching) と同じ結果にする: web も 400 / 500 / 700 しか読み込んでいないので、
 * 600 以上はより太い 700 (Bold)、400 以下は 400 (Regular) が選ばれる。web と同じ太さに見せるため。
 * RN の fontWeight の全ての値を並べ、値が増えたら型検査で漏れが分かるようにしている
 * (数の 100〜900 は、オブジェクトのキーとしては文字列の '100'〜'900' と同じなので、文字列のキーで受ける)。
 */
const FACE_BY_WEIGHT: Record<FontWeight, FontFace> = {
  normal: 'regular',
  regular: 'regular',
  ultralight: 'regular',
  thin: 'regular',
  light: 'regular',
  condensed: 'regular',
  '100': 'regular',
  '200': 'regular',
  '300': 'regular',
  '400': 'regular',
  medium: 'medium',
  '500': 'medium',
  semibold: 'bold',
  bold: 'bold',
  condensedBold: 'bold',
  heavy: 'bold',
  black: 'bold',
  '600': 'bold',
  '700': 'bold',
  '800': 'bold',
  '900': 'bold',
};

/**
 * 字形の読み込みに失敗したとき (システムの字形に戻すとき) の太さ。
 * Noto Sans JP の字形名だけで太さを表していた style (typography のトークンなど) の太さを、fontWeight で残すため。
 */
const FALLBACK_WEIGHT_BY_FACE: Record<FontFace, FontWeight | undefined> = {
  regular: undefined,
  medium: '500',
  bold: '700',
};

/** fontWeight (未指定は Regular) に対応する Noto Sans JP の字形 */
export function fontFaceForWeight(weight: TextStyle['fontWeight']): FontFace {
  return weight === undefined ? 'regular' : FACE_BY_WEIGHT[weight];
}

/** fontFamily が Noto Sans JP の字形名なら、その字形。別の書体 (や未指定) なら undefined */
export function notoFaceOfFamily(fontFamily: string | undefined): FontFace | undefined {
  if (fontFamily === undefined) return undefined;
  const faces = Object.keys(fontFamilies) as FontFace[];
  return faces.find((face) => fontFamilies[face] === fontFamily);
}

/**
 * Text / TextInput の style を、Noto Sans JP の字形に置き換える (#588)。
 *
 * - 字形を読み込めた (fontsReady = true): fontWeight (と Noto の字形名) から字形を決め、fontFamily に入れて、
 *   fontWeight は外す。Android は fontWeight だけでは太字の字形を選ばず、字形名と fontWeight を両方指定すると
 *   太字の字形をさらに太らせて (疑似太字) 描くため。fontWeight が指定されていれば、それが字形名より優先する
 *   (`[typography.body, { fontWeight: '700' }]` は Bold)。
 * - 読み込み前・失敗 (fontsReady = false): システムの字形のまま描く。Noto の字形名は外し、
 *   字形名で表していた太さは fontWeight に残す。
 * - Noto Sans JP 以外の書体を指定している style は触らない。
 * - 入れ子の Text (inheritFromParent = true) で、太さも字形名も指定していないものは触らない。
 *   RN は入れ子の Text に親の字形を引き継ぐので、ここで Regular を入れると親の太字が消えるため。
 */
export function resolveFontStyle(
  style: StyleProp<TextStyle>,
  { fontsReady, inheritFromParent }: { fontsReady: boolean; inheritFromParent: boolean },
): StyleProp<TextStyle> {
  const flat: TextStyle = StyleSheet.flatten(style) ?? {};
  const { fontFamily, fontWeight, ...rest } = flat;
  const notoFace = notoFaceOfFamily(fontFamily);
  // 別の書体を指定している
  if (fontFamily !== undefined && notoFace === undefined) return style;
  // 入れ子で、太さを指定していない (親の字形を引き継ぐ)
  if (inheritFromParent && fontWeight === undefined && notoFace === undefined) return style;

  if (fontsReady) {
    const face = fontWeight !== undefined ? fontFaceForWeight(fontWeight) : notoFace ?? 'regular';
    return { ...rest, fontFamily: fontFamilies[face] };
  }

  // 読み込み前・失敗: 変えるものが無ければ、渡された style をそのまま返す
  if (notoFace === undefined) return style;
  const weight = fontWeight ?? FALLBACK_WEIGHT_BY_FACE[notoFace];
  return weight === undefined ? rest : { ...rest, fontWeight: weight };
}
