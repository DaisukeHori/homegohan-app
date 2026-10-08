import { Redirect, Stack } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";
import { ActivityIndicator, Text, View } from "react-native";

import { ErrorFallback } from "../../src/components/ErrorFallback";
import { useAuth } from "../../src/providers/AuthProvider";
import { useProfile } from "../../src/providers/ProfileProvider";

// この区画の画面で描画の例外が起きたとき、アプリ全体をクラッシュさせずに再試行を出す (#1207)
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorFallback {...props} boundary="support" homeHref="/(tabs)/home" />;
}

export default function SupportLayout() {
  const { session, isLoading: authLoading } = useAuth();
  const { isLoading: profileLoading, hasRole } = useProfile();

  if (authLoading || profileLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!session) return <Redirect href="/login" />;

  const allowed = hasRole("support") || hasRole("admin") || hasRole("super_admin");
  if (!allowed) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}>
        <Text style={{ color: "#c00" }}>サポート権限がありません</Text>
      </View>
    );
  }

  return <Stack screenOptions={{ headerShown: true }} />;
}



