/**
 * /admin/users/{id}/freeze — 凍結フォーム
 * operator/03-ui-spec.md §6 BAN モーダル相当
 *
 * DB 直叩きを廃止し GET /api/admin/users/{id} 経由に統一。
 *
 * #1917: 凍結・凍結解除の欄は、クライアントコンポーネント (UserFreezeForm) で JSON を送る
 * (凍結は POST、解除は DELETE)。以前のサーバー側の <form method="POST"> は urlencoded で送られ、JSON だけを受ける API に
 * 毎回 400 INVALID_JSON で拒否されていた (解除の隠し項目 _method=DELETE も route は読まない)。
 */

export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireRoleForPage } from '@/lib/auth/page-guard';
import { adminFetch } from '@/lib/admin/fetch';
import { normalizeProfileName } from '@/lib/profile-name';
import UserFreezeForm from '@/components/admin/UserFreezeForm';

interface PageProps {
  params: Promise<{ id: string }>;
}

interface FreezeProfile {
  id: string;
  nickname: string | null;
  roles: string[];
  is_banned: boolean;
  frozen_at: string | null;
}

interface UserDetailApiResponse {
  data: FreezeProfile;
}

export default async function AdminUserFreezePage(props: PageProps) {
  const params = await props.params;
  const { id } = params;
  // 未認証 → /login?next=・2FA 未完了 → MFA の画面・ロール不足 / 凍結 → /login (#1176。docs/design/cross/12-operator-mfa.md §13.4.2)
  const actor = await requireRoleForPage(['admin', 'super_admin'], { next: `/admin/users/${encodeURIComponent(id)}/freeze` });

  // GET /api/admin/users/{id} 経由で凍結状態取得
  const res = await adminFetch(`/api/admin/users/${id}`);
  if (res.status === 404) {
    notFound();
  }
  if (!res.ok) {
    notFound();
  }

  const json = (await res.json()) as UserDetailApiResponse;
  const profile = json.data;

  // 凍結状態は is_banned で判定 ('banned' ロールは使用禁止: cross/CLAUDE.md §B)
  const isBanned = profile.is_banned;
  const isSuperAdmin = actor.roles.includes('super_admin');

  return (
    <div className="max-w-2xl">
      {/* パンくず */}
      <nav className="mb-4 text-sm text-gray-500">
        <Link href="/admin/users" className="hover:text-orange-500 transition-colors">
          ユーザー管理
        </Link>
        {' / '}
        <Link href={`/admin/users/${id}`} className="hover:text-orange-500 transition-colors">
          {normalizeProfileName(profile.nickname) ?? id.slice(0, 8)}
        </Link>
        {' / '}
        <span className="text-gray-900">{isBanned ? '凍結解除' : '凍結'}</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 mb-2">
        {isBanned ? '凍結解除' : 'ユーザー凍結 (BAN)'}
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        対象: <span className="font-medium text-gray-800">{normalizeProfileName(profile.nickname) ?? '(名前なし)'}</span>
      </p>

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        {/* 凍結・凍結解除はクライアントコンポーネントで JSON を送る (#1917。以前の <form method="POST"> は urlencoded で送られ、API が 400 で断っていた) */}
        <UserFreezeForm userId={id} isBanned={isBanned} isSuperAdmin={isSuperAdmin} />
      </div>
    </div>
  );
}
