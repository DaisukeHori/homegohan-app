import { Stack } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";

import { ErrorFallback } from "../../src/components/ErrorFallback";

// この区画の画面で描画の例外が起きたとき、アプリ全体をクラッシュさせずに再試行を出す (#1207)
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorFallback {...props} boundary="public" homeHref="/" homeLabel="最初の画面へ戻る" />;
}

export default function PublicLayout() {
  return <Stack screenOptions={{ headerShown: true }} />;
}



