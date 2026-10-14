import { Redirect, Stack, useSegments } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { ErrorFallback } from "../../src/components/ErrorFallback";
import { useAuth } from "../../src/providers/AuthProvider";

// この区画の画面で描画の例外が起きたとき、アプリ全体をクラッシュさせずに再試行を出す (#1207)
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorFallback {...props} boundary="auth" homeHref="/" homeLabel="最初の画面へ戻る" />;
}

export default function AuthLayout() {
  const { session, isLoading } = useAuth();
  const segments = useSegments();

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  // reset-password と verify はセッション確立後もアクセスが必要
  const currentRoute = segments[segments.length - 1];
  const allowWithSession = currentRoute === "reset-password" || currentRoute === "verify";

  if (session && !allowWithSession) return <Redirect href="/(tabs)/home" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}



