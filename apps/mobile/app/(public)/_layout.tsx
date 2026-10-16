import { Stack } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";

import { ErrorFallback } from "../../src/components/ErrorFallback";
import { useFontFaceStyle } from "../../src/components/ui/Text";

// この区画の画面で描画の例外が起きたとき、アプリ全体をクラッシュさせずに再試行を出す (#1207)
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorFallback {...props} boundary="public" homeHref="/" homeLabel="最初の画面へ戻る" />;
}

/**
 * 見出しの太さ。iOS のナビゲーションバーの見出しの既定 (semibold) と同じ 600 を、Noto Sans JP の字形 (Bold) で描く。
 * タブの見出し ((tabs)/_layout.tsx の TAB_BAR_LABEL_STYLE) と同じ太さ。
 */
const HEADER_TITLE_WEIGHT = "600";

export default function PublicLayout() {
  // 見出しと戻るボタンの文字は native-stack が中で描くので、共通の部品と同じ字形に置き換えて渡す (#588)
  const headerTitleStyle = useFontFaceStyle(HEADER_TITLE_WEIGHT);
  const headerBackTitleStyle = useFontFaceStyle();
  return <Stack screenOptions={{ headerShown: true, headerTitleStyle, headerBackTitleStyle }} />;
}



