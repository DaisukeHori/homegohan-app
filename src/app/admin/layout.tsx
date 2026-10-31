/**
 * (admin) レイアウト — admin / super_admin ロールガード + サイドバー
 * operator/03-ui-spec.md §3 準拠
 *
 * 入れるロールは admin / super_admin / content_moderator。設計書 §3.2 は support / finance / sales にも
 * 入れる想定だが、広げるのはオーナーの判断待ち。サポートチケット・売上・経理・営業 CRM のリンクは、
 * いま入れる admin / super_admin にだけ出している。
 * 入口の画面 (page.tsx) のカードを出すロールは、このサイドバーと同じにする。
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

import Link from 'next/link';
import { MfaGraceBanner } from '@/components/admin/MfaGraceBanner';
import { requireRoleForPage } from '@/lib/auth/page-guard';
import { DSR_ADMIN_PATH } from '@/lib/data-subject-requests/core';
import { OPERATOR_ROLE_LABELS, SUPER_ADMIN_SCREEN_LABEL, operatorRoleLabel } from '@/lib/admin/operator-role-labels';

/** 認証・2FA の画面から戻る先 (区画のトップ。docs/design/cross/12-operator-mfa.md §13.4.2) */
const ADMIN_AREA_NEXT = '/admin';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // 未認証 → /login?next=・2FA 未完了 → MFA の画面・ロール不足 / 凍結 → /login (#1176。cross/12 §13.4)
  const actor = await requireRoleForPage(['admin', 'super_admin', 'content_moderator'], { next: ADMIN_AREA_NEXT });
  const grace = actor.assurance?.decision === 'pass_grace' ? actor.assurance.enforce_from : null;

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

          {/* 組織管理 */}
          {isAdmin && (
            <Link
              href="/admin/organizations"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors text-sm font-medium"
            >
              <span>組織管理</span>
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

          {/* サポートチケット */}
          {isAdmin && (
            <Link
              href="/admin/support"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors text-sm font-medium"
            >
              <span>サポートチケット</span>
            </Link>
          )}

          {/* 個人情報の開示等の請求 (#1178。運営のロールは DSR_OPERATOR_ROLES = admin / super_admin。content_moderator には出さない) */}
          {isAdmin && (
            <Link
              href={DSR_ADMIN_PATH}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors text-sm font-medium"
            >
              <span>開示等の請求</span>
            </Link>
          )}

          {/* 売上・経理 */}
          {isAdmin && (
            <Link
              href="/admin/finance"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors text-sm font-medium"
            >
              <span>売上・経理</span>
            </Link>
          )}

          {/* 営業 CRM */}
          {isAdmin && (
            <Link
              href="/admin/sales"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors text-sm font-medium"
            >
              <span>営業 CRM</span>
            </Link>
          )}

          {/* お知らせ */}
          {isAdmin && (
            <Link
              href="/admin/announcements"
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors text-sm font-medium"
            >
              <span>お知らせ</span>
            </Link>
          )}

          {/* super_admin 専用リンク。見出しとリンクの語はロールの表示名 (運営最上位) にそろえる (#2128 V1-2) */}
          {isSuperAdmin && (
            <div className="pt-4 border-t border-gray-100">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-3 mb-2">
                {OPERATOR_ROLE_LABELS.super_admin}
              </p>
              <Link
                href="/super-admin"
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors text-sm font-medium"
              >
                <span>{SUPER_ADMIN_SCREEN_LABEL}</span>
              </Link>
            </div>
          )}
        </nav>

        <div className="p-4 border-t border-gray-200">
          <div className="text-xs text-gray-500">
            <span className="font-medium">{actor.email ?? actor.id.slice(0, 8)}</span>
            {/* ログイン中の運営のロール。利用者の一覧・詳細 (admin/users) と同じく表示名で出し、title に内部の値 (#2128 V1-1) */}
            <div className="mt-0.5 flex flex-wrap gap-1">
              {actor.roles.map((role) => (
                <span
                  key={role}
                  title={role}
                  className="inline-block bg-gray-100 text-gray-600 rounded px-1.5 py-0.5 text-[10px]"
                >
                  {operatorRoleLabel(role)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </aside>

      {/* メインコンテンツ */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 二段階認証の登録の猶予 (未登録の必須ロール。cross/12 §15) */}
        {grace ? <MfaGraceBanner enforceFrom={grace} next={ADMIN_AREA_NEXT} /> : null}
        {/* ヘッダー */}
        <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
          <div className="text-sm text-gray-500">管理コンソール</div>
        </header>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
