"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isLoading, setIsLoading] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  useEffect(() => {
    const checkAdmin = async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }

      // Adminロール確認（複数ロール対応）
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("roles")
        .eq("id", user.id)
        .single();

      const roles: string[] = profile?.roles || [];
      if (!roles.includes("admin") && !roles.includes("super_admin")) {
        alert("管理者権限がありません");
        router.push("/home");
        return;
      }

      setIsSuperAdmin(roles.includes("super_admin"));
      setIsLoading(false);
    };
    void checkAdmin();
  }, [router]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <p className="text-gray-500">Verifying access...</p>
      </div>
    );
  }

  const menuItems = [
    { label: "Dashboard", href: "/admin", icon: "📊" },
    { label: "Users", href: "/admin/users", icon: "👥" },
    { label: "Inquiries", href: "/admin/inquiries", icon: "📩" },
    { label: "Announcements", href: "/admin/announcements", icon: "📢" },
    { label: "Organizations", href: "/admin/organizations", icon: "🏢" },
    { label: "Moderation", href: "/admin/moderation", icon: "🛡" },
    { label: "Audit Logs", href: "/admin/audit-logs", icon: "📋" },
  ];

  const superAdminMenuItems = [
    { label: "LLM使用量", href: "/super-admin/llm-usage", icon: "🤖" },
    { label: "DB統計", href: "/super-admin/database", icon: "🗄️" },
  ];

  return (
    <div className="min-h-screen flex bg-gray-100">
      {/* Sidebar */}
      <aside className="w-64 bg-[#1a1a1a] text-white flex flex-col">
        <div className="p-6 border-b border-gray-800">
          <h1 className="text-xl font-bold tracking-tight">Admin Console</h1>
          <p className="text-xs text-gray-500 mt-1">Homegohan Operations</p>
        </div>
        <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
          {menuItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                pathname === item.href
                  ? "bg-[#FF8A65] text-white font-bold"
                  : "text-gray-400 hover:bg-gray-800 hover:text-white"
              }`}
            >
              <span className="text-xl">{item.icon}</span>
              {item.label}
            </Link>
          ))}

          {/* super_admin 限定メニュー */}
          {isSuperAdmin && (
            <>
              <div className="pt-4 pb-1">
                <p className="px-4 text-xs text-gray-600 font-bold uppercase tracking-widest">
                  Super Admin
                </p>
              </div>
              {superAdminMenuItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                    pathname === item.href
                      ? "bg-purple-600 text-white font-bold"
                      : "text-purple-400 hover:bg-gray-800 hover:text-purple-300"
                  }`}
                >
                  <span className="text-xl">{item.icon}</span>
                  {item.label}
                </Link>
              ))}
              <Link
                href="/super-admin"
                className="flex items-center gap-3 px-4 py-3 rounded-lg text-purple-400 hover:bg-gray-800 hover:text-purple-300 transition-colors"
              >
                <span className="text-xl">👑</span>
                Super Admin Console
              </Link>
            </>
          )}
        </nav>
        <div className="p-4 border-t border-gray-800">
          <Link href="/home" className="flex items-center gap-3 px-4 py-3 text-gray-400 hover:text-white">
            <span>⬅️</span> Back to App
          </Link>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <header className="bg-white border-b border-gray-200 px-8 py-4 flex justify-between items-center">
          <h2 className="font-bold text-gray-700">
            {menuItems.find(i => i.href === pathname)?.label || "Dashboard"}
          </h2>
          <div className="flex items-center gap-4">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
            <span className="text-sm text-gray-500">System Operational</span>
          </div>
        </header>
        <div className="p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
