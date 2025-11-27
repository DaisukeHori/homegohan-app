"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { motion } from "framer-motion";

const superAdminNavItems = [
  { href: "/super-admin", label: "概要", icon: "🏠" },
  { href: "/super-admin/admins", label: "管理者管理", icon: "👑" },
  { href: "/super-admin/settings", label: "システム設定", icon: "⚙️" },
  { href: "/super-admin/feature-flags", label: "機能フラグ", icon: "🚩" },
  { href: "/super-admin/database", label: "データベース", icon: "🗄️" },
];

export default function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isLoading, setIsLoading] = useState(true);
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
        .select("role")
        .eq("id", user.id)
        .single();

      if (profile?.role !== "super_admin") {
        alert("スーパー管理者権限が必要です");
        router.push("/home");
        return;
      }

      setIsLoading(false);
    };
    checkAccess();
  }, [router, supabase]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-900 to-indigo-900">
        <div className="w-12 h-12 border-4 border-purple-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-gradient-to-br from-slate-900 to-slate-800">
      {/* Sidebar */}
      <motion.aside
        initial={{ x: -100 }}
        animate={{ x: 0 }}
        className="w-64 bg-gradient-to-b from-purple-900 to-indigo-900 text-white flex flex-col shadow-xl"
      >
        <div className="p-6 border-b border-purple-700/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center text-xl shadow-lg">
              👑
            </div>
            <div>
              <h1 className="text-lg font-bold">Super Admin</h1>
              <p className="text-xs text-purple-300">最高権限</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          {superAdminNavItems.map((item) => (
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

        <div className="p-4 border-t border-purple-700/50 space-y-2">
          <Link href="/admin" className="flex items-center gap-3 px-4 py-3 text-purple-300 hover:text-white hover:bg-white/10 rounded-xl transition-colors">
            <span>🛡</span> Admin Console
          </Link>
          <Link href="/home" className="flex items-center gap-3 px-4 py-3 text-purple-300 hover:text-white hover:bg-white/10 rounded-xl transition-colors">
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

