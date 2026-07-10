// Round-3 レビュー指摘 #1: SSR hydration mismatch + 破壊的ボタンの一瞬フラッシュ対策。
// Server Component として cookies() から is_native_app を読み、Client Component
// (SettingsPageClient) へ初期値として渡す。(main)/layout.tsx → MainLayout →
// BottomNav の SSR-safe パターンをこのページにも適用する。
import { cookies } from "next/headers";
import { SettingsPageClient } from "./SettingsPageClient";

export default async function SettingsPage() {
  const cookieStore = await cookies();
  const initialIsNativeApp = cookieStore.get("is_native_app")?.value === "1";

  return <SettingsPageClient initialIsNativeApp={initialIsNativeApp} />;
}
