"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { motion } from "framer-motion";

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
  const [isLoading, setIsLoading] = useState(true);
  const [userName, setUserName] = useState("");
  const supabase = createClient();

  useEffect(() => {
    const checkAccess = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }

      const { data: profile } = await supabase
        .from("user_profiles")
        .select("roles, nickname")
        .eq("id", user.id)
        .single();

      const roles = profile?.roles || [];
      const hasAccess = roles.some((r: string) => ['admin', 'super_admin', 'support'].includes(r));
      if (!profile || !hasAccess) {
        alert("サポート権限がありません");
        router.push("/home");
        return;
      }

      setUserName(profile.nickname || "Support");
      setIsLoading(false);
    };
    checkAccess();
  }, [router, supabase]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-teal-50 to-cyan-100">
        <div className="w-12 h-12 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
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

