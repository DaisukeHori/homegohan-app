"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Icons } from "@/components/icons";
import AIChatBubble from "@/components/AIChatBubble";
import { createClient } from "@/lib/supabase/client";
import { clearUserScopedLocalStorage } from "@/lib/user-storage";

// ロール別の管理メニュー
const ADMIN_MENU_ITEMS: Record<string, { href: string; label: string; icon: string; color: string }> = {
  support: { href: "/support", label: "サポート", icon: "🎧", color: "bg-teal-500" },
  org_admin: { href: "/org/dashboard", label: "組織管理", icon: "🏢", color: "bg-blue-500" },
  admin: { href: "/admin", label: "管理者", icon: "🛡", color: "bg-orange-500" },
  super_admin: { href: "/super-admin", label: "Super Admin", icon: "👑", color: "bg-purple-500" },
};

const NAV_ITEMS = [
  { href: "/home", label: "ホーム", icon: Icons.Home },
  { href: "/menus/weekly", label: "献立", icon: Icons.Menu },
  { href: "/meals/new", label: "スキャン", isFab: true, icon: Icons.Scan },
  { href: "/comparison", label: "比較", icon: Icons.Chart },
  { href: "/profile", label: "マイページ", icon: Icons.Profile },
];

export default function MainLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname();
  const [userRoles, setUserRoles] = useState<string[]>([]);
  const supabase = createClient();

  useEffect(() => {
    const fetchUserRoles = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('roles')
          .eq('id', user.id)
          .single();
        if (profile?.roles) {
          setUserRoles(profile.roles);
        }
      }
    };
    fetchUserRoles();
  }, [supabase]);

  // #145: signOut を別タブにも伝播させる
  useEffect(() => {
    // Supabase onAuthStateChange で同一タブ内のサインアウトを検知
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        clearUserScopedLocalStorage();
        window.location.href = '/login';
      }
    });

    // BroadcastChannel で別タブからの signOut を受信
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('auth');
      channel.addEventListener('message', (e) => {
        if (e.data === 'SIGNED_OUT') {
          clearUserScopedLocalStorage();
          window.location.href = '/login';
        }
      });
    }

    return () => {
      subscription.unsubscribe();
      channel?.close();
    };
  }, [supabase]);

  // ロールに応じた管理メニューを取得（複数ロール対応）
  const getAdminMenuItems = () => {
    if (!userRoles || userRoles.length === 0) return [];
    
    const items = [];
    const hasRole = (role: string) => userRoles.includes(role);
    
    // super_adminロールを持っている場合
    if (hasRole('super_admin')) {
      items.push(ADMIN_MENU_ITEMS.super_admin);
    }
    // adminロールを持っている場合
    if (hasRole('admin') || hasRole('super_admin')) {
      items.push(ADMIN_MENU_ITEMS.admin);
    }
    // supportロールを持っている場合
    if (hasRole('support') || hasRole('admin') || hasRole('super_admin')) {
      items.push(ADMIN_MENU_ITEMS.support);
    }
    // org_adminロールを持っている場合
    if (hasRole('org_admin')) {
      items.push(ADMIN_MENU_ITEMS.org_admin);
    }
    
    // 重複を除去
    return items.filter((item, index, self) => 
      index === self.findIndex(t => t.href === item.href)
    );
  };

  const adminMenuItems = getAdminMenuItems();

  return (
    <div className="flex min-h-screen bg-gray-50">
      
      {/* デスクトップ用サイドバー (Hidden on Mobile) */}
      <aside className="hidden lg:flex flex-col w-64 fixed inset-y-0 left-0 bg-white border-r border-gray-100 z-50 shadow-sm">
        <div className="p-8">
          <Link href="/home" className="flex items-center gap-3 group">
             <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-white font-bold shadow-md group-hover:shadow-lg transition-shadow">H</div>
             <span className="font-bold text-xl text-gray-900 tracking-tight">ほめゴハン</span>
          </Link>
        </div>
        
        <nav className="flex-1 px-4 space-y-2">
          {NAV_ITEMS.filter(item => !item.isFab).map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={`flex items-center gap-4 px-4 py-3 rounded-xl transition-all duration-200 group relative overflow-hidden ${
                  isActive 
                    ? 'bg-orange-50 text-accent font-bold shadow-sm' 
                    : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                {isActive && (
                  <motion.div
                    layoutId="active-nav"
                    className="absolute inset-0 bg-orange-50 rounded-xl -z-10"
                    initial={false}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  />
                )}
                <Icon className={`w-5 h-5 ${isActive ? 'text-accent fill-current' : 'text-gray-400 group-hover:text-gray-600'}`} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* 管理メニュー（権限がある場合のみ表示） */}
        {adminMenuItems.length > 0 && (
          <div className="px-4 pb-2">
            <div className="text-xs font-medium text-gray-400 px-4 mb-2">管理メニュー</div>
            <div className="space-y-1">
              {adminMenuItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center gap-3 px-4 py-2.5 text-gray-600 hover:bg-gray-50 rounded-xl transition-colors group"
                >
                  <span className={`w-7 h-7 ${item.color} rounded-lg flex items-center justify-center text-sm shadow-sm group-hover:shadow-md transition-shadow`}>
                    {item.icon}
                  </span>
                  <span className="text-sm font-medium">{item.label}</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        <div className="p-4 border-t border-gray-100 space-y-1">
           <Link href="/pantry" className={`flex items-center gap-4 px-4 py-3 rounded-xl transition-colors ${pathname === '/pantry' ? 'bg-orange-50 text-accent font-bold' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'}`}>
             <Icons.ShoppingBag className="w-5 h-5" />
             <span>食材管理</span>
           </Link>
           <Link href="/settings" className={`flex items-center gap-4 px-4 py-3 rounded-xl transition-colors ${pathname === '/settings' ? 'bg-orange-50 text-accent font-bold' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'}`}>
             <Icons.Settings className="w-5 h-5" />
             <span>設定</span>
           </Link>
        </div>
      </aside>

      {/* メインコンテンツ */}
      <main className="flex-1 lg:ml-64 relative min-h-screen">
        {children}
        {/* AIチャットバブル - モーダルのオーバーレイでカバーされるようにmain内に配置 */}
        <AIChatBubble />
      </main>

      {/* モバイル用ボトムナビゲーション (Floating) */}
      <div className="lg:hidden fixed bottom-4 left-0 right-0 z-50 flex justify-center px-4">
        <div className="w-full max-w-md bg-white/90 backdrop-blur-xl border border-white/20 rounded-full shadow-[0_8px_30px_rgba(0,0,0,0.12)] h-16 flex items-center justify-around px-4">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            
            if (item.isFab) {
              return (
                <Link 
                  key={item.href} 
                  href={item.href}
                  className="flex flex-col items-center justify-center"
                >
                  <motion.div 
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    className="w-12 h-12 rounded-full bg-foreground flex items-center justify-center text-white shadow-lg"
                  >
                    <Icon className="w-6 h-6" />
                  </motion.div>
                </Link>
              );
            }

            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={`flex flex-col items-center justify-center w-12 h-12 transition-colors ${
                  isActive ? 'text-accent' : 'text-gray-400'
                }`}
              >
                <Icon className={`w-6 h-6 ${isActive ? 'fill-current' : ''}`} />
                {isActive && (
                   <motion.div layoutId="nav-dot" className="w-1 h-1 rounded-full bg-accent mt-1" />
                )}
              </Link>
            );
          })}
        </div>
      </div>

    </div>
  )
}
