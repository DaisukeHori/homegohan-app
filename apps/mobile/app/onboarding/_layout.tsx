import { Redirect, Stack } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";

import { ErrorFallback } from "../../src/components/ErrorFallback";
import { LoadingState } from "../../src/components/ui";
import { useAuth } from "../../src/providers/AuthProvider";
import { colors } from "../../src/theme";

// この区画 (初期設定) の画面で描画の例外が起きたとき、アプリ全体をクラッシュさせずに再試行を出す (#1207)。
// 回答はその都度サーバーへ保存されるので、「最初の画面へ戻る」(/ → 初期設定の入口) からやり直せる。
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorFallback {...props} boundary="onboarding" homeHref="/" homeLabel="最初の画面へ戻る" />;
}

export default function OnboardingLayout() {
  const { session, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingState style={{ backgroundColor: colors.bg }} />;
  }

  if (!session) return <Redirect href="/login" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
