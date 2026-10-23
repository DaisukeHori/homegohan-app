import { Redirect, Stack } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";

import { ErrorFallback } from "../../src/components/ErrorFallback";
import { LoadingState } from "../../src/components/ui";
import { useAccountFrozen } from "../../src/providers/AccountFrozenProvider";
import { useAuth } from "../../src/providers/AuthProvider";
import { useLegalConsent } from "../../src/providers/LegalConsentProvider";
import { colors } from "../../src/theme";

// この区画 (初期設定) の画面で描画の例外が起きたとき、アプリ全体をクラッシュさせずに再試行を出す (#1207)。
// 回答はその都度サーバーへ保存されるので、「最初の画面へ戻る」(/ → 初期設定の入口) からやり直せる。
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorFallback {...props} boundary="onboarding" homeHref="/" homeLabel="最初の画面へ戻る" />;
}

export default function OnboardingLayout() {
  const { session, isLoading } = useAuth();
  const { state: legalConsentState } = useLegalConsent();
  const { state: frozenState } = useAccountFrozen();

  // #1442: ログインの直後 (ログイン・新規登録の画面から呼ぶ routeAfterSignIn (src/lib/routeAfterSignIn.ts) が /onboarding/welcome・/onboarding/resume へ入口を通らずに移る) も、
  // 同意の状態が分かるまで・同意が要る間は初期設定の画面を描かない (初期設定より先に同意)。unknown は待たない。
  // 初期設定の途中で同意が要るようになったときも描かない (LegalConsentGate が畳む。答えはその都度保存されているので、
  // 同意の後に入口から /onboarding/resume で続きから進める)。session 無しは今までどおり /login へ回す
  // #1861: 凍結の状態が分かるまで・凍結中も描かない (AccountFrozenGate が凍結の画面 1 つに畳む)
  if (
    isLoading ||
    (session &&
      (legalConsentState === "loading" ||
        legalConsentState === "required" ||
        frozenState === "loading" ||
        frozenState === "frozen"))
  ) {
    return <LoadingState style={{ backgroundColor: colors.bg }} />;
  }

  if (!session) return <Redirect href="/login" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
