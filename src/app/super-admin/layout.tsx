/**
 * (super-admin) route group layout
 * super_admin ロールガード + サブナビ
 * operator/03-ui-spec.md §3 (共通レイアウト) / §22 (super_admin ダッシュボード) 準拠
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

const superAdminNavItems = [
  { href: '/super-admin/plans', label: 'プラン管理', icon: '📋' },
  { href: '/super-admin/feature-packages', label: '機能パッケージ', icon: '📦' },
  { href: '/super-admin/coupons', label: 'クーポン', icon: '🎟' },
];

export default async function SuperAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Server Component でロールガード
  try {
    await requireRole(['super_admin']);
  } catch (err) {
    if (err instanceof AuthError) {
      redirect('/login?redirect=/super-admin/plans');
    }
    if (err instanceof ForbiddenError) {
      redirect('/login?redirect=/super-admin/plans');
    }
    throw err;
  }

  return (
    <div className="min-h-screen flex bg-slate-50">
      {/* Sidebar */}
      <aside className="w-60 bg-slate-900 text-white flex flex-col shadow-xl flex-shrink-0">
        {/* Header */}
        <div className="p-5 border-b border-slate-700">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-orange-500 flex items-center justify-center text-lg font-bold">
              S
            </div>
            <div>
              <p className="text-sm font-bold text-white">Super Admin</p>
              <p className="text-xs text-slate-400">ほめゴハン 運営</p>
            </div>
          </div>
        </div>

        {/* 環境バッジ (operator/03-ui-spec.md §3.1 準拠) */}
        {process.env.NEXT_PUBLIC_VERCEL_ENV === 'production' ? (
          <div className="mx-4 mt-3 px-3 py-1 bg-red-600 text-white text-xs font-bold text-center rounded">
            PROD
          </div>
        ) : process.env.NEXT_PUBLIC_VERCEL_ENV === 'preview' ? (
          <div className="mx-4 mt-3 px-3 py-1 bg-blue-600 text-white text-xs font-bold text-center rounded">
            PREVIEW
          </div>
        ) : (
          <div className="mx-4 mt-3 px-3 py-1 bg-yellow-500 text-black text-xs font-bold text-center rounded">
            LOCAL / STAGING
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1 mt-2">
          <p className="text-xs text-slate-500 px-3 pb-1 uppercase tracking-wider">プラン管理</p>
          {superAdminNavItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 transition-colors text-sm"
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-slate-700">
          <Link
            href="/home"
            className="flex items-center gap-2 px-3 py-2 text-slate-400 hover:text-white text-sm rounded-lg hover:bg-slate-700 transition-colors"
          >
            <span>←</span>
            <span>アプリに戻る</span>
          </Link>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-8 max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
