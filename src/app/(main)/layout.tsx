"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Icons } from "@/components/icons";
import AIChatBubble from "@/components/AIChatBubble";

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

        <div className="p-4 border-t border-gray-100">
           <Link href="/settings" className="flex items-center gap-4 px-4 py-3 text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-xl transition-colors">
             <Icons.Settings className="w-5 h-5" />
             <span>設定</span>
           </Link>
        </div>
      </aside>

      {/* メインコンテンツ */}
      <main className="flex-1 lg:ml-64 relative z-0 min-h-screen">
        {children}
      </main>

      {/* AIチャットバブル */}
      <AIChatBubble />

      {/* モバイル用ボトムナビゲーション (Floating) */}
      <div className="lg:hidden fixed bottom-4 left-4 right-4 z-50">
        <div className="bg-white/90 backdrop-blur-xl border border-white/20 rounded-full shadow-[0_8px_30px_rgba(0,0,0,0.12)] p-2 flex items-center justify-between px-6">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            
            if (item.isFab) {
              return (
                <Link 
                  key={item.href} 
                  href={item.href}
                  className="flex flex-col items-center gap-1 p-2 transition-colors"
                >
                  <motion.div 
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    className="w-12 h-12 rounded-full bg-foreground flex items-center justify-center text-white shadow-lg"
                  >
                    <Icon className="w-7 h-7" />
                  </motion.div>
                </Link>
              );
            }

            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={`flex flex-col items-center gap-1 p-2 transition-colors ${
                  isActive ? 'text-accent' : 'text-gray-400'
                }`}
              >
                <Icon className={`w-6 h-6 ${isActive ? 'fill-current' : ''}`} />
                {isActive && (
                   <motion.div layoutId="nav-dot" className="w-1 h-1 rounded-full bg-accent" />
                )}
              </Link>
            );
          })}
        </div>
      </div>

    </div>
  )
}
