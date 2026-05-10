/**
 * /operator/membership layout
 * super_admin ロールガード + 共通ナビ
 * docs/design/membership/05-operator-emergency-ui.md §5.1 準拠
 */

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

const navItems = [
  {
    label: '組織管理',
    children: [
      { href: '/operator/membership/orgs/inactive', label: 'inactive owner 検索' },
    ],
  },
  {
    label: '家族管理',
    children: [
      { href: '/operator/membership/families/inactive', label: 'inactive 代表者検索' },
    ],
  },
  {
    label: '監査',
    children: [
      { href: '/operator/membership/audit', label: '監査ログ閲覧' },
    ],
  },
];

export default async function OperatorMembershipLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    await requireRole(['super_admin']);
  } catch (err) {
    if (err instanceof AuthError || err instanceof ForbiddenError) {
      redirect('/login?redirect=/operator/membership/orgs/inactive');
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
            <div className="w-9 h-9 rounded-lg bg-red-600 flex items-center justify-center text-lg font-bold">
              M
            </div>
            <div>
              <p className="text-sm font-bold text-white">緊急介入</p>
              <p className="text-xs text-slate-400">Membership Admin</p>
            </div>
          </div>
        </div>

        {/* 環境バッジ */}
        {process.env.NEXT_PUBLIC_VERCEL_ENV === 'production' ? (
          <div className="mx-4 mt-3 px-3 py-1 bg-red-600 text-white text-xs font-bold text-center rounded">
            PROD
          </div>
        ) : (
          <div className="mx-4 mt-3 px-3 py-1 bg-yellow-500 text-black text-xs font-bold text-center rounded">
            LOCAL / STAGING
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-4 mt-2">
          {navItems.map((group) => (
            <div key={group.label}>
              <p className="text-xs text-slate-500 px-3 pb-1 uppercase tracking-wider">
                {group.label}
              </p>
              {group.children.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 transition-colors text-sm"
                >
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-slate-700">
          <Link
            href="/super-admin/plans"
            className="flex items-center gap-2 px-3 py-2 text-slate-400 hover:text-white text-sm rounded-lg hover:bg-slate-700 transition-colors"
          >
            <span>&#8592;</span>
            <span>Super Admin に戻る</span>
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
