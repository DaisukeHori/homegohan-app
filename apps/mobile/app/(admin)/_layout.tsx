import { Redirect, Stack } from "expo-router";
import { ActivityIndicator, Text, View } from "react-native";

import { useAuth } from "../../src/providers/AuthProvider";
import { useProfile } from "../../src/providers/ProfileProvider";

export default function AdminLayout() {
  const { session, isLoading: authLoading } = useAuth();
  const { isLoading: profileLoading, roles, hasRole } = useProfile();

  if (authLoading || profileLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!session) return <Redirect href="/login" />;

  const allowed = hasRole("admin") || hasRole("super_admin");
  if (!allowed) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}>
        <Text style={{ color: "#c00", marginBottom: 8 }}>管理者権限がありません</Text>
        <Text style={{ color: "#666" }}>roles: {roles.join(", ") || "(none)"}</Text>
      </View>
    );
  }

  return <Stack screenOptions={{ headerShown: true }} />;
}



