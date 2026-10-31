/**
 * /operator/membership layout
 * super_admin ロールガード + 共通ナビ
 * docs/design/membership/05-operator-emergency-ui.md §5.1 準拠
 */

import Link from 'next/link';
import { MfaGraceBanner } from '@/components/admin/MfaGraceBanner';
import { requireRoleForPage } from '@/lib/auth/page-guard';
import { SUPER_ADMIN_SCREEN_LABEL } from '@/lib/admin/operator-role-labels';

/**
 * 認証・2FA の画面から戻る先 (/operator/membership には page.tsx が無いので、今の行き先の画面にする。
 * docs/design/cross/12-operator-mfa.md §13.4.2)
 */
const OPERATOR_MEMBERSHIP_AREA_NEXT = '/operator/membership/orgs/inactive';
/** ロール不足・凍結のときの行き先 (今までの行き先のまま) */
const OPERATOR_MEMBERSHIP_AREA_FORBIDDEN_PATH = '/login?redirect=/operator/membership/orgs/inactive';

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
  // 未認証 → /login?next=・2FA 未完了 → MFA の画面・ロール不足 / 凍結 → 今までの行き先 (#1176。cross/12 §13.4)
  const actor = await requireRoleForPage(['super_admin'], {
    next: OPERATOR_MEMBERSHIP_AREA_NEXT,
    forbiddenPath: OPERATOR_MEMBERSHIP_AREA_FORBIDDEN_PATH,
  });
  const grace = actor.assurance?.decision === 'pass_grace' ? actor.assurance.enforce_from : null;

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
            <span>{SUPER_ADMIN_SCREEN_LABEL}に戻る</span>
          </Link>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-8 max-w-7xl mx-auto">
          {grace ? <MfaGraceBanner enforceFrom={grace} next={OPERATOR_MEMBERSHIP_AREA_NEXT} /> : null}
          {children}
        </div>
      </main>
    </div>
  );
}
