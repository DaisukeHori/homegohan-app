import { Redirect } from "expo-router";

import { LoadingState } from "../../src/components/ui";
import { useProfile } from "../../src/providers/ProfileProvider";
import { colors } from "../../src/theme";

// オンボーディングルーティング判定ページ
// 状態に応じて welcome / resume / home にリダイレクト
export default function OnboardingIndex() {
  const { isLoading, profile } = useProfile();

  if (isLoading) {
    return <LoadingState style={{ backgroundColor: colors.bg }} />;
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
