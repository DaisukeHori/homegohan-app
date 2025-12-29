import { Tabs } from "expo-router";
import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { useAuth } from "../../src/providers/AuthProvider";
import { useProfile } from "../../src/providers/ProfileProvider";

export default function TabsLayout() {
  const { session, isLoading } = useAuth();
  const { isLoading: profileLoading, profile } = useProfile();

  if (isLoading || profileLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!session) return <Redirect href="/" />;
  if (!profile?.nickname) return <Redirect href="/onboarding" />;

  return (
    <Tabs screenOptions={{ headerShown: true }}>
      <Tabs.Screen name="home" options={{ title: "ホーム" }} />
      <Tabs.Screen name="menus" options={{ title: "献立" }} />
      <Tabs.Screen name="meals" options={{ title: "食事" }} />
      <Tabs.Screen name="health" options={{ title: "健康" }} />
      <Tabs.Screen name="settings" options={{ title: "設定" }} />
    </Tabs>
  );
}


