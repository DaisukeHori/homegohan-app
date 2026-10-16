import { Children, createContext, forwardRef, isValidElement, useContext } from 'react';
import type { ReactNode } from 'react';
import { Text as RNText, TextInput as RNTextInput } from 'react-native';
import type { StyleProp, TextInputProps, TextProps, TextStyle } from 'react-native';

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
 * Text / TextInput 以外に渡す文字の style (タブの見出しの tabBarLabelStyle など、ライブラリが中で Text を描くもの) を、
 * 共通の部品と同じ字形に置き換える。
 */
export function useFontStyle(style: StyleProp<TextStyle>): StyleProp<TextStyle> {
  return resolveFontStyle(style, { fontsReady: useFontsReady(), inheritFromParent: false });
}

/** react-native の Text と同じ props。字形だけを Noto Sans JP に置き換える */
export const Text = forwardRef<RNText, TextProps>(function Text({ style, children, ...props }, ref) {
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
// ref の型 (useRef<Text>) を react-native と同じに書けるようにする
export type Text = RNText;

/** react-native の TextInput と同じ props。字形だけを Noto Sans JP に置き換える (入力した文字と placeholder の両方) */
export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput({ style, ...props }, ref) {
  const resolved = useFontStyle(style);
  return <RNTextInput ref={ref} {...props} style={resolved} />;
});
// ref の型 (useRef<TextInput>) を react-native と同じに書けるようにする
export type TextInput = RNTextInput;
