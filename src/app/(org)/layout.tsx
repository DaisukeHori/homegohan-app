"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { motion } from "framer-motion";
import { clearUserScopedLocalStorage, broadcastSignOut } from "@/lib/user-storage";
import { notifyNativeSignOut } from "@/lib/native-auth-bridge";
import { isOrgAdmin as isOrgAdminProfile } from "@/lib/auth/org-admin";
import { readOrgSidebarInfo } from "@/lib/org-sidebar";

/**
 * 自分のプロフィール (組織の管理者かどうか) を読み込めなかったときの文。
 * 管理者でない (ホームへ移る) と見分けるために出す (#2064 R4 と同じ型。以前は読み込めなかったときも管理者でない扱いでホームへ移し、
 * 例外を投げたときは catch が無く、読み込み中の表示のまま止まっていた)。失敗の理由 (英語の内部の文) は画面に出さない
 */
const ORG_ADMIN_LOAD_ERROR = "組織の管理画面を開けませんでした。しばらくしてから、もう一度お試しください。";

/**
 * .single() で行が 0 件 (または RLS で見えない) ときの PostgREST の失敗のコード。
 * プロフィールの行が無いのは「読み込めなかった」ではなく管理者でない扱い (これまでどおりホームへ移す)
 */
const POSTGREST_NO_ROWS_CODE = "PGRST116";

const orgNavItems = [
  { href: "/org/dashboard", label: "ダッシュボード", icon: "📊" },
  { href: "/org/members", label: "メンバー", icon: "👥" },
  { href: "/org/invites", label: "招待", icon: "✉️" },
  { href: "/org/departments", label: "部署", icon: "🏛️" },
  { href: "/org/challenges", label: "チャレンジ", icon: "🏆" },
  { href: "/org/settings", label: "設定", icon: "⚙️" },
];

export default function OrgLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();
  const [isOrgAdmin, setIsOrgAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [orgName, setOrgName] = useState("");
  // organizations.plan の日本語の表示名 (#1912。以前は固定の英語「Enterprise」を出していた)
  const [orgPlanLabel, setOrgPlanLabel] = useState("");

  // 自分のプロフィールを読み込めなかったときの文。あるあいだは画面の代わりにこの文と「再試行」を出す (#2064 R4 と同じ型)
  const [loadError, setLoadError] = useState<string | null>(null);

  const checkRole = useCallback(async () => {
    setLoading(true);
    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();

      if (authError || !user) {
        router.push("/login");
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('org_role, organization_id, organizations(name, plan)')
        .eq('id', user.id)
        .single();

      if (profileError && profileError.code !== POSTGREST_NO_ROWS_CODE) {
        // 読み込めなかった (管理者でないのとは別。ホームへ移さない)
        setLoadError(ORG_ADMIN_LOAD_ERROR);
        setLoading(false);
        return;
      }
      // #1235: 組織の管理者は所属組織の org_role が owner / admin のユーザー
      if (!isOrgAdminProfile(profile)) {
        router.push("/home"); // Not an org admin
        return;
      }

      setIsOrgAdmin(true);
      const sidebarInfo = readOrgSidebarInfo(profile);
      setOrgName(sidebarInfo.name);
      setOrgPlanLabel(sidebarInfo.planLabel);
      setLoadError(null);
      setLoading(false);
    } catch (checkError) {
      // 問い合わせが例外を投げた (以前は catch が無く、未処理の reject になり、読み込み中の表示のまま止まっていた)
      console.error("Failed to check org admin role:", checkError);
      setLoadError(ORG_ADMIN_LOAD_ERROR);
      setLoading(false);
    }
  }, [router, supabase]);

  useEffect(() => {
    void checkRole();
  }, [checkRole]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50 p-8">
        <div
          role="alert"
          data-testid="org-layout-load-error"
          className="max-w-md bg-red-50 border border-red-200 rounded-2xl p-8 text-center"
        >
          <p className="text-red-700 font-medium">{loadError}</p>
          <button
            type="button"
            onClick={() => void checkRole()}
            className="mt-4 px-4 py-2 rounded-xl bg-white border border-red-300 text-red-700 font-medium hover:bg-red-100 transition-colors"
          >
            再試行
          </button>
        </div>
      </div>
    );
  }

  if (!isOrgAdmin) return null;

  const handleLogout = async () => {
    clearUserScopedLocalStorage();
    // WebView ならネイティブへも signOut の前に知らせる (#1038 F7-10。理由は native-auth-bridge.ts の notifyNativeSignOut)
    notifyNativeSignOut();
    await supabase.auth.signOut();
    broadcastSignOut();
    router.push("/login");
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Sidebar */}
      <motion.aside
        initial={{ x: -100 }}
        animate={{ x: 0 }}
        className="w-64 bg-white shadow-xl border-r border-slate-100 p-6 flex flex-col sticky top-0 h-screen z-30"
      >
        <div className="flex items-center gap-3 mb-10">
          <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-lg shadow-blue-200 shadow-lg">
            🏢
          </div>
          <div>
            <p className="text-xs text-gray-400 font-bold" data-testid="org-sidebar-plan">{orgPlanLabel}</p>
            <span className="font-bold text-gray-800 line-clamp-1">{orgName}</span>
          </div>
        </div>

        <nav className="flex-1 space-y-2">
          {orgNavItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 p-3 rounded-xl transition-all ${
                pathname === item.href
                  ? "bg-blue-50 text-blue-600 shadow-sm font-bold"
                  : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              <span className="text-xl">{item.icon}</span>
              <span className="font-medium">{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="mt-8 pt-4 border-t border-gray-100">
          <button
            onClick={handleLogout}
            className="w-full justify-start text-gray-500 hover:bg-red-50 hover:text-red-500 p-3 rounded-xl flex items-center gap-3 transition-colors"
          >
            <span className="text-xl">🚪</span>
            <span className="font-bold text-sm">ログアウト</span>
          </button>
        </div>
      </motion.aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-y-auto custom-scrollbar">
        {children}
      </main>
    </div>
  );
}



