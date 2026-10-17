import { Children, createContext, forwardRef, isValidElement, useContext } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text as RNText, TextInput as RNTextInput } from 'react-native';
import type { StyleProp, TextInputInstance, TextInputProps, TextInstance, TextProps, TextStyle } from 'react-native';

import { resolveFontStyle } from '../../theme/fonts';

/**
 * 文字の共通の部品 (#588)。アプリの画面は react-native の Text / TextInput ではなく、ここの Text / TextInput を使う
 * (__tests__/theme/font-family-guard.test.ts が、react-native から直接読んでいないことを確かめる)。
 *
 * style の fontWeight (と typography のトークンの字形名) を、Noto Sans JP の Regular / Medium / Bold の字形に置き換えて描く
 * (置き換え方は src/theme/fonts.ts の resolveFontStyle)。
 * ui/index.ts からは export しない (画面はこのファイルから直接 import する)。
 */

/**
 * Noto Sans JP の字形を読み込めたかどうか。app/_layout.tsx が読み込みの結果を入れる。
 * Provider の外 (ルートの ErrorBoundary は layout ごと置き換えて描かれる) と、読み込みに失敗したときは false で、
 * システムの字形のまま描く (登録されていない字形名を渡さない)。
 */
const FontsReadyContext = createContext(false);

/** この部品の Text の中 (入れ子の Text) かどうか。入れ子の Text は、太さを指定していなければ親の字形を引き継ぐ */
const InsideTextContext = createContext(false);

export function FontsReadyProvider({ ready, children }: { ready: boolean; children: ReactNode }) {
  return <FontsReadyContext.Provider value={ready}>{children}</FontsReadyContext.Provider>;
}

/** Noto Sans JP の字形を読み込めたかどうか */
function useFontsReady(): boolean {
  return useContext(FontsReadyContext);
}

/**
 * Text / TextInput 以外に渡す文字の style (タブの見出しの tabBarLabelStyle など、ライブラリが中で Text を描き、
 * TextStyle をそのまま受けるもの) を、共通の部品と同じ字形に置き換える。
 */
export function useFontStyle(style: StyleProp<TextStyle>): StyleProp<TextStyle> {
  return resolveFontStyle(style, { fontsReady: useFontsReady(), inheritFromParent: false });
}

/** 字形の props (fontFamily / fontWeight) だけを受けるライブラリに渡す style */
export type FontFaceStyle = Pick<TextStyle, 'fontFamily' | 'fontWeight'>;

/**
 * 字形の props だけを受けるライブラリ (native-stack の見出しの headerTitleStyle・戻るボタンの文字の headerBackTitleStyle など。
 * TextStyle のほかの props や ColorValue の color は受けない) に渡す style を、共通の部品と同じ字形で作る。
 * fontWeight を省くと Regular。字形を読み込めていないときは、システムの字形のまま fontWeight だけを返す (省いたときは空)。
 */
export function useFontFaceStyle(fontWeight?: TextStyle['fontWeight']): FontFaceStyle {
  const resolved: TextStyle = StyleSheet.flatten(useFontStyle(fontWeight === undefined ? {} : { fontWeight })) ?? {};
  // react-native 0.88 の TextStyle は読み取り専用なので、代入でなく展開で組む
  return {
    ...(resolved.fontFamily === undefined ? {} : { fontFamily: resolved.fontFamily }),
    ...(resolved.fontWeight === undefined ? {} : { fontWeight: resolved.fontWeight }),
  };
}

/** react-native の Text と同じ props。字形だけを Noto Sans JP に置き換える */
export const Text = forwardRef<TextInstance, TextProps>(function Text({ style, children, ...props }, ref) {
  const fontsReady = useFontsReady();
  const inheritFromParent = useContext(InsideTextContext);
  const resolved = resolveFontStyle(style, { fontsReady, inheritFromParent });
  // 入れ子の Text がありうる (子に部品がある) ときだけ、子に「Text の中」を伝える。
  // 文字だけの子はそのまま渡す (react-native の Text と同じ children のまま描く)
  const hasElementChild = Children.toArray(children).some(isValidElement);
  return (
    <RNText ref={ref} {...props} style={resolved}>
      {hasElementChild ? <InsideTextContext.Provider value>{children}</InsideTextContext.Provider> : children}
    </RNText>
  );
});
// ref の型 (useRef<Text>) を react-native と同じに書けるようにする (react-native 0.88 の Text は関数なので、実体の型は TextInstance)
export type Text = TextInstance;

/** react-native の TextInput と同じ props。字形だけを Noto Sans JP に置き換える (入力した文字と placeholder の両方) */
export const TextInput = forwardRef<TextInputInstance, TextInputProps>(function TextInput({ style, ...props }, ref) {
  const resolved = useFontStyle(style);
  return <RNTextInput ref={ref} {...props} style={resolved} />;
});
// ref の型 (useRef<TextInput>) を react-native と同じに書けるようにする (react-native 0.88 の TextInput は関数なので、実体の型は TextInputInstance)
export type TextInput = TextInputInstance;
