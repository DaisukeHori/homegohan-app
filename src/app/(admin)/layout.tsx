"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

const financeNavItems = [
  { href: "/finance", label: "ダッシュボード", icon: "📊", exact: true },
  { href: "/finance/revenue", label: "収益推移", icon: "📈" },
  { href: "/finance/invoices", label: "請求書", icon: "🧾" },
  { href: "/finance/reconciliation", label: "Stripe 整合", icon: "🔄" },
  { href: "/finance/nps", label: "NPS / CSAT", icon: "⭐" },
  { href: "/finance/exports", label: "CSV エクスポート", icon: "📥" },
];

const FINANCE_ROLES = ["admin", "super_admin", "finance"];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isLoading, setIsLoading] = useState(true);
  const [userName, setUserName] = useState("");
  const [userRoles, setUserRoles] = useState<string[]>([]);
  const supabase = createClient();

  useEffect(() => {
    const checkAccess = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }

      const { data: profile } = await supabase
        .from("user_profiles")
        .select("roles, nickname")
        .eq("id", user.id)
        .single();

      const roles = (profile?.roles ?? []) as string[];
      const hasAccess = roles.some((r) => FINANCE_ROLES.includes(r));
      if (!hasAccess) {
        alert("アクセス権限がありません");
        router.push("/home");
        return;
      }

      setUserName(profile?.nickname ?? user.email ?? "Admin");
      setUserRoles(roles);
      setIsLoading(false);
    };
    checkAccess();
  }, [router, supabase]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const envLabel =
    process.env.NODE_ENV === "production"
      ? { text: "PROD", color: "bg-red-600" }
      : process.env.NODE_ENV === "test"
        ? { text: "STAGING", color: "bg-yellow-500" }
        : { text: "DEV", color: "bg-blue-500" };

  return (
    <div className="min-h-screen flex bg-slate-50">
      {/* Sidebar */}
      <aside className="w-60 bg-white border-r border-slate-200 flex flex-col sticky top-0 h-screen z-30 shadow-sm">
        <div className="p-5 border-b border-slate-100">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white text-sm font-bold">
              F
            </div>
            <div>
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                Finance
              </p>
              <p className="text-xs text-slate-400">ほめゴハン 管理</p>
            </div>
          </div>
          <span
            className={`inline-block text-xs text-white font-bold px-2 py-0.5 rounded ${envLabel.color}`}
          >
            {envLabel.text}
          </span>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {financeNavItems.map((item) => {
            const isActive = item.exact
              ? pathname === item.href
              : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm ${
                  isActive
                    ? "bg-indigo-50 text-indigo-700 font-semibold"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                <span className="text-base">{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-100">
          <div className="px-3 py-2 text-xs text-slate-400">
            <div className="font-medium text-slate-600 truncate">{userName}</div>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {userRoles
                .filter((r) => FINANCE_ROLES.includes(r))
                .map((r) => (
                  <span
                    key={r}
                    className="bg-indigo-100 text-indigo-600 rounded px-1.5 py-0.5 text-xs"
                  >
                    {r}
                  </span>
                ))}
            </div>
          </div>
          <Link
            href="/home"
            className="flex items-center gap-2 px-3 py-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-colors text-sm mt-1"
          >
            <span>←</span>
            <span>アプリに戻る</span>
          </Link>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
