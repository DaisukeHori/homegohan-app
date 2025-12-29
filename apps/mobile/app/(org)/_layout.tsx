import { Redirect, Stack } from "expo-router";
import { ActivityIndicator, Text, View } from "react-native";

import { useAuth } from "../../src/providers/AuthProvider";
import { useProfile } from "../../src/providers/ProfileProvider";

export default function OrgLayout() {
  const { session, isLoading: authLoading } = useAuth();
  const { isLoading: profileLoading, hasRole, profile } = useProfile();

  if (authLoading || profileLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!session) return <Redirect href="/login" />;

  const allowed = hasRole("org_admin") && !!profile?.organizationId;
  if (!allowed) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}>
        <Text style={{ color: "#c00", marginBottom: 8 }}>組織管理権限がありません</Text>
      </View>
    );
  }

  return <Stack screenOptions={{ headerShown: true }} />;
}



