/**
 * /admin — 運営コンソールの入口
 * operator/03-ui-spec.md §3.2 (サイドバー: ロール別) / §4 準拠
 *
 * これまで /admin には page.tsx が無く、管理者 (admin / super_admin) がログインした直後の転送先
 * ((auth)/login・(auth)/auth/callback・middleware の管理者向け転送) も、サイドバーの「ダッシュボード」も
 * 404 になっていた。ここは、そのロールで使える機能へのリンクカードを並べる入口の画面。
 *
 * KPI カード・グラフ・直近アクティビティ (§4) は作らない。表示するための API がまだ無いため。
 *
 * カードを出すロールは、サイドバー (layout.tsx) の出し分けと同じにする。食い違うと、
 * 「サイドバーにある機能がカードに無い」「カードのリンクを押しても入れない」になる
 * (tests/admin-console-entry.test.tsx が両方を見比べる)。
 */

export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import type { RoleName } from '@/lib/auth/types';

interface ConsoleSection {
  href: string;
  label: string;
  description: string;
  /** このカードを出すロール (どれか 1 つを持っていれば出す) */
  roles: ReadonlyArray<RoleName>;
}

// §3.2 ではサポートチケット・売上・経理・営業 CRM を support / finance / sales にも出すが、
// いまの運営コンソールに入れるのは admin / super_admin / content_moderator だけ (layout.tsx)。
// 入れるロールを広げるのはオーナーの判断待ちなので、ここでは admin / super_admin だけに出す。
// 広げるときは、layout.tsx の requireRole と、ここ・サイドバーのロールを一緒に直す。
const ADMIN_ROLES: ReadonlyArray<RoleName> = ['admin', 'super_admin'];

const SECTIONS: ReadonlyArray<ConsoleSection> = [
  {
    href: '/admin/users',
    label: 'ユーザー管理',
    description: 'ユーザーの検索と、詳細の確認・凍結などの操作',
    roles: ADMIN_ROLES,
  },
  {
    href: '/admin/organizations',
    label: '組織管理',
    description: '組織の一覧・検索と、新しい組織の作成',
    roles: ADMIN_ROLES,
  },
  {
    href: '/admin/moderation',
    label: 'モデレーション',
    description: '食事画像・レシピの審査キュー (AI コンテンツの審査は準備中)',
    roles: ['admin', 'super_admin', 'content_moderator'],
  },
  {
    href: '/admin/support',
    label: 'サポートチケット',
    description: '問い合わせチケットの一覧と対応',
    roles: ADMIN_ROLES,
  },
  {
    href: '/admin/finance',
    label: '売上・経理',
    description: 'MAU の確認と CSV の書き出し (売上・請求書・Stripe との整合チェックは、課金を始めるまで準備中)',
    roles: ADMIN_ROLES,
  },
  {
    href: '/admin/sales',
    label: '営業 CRM',
    description: '見込み顧客 (リード) の管理',
    roles: ADMIN_ROLES,
  },
  {
    href: '/admin/announcements',
    label: 'お知らせ',
    description: '利用者に表示するお知らせの作成と一覧',
    roles: ADMIN_ROLES,
  },
  {
    href: '/super-admin',
    label: 'super_admin コンソール',
    description: 'プラン・機能パッケージ・クーポン・アプリログなど (super_admin 専用)',
    roles: ['super_admin'],
  },
];

export default async function AdminHomePage() {
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin', 'content_moderator']);
  } catch (err) {
    if (err instanceof AuthError || err instanceof ForbiddenError) {
      redirect('/login');
    }
    throw err;
  }

  const roles = actor.roles;
  const sections = SECTIONS.filter((section) => section.roles.some((role) => roles.includes(role)));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">管理コンソール</h1>
        <p className="mt-1 text-sm text-gray-500">お使いのロールで利用できる機能の一覧です。</p>
      </div>

      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {sections.map((section) => (
          <li key={section.href}>
            <Link
              href={section.href}
              className="block h-full rounded-lg border border-gray-200 bg-white p-4 transition-colors hover:border-orange-300 hover:bg-orange-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              <h2 className="text-base font-semibold text-gray-900">{section.label}</h2>
              <p className="mt-1 text-sm text-gray-500">{section.description}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
