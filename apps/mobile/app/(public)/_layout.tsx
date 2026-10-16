import { Stack } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";

import { ErrorFallback } from "../../src/components/ErrorFallback";

// この区画の画面で描画の例外が起きたとき、アプリ全体をクラッシュさせずに再試行を出す (#1207)
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorFallback {...props} boundary="public" homeHref="/" homeLabel="最初の画面へ戻る" />;
}

/**
 * native-stack のヘッダは出さない (#1822)。見出し (日本語) と戻る操作は、各画面の PublicPage
 * (src/components/PublicPage.tsx) が自前のヘッダで描く。出すと、route 名 (about など) の見出しのヘッダと
 * 2 段になる。
 * ヘッダを出さないので、native-stack が描く文字 (headerTitleStyle / headerBackTitleStyle) は渡さない
 * (__tests__/theme/font-family-guard.test.ts の 5 つ目は、headerShown: false の区画にはそれを求めない)。
 * Android の端末の戻るボタンと iOS のスワイプで戻る操作は、ヘッダの有無にかかわらず native-stack の既定で効く。
 */
export default function PublicLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
