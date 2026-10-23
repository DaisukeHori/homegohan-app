/**
 * ログインの後の振り分け (docs/design/mobile/08-sign-in-with-apple.md §9.1)。
 * apps/mobile/app/(auth)/login.tsx の中にあった routeAfterSignIn をそのまま移した (メール・パスワード / Google / Apple の 3 つの入口で共通)。
 * user_profiles から初期設定の状態を読み、?next= (/ 始まりだけ) があればそこへ、無ければ 完了 → ホーム / 開始済み → 再開 / 未開始 → ウェルカム。
 * (#1122: admin / super_admin も同じ振り分け)
 */
import { router } from "expo-router";

import { supabase } from "./supabase";

export async function routeAfterSignIn(next: string | string[] | undefined): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("onboarding_started_at, onboarding_completed_at")
    .eq("id", user.id)
    .single();

  // ?next= クエリパラメータがある場合はそのパスへ復帰 (/ 始まりのみ許可)
  const safeNext = typeof next === "string" && next.startsWith("/") ? next : null;

  if (safeNext) {
    router.replace(safeNext as never);
  } else if (profile?.onboarding_completed_at) {
    // オンボーディング完了済み → ホームへ
    router.replace("/(tabs)/home");
  } else if (profile?.onboarding_started_at) {
    // オンボーディング進行中 → 再開ページへ
    router.replace("/onboarding/resume");
  } else {
    // 未開始 → 初回ウェルカムへ
    router.replace("/onboarding/welcome");
  }
}
