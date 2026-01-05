import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { useProfile } from "../../src/providers/ProfileProvider";

// オンボーディングルーティング判定ページ
// 状態に応じて welcome / resume / home にリダイレクト
export default function OnboardingIndex() {
  const { isLoading, profile } = useProfile();

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#FFF7ED" }}>
        <ActivityIndicator size="large" color="#FF8A65" />
      </View>
    );
  }

  // 状態判定
  if (profile?.onboardingCompletedAt) {
    // 完了済み → ホームへ
    return <Redirect href="/(tabs)/home" />;
  } else if (profile?.onboardingStartedAt) {
    // 進行中 → 再開ページへ
    return <Redirect href="/onboarding/resume" />;
  } else {
    // 未開始 → ウェルカムページへ
    return <Redirect href="/onboarding/welcome" />;
  }
}
