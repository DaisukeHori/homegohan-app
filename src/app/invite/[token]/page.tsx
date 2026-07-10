// Round-3 レビュー指摘 #2: 「ログアウトしてやり直す」ボタンが isNativeApp 未ガードで
// signOut() を呼んでいた問題の SSR-safe な修正。Server Component として cookies() から
// is_native_app を読み、token と併せて Client Component (InvitePageClient) へ渡す。
// (main)/layout.tsx → MainLayout → BottomNav と同じ SSR-safe パターン。
import { cookies } from "next/headers";
import { InvitePageClient } from "./InvitePageClient";

type PageProps = {
  params: Promise<{ token: string }>;
};

export default async function InvitePage({ params }: PageProps) {
  const { token } = await params;
  const cookieStore = await cookies();
  const initialIsNativeApp = cookieStore.get("is_native_app")?.value === "1";

  return <InvitePageClient token={token} initialIsNativeApp={initialIsNativeApp} />;
}
