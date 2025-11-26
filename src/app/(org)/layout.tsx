"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { motion } from "framer-motion";

const orgNavItems = [
  { href: "/org/dashboard", label: "Dashboard", icon: "📊" },
  { href: "/org/members", label: "Members", icon: "👥" },
  { href: "/org/settings", label: "Settings", icon: "🏢" },
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

  useEffect(() => {
    const checkRole = async () => {
      const { data: { user }, error: authError } = await supabase.auth.getUser();

      if (authError || !user) {
        router.push("/login");
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('role, organization_id, organizations(name)')
        .eq('id', user.id)
        .single();

      if (profileError || profile?.role !== 'org_admin' || !profile?.organization_id) {
        router.push("/home"); // Not an org admin
        return;
      }

      setIsOrgAdmin(true);
      // @ts-ignore: join query type inference
      setOrgName(profile.organizations?.name || "Organization");
      setLoading(false);
    };

    checkRole();
  }, [router, supabase]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isOrgAdmin) return null;

  const handleLogout = async () => {
    await supabase.auth.signOut();
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
            <p className="text-xs text-gray-400 font-bold uppercase tracking-wider">Enterprise</p>
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
            <span className="font-bold text-sm">Sign Out</span>
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


