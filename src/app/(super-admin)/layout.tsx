"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

const superAdminNavItems = [
  { href: "/super-admin", label: "ダッシュボード", icon: "🏠" },
  { href: "/super-admin/flags", label: "機能フラグ", icon: "🚩" },
  { href: "/super-admin/experiments", label: "A/B テスト", icon: "🧪" },
  { href: "/super-admin/llm", label: "LLM 使用量", icon: "🤖" },
  { href: "/super-admin/infra", label: "インフラ監視", icon: "🖥️" },
  { href: "/super-admin/exports", label: "データエクスポート", icon: "📤" },
  { href: "/super-admin/audit-logs", label: "監査ログ", icon: "📋" },
];

const ENV = process.env.NEXT_PUBLIC_ENV ?? process.env.VERCEL_ENV ?? "development";
const envBadge: Record<string, { label: string; color: string }> = {
  production: { label: "PROD", color: "bg-red-500" },
  preview: { label: "PREVIEW", color: "bg-blue-500" },
  development: { label: "DEV", color: "bg-gray-500" },
};

export default function SuperAdminLayout({ children }: { children: React.ReactNode }) {
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

      const roles: string[] = profile?.roles ?? [];
      if (!roles.includes("super_admin")) {
        alert("super_admin 権限が必要です");
        router.push("/home");
        return;
      }

      setUserName(profile?.nickname ?? "Super Admin");
      setIsLoading(false);
    };
    checkAccess();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800">
        <div className="w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const badge = envBadge[ENV] ?? envBadge.development;

  return (
    <div className="min-h-screen flex bg-slate-900 text-white">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-800 flex flex-col shadow-2xl border-r border-slate-700">
        <div className="p-5 border-b border-slate-700">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-purple-600 flex items-center justify-center text-xl">
              🛡️
            </div>
            <div>
              <h1 className="text-base font-bold text-white">Super Admin</h1>
              <span className={`inline-block text-xs font-bold px-2 py-0.5 rounded ${badge.color} text-white`}>
                {badge.label}
              </span>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {superAdminNavItems.map((item) => {
            const isActive = pathname === item.href || (item.href !== "/super-admin" && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-lg transition-all text-sm ${
                  isActive
                    ? "bg-purple-600 text-white font-semibold"
                    : "text-slate-300 hover:bg-slate-700 hover:text-white"
                }`}
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-700 space-y-1">
          <div className="px-4 py-2 text-xs text-slate-400">
            👤 {userName}
          </div>
          <Link
            href="/home"
            className="flex items-center gap-3 px-4 py-2.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors text-sm"
          >
            <span>←</span> アプリに戻る
          </Link>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto bg-slate-900">
        {children}
      </main>
    </div>
  );
}
