"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, Suspense } from "react";
import { motion } from "framer-motion";
import { Icons } from "@/components/icons";
import AIChatBubble from "@/components/AIChatBubble";
import { createClient } from "@/lib/supabase/client";
import { clearUserScopedLocalStorage } from "@/lib/user-storage";
import { NATIVE_REBRIDGE_WAIT_MS, isInNativeWebView, notifyNativeSessionExpired } from "@/lib/native-auth-bridge";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { useNativeAppMode } from "@/hooks/useNativeAppMode";
import { NativeAppTabRouter } from "@/components/native-app/NativeAppTabRouter";
import { LegalConsentBanner } from "@/components/legal/LegalConsentBanner";
import { NativeSessionWatcher } from "@/components/native-app/NativeSessionWatcher";
import { AiConsentRequiredHost } from "@/components/consent/AiConsentRequiredHost";

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

/**
 * useNativeAppMode は useSearchParams を使うため Suspense 境界内で呼び出す必要がある。
 * BottomNav コンポーネントに分離することで Suspense を局所化する。
 *
 * initialIsNativeApp: SSR 時に server 側 (layout.tsx) で Cookie を読んだ初期値。
 * これを useState の初期値として渡すことで、ハイドレーション前の HTML から
 * 既に正しい表示状態が反映され、BottomNav のちらつき (フラッシュ) を防止する。
 */
function BottomNav({ pathname, initialIsNativeApp }: { pathname: string; initialIsNativeApp: boolean }) {
  const isNativeApp = useNativeAppMode(initialIsNativeApp);

  if (isNativeApp) return null;

  return (
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
  );
}

export default function MainLayout({
  children,
  initialIsNativeApp = false,
  legalConsentPending = false,
}: {
  children: React.ReactNode
  initialIsNativeApp?: boolean
  /** #1174: 規約への同意が済んでいない (お知らせは有効・強制はしていない) とき、画面の上に「同意のお願い」を出す */
  legalConsentPending?: boolean
}) {
  const pathname = usePathname();
  const [userRoles, setUserRoles] = useState<string[]>([]);
  const [isOrgAdminUser, setIsOrgAdminUser] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    const fetchUserRoles = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('roles, org_role, organization_id')
          .eq('id', user.id)
          .single();
        if (profile?.roles) {
          setUserRoles(profile.roles);
        }
        setIsOrgAdminUser(isOrgAdmin(profile));
      }
    };
    fetchUserRoles();
  }, [supabase]);

  // #145: signOut を別タブにも伝播させる
  useEffect(() => {
    // ログアウトとして扱う: 端末のユーザー別データを消して、ログイン画面へ移る
    const treatAsSignedOut = () => {
      clearUserScopedLocalStorage();
      window.location.href = '/login';
    };

    // モバイルアプリの WebView で、ネイティブが読み込み直してくれるのを待っている間のタイマー (#1038 F7-05)
    let rebridgeWaitTimer: ReturnType<typeof setTimeout> | null = null;
    const stopWaitingForRebridge = () => {
      if (rebridgeWaitTimer !== null) {
        clearTimeout(rebridgeWaitTimer);
        rebridgeWaitTimer = null;
      }
    };

    // Supabase onAuthStateChange で同一タブ内のサインアウトを検知
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // 待っている間にセッションが戻った (別のタブが先に再ブリッジされ、共有の Cookie が新しくなったなど) ときは、何もしない
      if (session) stopWaitingForRebridge();

      if (event !== 'SIGNED_OUT') return;

      if (!isInNativeWebView()) {
        treatAsSignedOut();
        return;
      }

      // モバイルアプリの WebView の中の SIGNED_OUT は、利用者のログアウトとは限らない (#1038 F7-05)。
      // Web 側のセッションはネイティブから借りたもので、refresh_token は更新に使えない値。auth-js は期限が近づくと
      // その値で更新しようとして必ず失敗し、セッションを捨てて SIGNED_OUT を出す。前面で使っているときは
      // NativeSessionWatcher が先に再ブリッジを頼むので避けられるが、1 時間以上バックグラウンドに置いて戻ったときは、
      // 復帰した瞬間に auth-js が更新を試みるので、どんな閾値でも先回りできない。
      // ここでログアウト扱いにすると、ログアウトしていないのに v4MenuGenerating などの user-scoped の localStorage が消え
      // (全タブの WebView で共有)、再ブリッジの読み込み直しで進行中の生成の追跡が途切れ、/login が一瞬出てしまう。
      // そこでネイティブに再ブリッジを頼み、読み込み直されるのを待つ。
      // 利用者が意図したログアウト (設定・マイページなど) は、各画面が signOut の前に自分で localStorage を消し、
      // broadcastSignOut() で sign-out を送り、router.push('/login') で移る。その場合は、この画面を離れるときに待ちが終わる。
      notifyNativeSessionExpired();
      // 読み込み直されないとき (session-expired を知らない旧アプリで、実際の refresh_token のセッションが失効した場合など) は、
      // 従来どおりログアウトとして扱う
      if (rebridgeWaitTimer === null) {
        rebridgeWaitTimer = setTimeout(treatAsSignedOut, NATIVE_REBRIDGE_WAIT_MS);
      }
    });

    // BroadcastChannel で別タブからの signOut を受信 (broadcastSignOut() が送る。利用者が意図したログアウトなので、WebView の中でも待たずに移る)
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('auth');
      channel.addEventListener('message', (e) => {
        if (e.data === 'SIGNED_OUT') treatAsSignedOut();
      });
    }

    return () => {
      subscription.unsubscribe();
      channel?.close();
      stopWaitingForRebridge();
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
    // 所属組織の owner / admin の場合 (#1235: roles の org_admin では判定しない)
    if (isOrgAdminUser) {
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
      <NativeAppTabRouter />
      {/* モバイルアプリの WebView の中で、セッションが切れる前にネイティブへ再ブリッジを頼む (#1038 F7-05)。ブラウザでは何もしない */}
      <NativeSessionWatcher />
      
      {/* デスクトップ用サイドバー (Hidden on Mobile) */}
      <aside className={`${initialIsNativeApp ? 'hidden' : 'hidden lg:flex'} flex-col w-64 fixed inset-y-0 left-0 bg-white border-r border-gray-100 z-50 shadow-sm`}>
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
        {legalConsentPending && <LegalConsentBanner />}
        {children}
        {/* AIチャットバブル - モーダルのオーバーレイでカバーされるようにmain内に配置 */}
        <AIChatBubble />
        {/* 外国の AI 事業者への提供の同意: AI の API に「同意が必要です」で止められたときに同意画面を出す (T15 / #1154) */}
        <AiConsentRequiredHost />
      </main>

      {/* モバイル用ボトムナビゲーション (Floating) — isNativeApp 時は非表示 */}
      <Suspense fallback={null}>
        <BottomNav pathname={pathname} initialIsNativeApp={initialIsNativeApp} />
      </Suspense>

    </div>
  )
}
