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
  
  // オンボーディング状態に応じてリダイレクト
  if (profile?.onboardingCompletedAt) {
    // 完了済み → そのまま表示
  } else if (profile?.onboardingStartedAt) {
    // 進行中 → 再開ページへ
    return <Redirect href="/onboarding/resume" />;
  } else {
    // 未開始 → ウェルカムページへ
    return <Redirect href="/onboarding/welcome" />;
  }

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


