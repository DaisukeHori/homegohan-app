"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Icons } from "@/components/icons";

const NAV_ITEMS = [
  { href: "/home", label: "Home", icon: Icons.Menu }, // 仮でMenuアイコンなどを割り当て。本来はHomeアイコンが必要
  { href: "/menus/weekly", label: "Menu", icon: Icons.Edit }, // 仮
  { href: "/meals/new", label: "Scan", isFab: true, icon: Icons.Plus },
  { href: "/badges", label: "Badges", icon: Icons.Check }, // 仮
  { href: "/profile", label: "Profile", icon: Icons.User },
];

// IconsにHome, Menu(Book), Awardなどが足りないので追加が必要ですが、
// まずはエラーを解消するために既存のIconsを使うか、インラインSVGを修正します。
// ここではインラインSVGのアプローチを維持しつつ、型エラーを直します。

const INLINE_NAV_ITEMS = [
  { 
    href: "/home", 
    label: "Home", 
    icon: (active: boolean) => (
      <svg className={`w-6 h-6 ${active ? "text-accent fill-current" : "text-gray-400 fill-none"}`} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
    )
  },
  { 
    href: "/menus/weekly", 
    label: "Menu", 
    icon: (active: boolean) => (
      <svg className={`w-6 h-6 ${active ? "text-accent fill-current" : "text-gray-400 fill-none"}`} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
    )
  },
  { 
    href: "/meals/new", 
    label: "Scan", 
    isFab: true, 
    icon: (_active: boolean) => (
      <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
    )
  },
  { 
    href: "/badges", 
    label: "Badges", 
    icon: (active: boolean) => (
      <svg className={`w-6 h-6 ${active ? "text-accent fill-current" : "text-gray-400 fill-none"}`} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
    )
  },
  { 
    href: "/profile", 
    label: "Profile", 
    icon: (active: boolean) => (
      <svg className={`w-6 h-6 ${active ? "text-accent fill-current" : "text-gray-400 fill-none"}`} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
    )
  },
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
      <aside className="hidden lg:flex flex-col w-64 fixed inset-y-0 left-0 bg-white border-r border-gray-100 z-50">
        <div className="p-8">
          <Link href="/home" className="flex items-center gap-3">
             <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-white font-bold">H</div>
             <span className="font-bold text-xl text-gray-900">ほめゴハン</span>
          </Link>
        </div>
        
        <nav className="flex-1 px-4 space-y-2">
          {INLINE_NAV_ITEMS.filter(item => !item.isFab).map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={`flex items-center gap-4 px-4 py-3 rounded-xl transition-all ${
                  isActive ? 'bg-orange-50 text-accent font-bold' : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                {item.icon(isActive)}
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-gray-100">
           <Link href="/settings" className="flex items-center gap-4 px-4 py-3 text-gray-400 hover:text-gray-600">
             <Icons.Menu className="w-5 h-5" />
             <span>Settings</span>
           </Link>
        </div>
      </aside>

      {/* メインコンテンツ */}
      <main className="flex-1 lg:ml-64 relative z-0">
        {children}
      </main>

      {/* モバイル用ボトムナビゲーション (Floating) */}
      <div className="lg:hidden fixed bottom-6 left-6 right-6 z-50">
        <div className="bg-white/90 backdrop-blur-xl border border-white/20 rounded-full shadow-[0_8px_30px_rgba(0,0,0,0.12)] p-2 flex items-center justify-between px-6">
          {INLINE_NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href;
            
            if (item.isFab) {
              return (
                <div key={item.href} className="relative -top-8">
                   <Link href={item.href}>
                     <motion.div 
                       whileHover={{ scale: 1.05 }}
                       whileTap={{ scale: 0.95 }}
                       className="w-16 h-16 rounded-full bg-foreground flex items-center justify-center shadow-lg shadow-gray-400/50 border-4 border-gray-50"
                     >
                       {item.icon(false)}
                     </motion.div>
                   </Link>
                </div>
              );
            }

            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={`flex flex-col items-center gap-1 p-2 ${
                  isActive ? 'text-accent' : 'text-gray-400'
                }`}
              >
                {item.icon(isActive)}
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
