import { Redirect, Stack, useSegments } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { useAuth } from "../../src/providers/AuthProvider";

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



