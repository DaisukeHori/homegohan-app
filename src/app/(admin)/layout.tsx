/**
 * (admin) レイアウト — admin / super_admin ロールガード + サイドバー
 * operator/03-ui-spec.md §3 準拠
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin', 'content_moderator']);
  } catch (err) {
    if (err instanceof AuthError || err instanceof ForbiddenError) {
      redirect('/login');
    }
    throw err;
  }

  const isSuperAdmin = actor.roles.includes('super_admin');
  const isAdmin = actor.roles.includes('admin') || isSuperAdmin;
  const isContentModerator = actor.roles.includes('content_moderator');

  const env = process.env.NEXT_PUBLIC_APP_ENV ?? process.env.NODE_ENV ?? 'development';
  const envBadge =
    env === 'production'
      ? { label: 'PROD', className: 'bg-red-600 text-white' }
      : env === 'staging'
        ? { label: 'STAGING', className: 'bg-yellow-500 text-black' }
        : { label: 'PREVIEW', className: 'bg-blue-500 text-white' };

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* サイドバー */}
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <div className="w-8 h-8 rounded-lg bg-orange-500 flex items-center justify-center text-white font-bold text-sm">
                H
              </div>
              <span className="font-semibold text-gray-900">ほめゴハン 管理</span>
            </Link>
            <span
              className={`ml-auto text-xs font-bold px-2 py-0.5 rounded ${envBadge.className}`}
            >
              {envBadge.label}
            </span>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {/* ダッシュボード */}
          {isAdmin && (
            <Link
              href="/admin"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors text-sm font-medium"
            >
              <span>ダッシュボード</span>
            </Link>
          )}

          {/* ユーザー管理 */}
          {isAdmin && (
            <Link
              href="/admin/users"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors text-sm font-medium"
            >
              <span>ユーザー管理</span>
            </Link>
          )}

          {/* モデレーション */}
          {(isAdmin || isContentModerator) && (
            <Link
              href="/admin/moderation"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors text-sm font-medium"
            >
              <span>モデレーション</span>
            </Link>
          )}

          {/* super_admin 専用リンク */}
          {isSuperAdmin && (
            <div className="pt-4 border-t border-gray-100">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-3 mb-2">
                super_admin
              </p>
              <Link
                href="/super-admin"
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors text-sm font-medium"
              >
                <span>super_admin コンソール</span>
              </Link>
            </div>
          )}
        </nav>

        <div className="p-4 border-t border-gray-200">
          <div className="text-xs text-gray-500">
            <span className="font-medium">{actor.email ?? actor.id.slice(0, 8)}</span>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {actor.roles.map((role) => (
                <span
                  key={role}
                  className="inline-block bg-gray-100 text-gray-600 rounded px-1.5 py-0.5 text-[10px] font-mono"
                >
                  {role}
                </span>
              ))}
            </div>
          </div>
        </div>
      </aside>

      {/* メインコンテンツ */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* ヘッダー */}
        <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
          <div className="text-sm text-gray-500">管理コンソール</div>
        </header>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
