"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { motion } from "framer-motion";
import { normalizeProfileName } from "@/lib/profile-name";
import { loginPathWithNext, readSignedInUser } from "@/lib/auth/signed-in-user";

/**
 * 自分 (ログインしているか・サポートの権限) を読み込めなかったときの文 (#2093 W4)。権限が無い (ホームへ移す) ・
 * ログインしていない (ログインの画面へ移す) と見分けるために出す (組織の管理画面の枠の ORG_ADMIN_LOAD_ERROR と同じ扱い)。
 * 失敗の理由 (英語の内部の文) は画面に出さない
 */
const SUPPORT_LAYOUT_LOAD_ERROR = "サポートの画面を開けませんでした。しばらくしてから、もう一度お試しください。";

/**
 * .single() で行が 0 件 (または RLS で見えない) ときの PostgREST の失敗のコード。
 * プロフィールの行が無いのは「読み込めなかった」ではなく権限が無い扱い (これまでどおりホームへ移す)
 */
const POSTGREST_NO_ROWS_CODE = "PGRST116";

const supportNavItems = [
  { href: "/support", label: "ダッシュボード", icon: "📊" },
  { href: "/support/inquiries", label: "問い合わせ", icon: "📩" },
  { href: "/support/users", label: "ユーザー検索", icon: "👥" },
];

export default function SupportLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter();
  const pathname = usePathname();
  // ログインのあとに戻る先 (今の画面)。checkAccess の依存に入れると画面を移るたびに読み直すので、ref で今の値を読む (#2093 W4)
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);
  const [isLoading, setIsLoading] = useState(true);
  const [userName, setUserName] = useState("");
  // 自分を読み込めなかったときの文。あるあいだは画面の代わりにこの文と「再試行」を出す (#2093 W4。以前は通信が切れているだけで
  // ログインの画面へ移し、プロフィールを読めないと「サポート権限がありません」と出してホームへ移し、例外は未処理の reject になっていた)
  const [loadError, setLoadError] = useState<string | null>(null);
  const supabase = createClient();

  // 自分とサポートの権限を確かめる。画面を開いたときと「再試行」で呼ぶ
  const checkAccess = useCallback(async () => {
    setIsLoading(true);
    // 別の画面へ移るときは、移るまで読み込み中の表示のままにする (これまでどおり)
    let redirecting = false;
    try {
      // getUser は通信の失敗を投げずに { user: null, error } で返す。ログインの画面へ移すのはログインしていないときだけにし、
      // 確かめられなかったときは読み込みの失敗と「再試行」を出す。ログインのあとにこの画面へ戻れるよう next を付ける
      const signedIn = await readSignedInUser(supabase);
      if (signedIn.kind === "load-failed") {
        setLoadError(SUPPORT_LAYOUT_LOAD_ERROR);
        return;
      }
      if (signedIn.kind === "signed-out") {
        redirecting = true;
        router.push(loginPathWithNext(pathnameRef.current));
        return;
      }
      const { user } = signedIn;

      const { data: profile, error: profileError } = await supabase
        .from("user_profiles")
        .select("roles, nickname")
        .eq("id", user.id)
        .single();

      if (profileError && profileError.code !== POSTGREST_NO_ROWS_CODE) {
        // 読み込めなかった (権限が無いのとは別。「サポート権限がありません」と出さず、ホームへ移さない)
        setLoadError(SUPPORT_LAYOUT_LOAD_ERROR);
        return;
      }

      const roles = profile?.roles || [];
      const hasAccess = roles.some((r: string) => ['admin', 'super_admin', 'support'].includes(r));
      if (!profile || !hasAccess) {
        redirecting = true;
        alert("サポート権限がありません");
        router.push("/home");
        return;
      }

      setUserName(normalizeProfileName(profile.nickname) ?? "Support");
      setLoadError(null);
    } catch (checkError) {
      // 問い合わせが例外を投げた (以前は catch が無く、未処理の reject になり、読み込み中の表示のまま止まっていた)
      console.error("Failed to check support access:", checkError);
      setLoadError(SUPPORT_LAYOUT_LOAD_ERROR);
    } finally {
      if (!redirecting) setIsLoading(false);
    }
  }, [router, supabase]);

  useEffect(() => {
    void checkAccess();
  }, [checkAccess]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-teal-50 to-cyan-100">
        <div className="w-12 h-12 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-teal-50 to-cyan-100 p-8">
        <div
          role="alert"
          data-testid="support-layout-load-error"
          className="max-w-md bg-red-50 border border-red-200 rounded-2xl p-8 text-center"
        >
          <p className="text-red-700 font-medium">{loadError}</p>
          <button
            type="button"
            onClick={() => void checkAccess()}
            className="mt-4 px-4 py-2 rounded-xl bg-white border border-red-300 text-red-700 font-medium hover:bg-red-100 transition-colors"
          >
            再試行
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Sidebar */}
      <motion.aside
        initial={{ x: -100 }}
        animate={{ x: 0 }}
        className="w-64 bg-gradient-to-b from-teal-600 to-teal-700 text-white flex flex-col shadow-xl"
      >
        <div className="p-6 border-b border-teal-500/30">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-white/20 flex items-center justify-center text-xl">
              🎧
            </div>
            <div>
              <h1 className="text-lg font-bold">Support Center</h1>
              <p className="text-xs text-teal-200">ほめゴハン</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          {supportNavItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
                pathname === item.href
                  ? "bg-white/20 font-bold shadow-lg"
                  : "hover:bg-white/10"
              }`}
            >
              <span className="text-xl">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="p-4 border-t border-teal-500/30">
          <div className="px-4 py-2 text-sm text-teal-200">
            👤 {userName}
          </div>
          <Link href="/home" className="flex items-center gap-3 px-4 py-3 text-teal-200 hover:text-white hover:bg-white/10 rounded-xl transition-colors">
            <span>⬅️</span> アプリに戻る
          </Link>
        </div>
      </motion.aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-8">
          {children}
        </div>
      </main>
    </div>
  );
}

