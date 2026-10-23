/**
 * /admin/users — ユーザー一覧・検索
 * operator/03-ui-spec.md §5 準拠
 *
 * DB 直叩きを廃止し GET /api/admin/users 経由に統一。
 */

export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireRoleForPage } from '@/lib/auth/page-guard';
import { adminFetch } from '@/lib/admin/fetch';
import { canViewUserEmail } from '@/lib/admin/user-emails';
import { normalizeProfileName } from '@/lib/profile-name';
import type { UserListItem, UsersListResponse } from '@/lib/admin/users-schemas';
import { lastPageToRefetch } from '@/lib/list-pagination';

interface PageProps {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}

export default async function AdminUsersPage(props: PageProps) {
  const searchParams = await props.searchParams;
  // 未認証 → /login?next=・2FA 未完了 → MFA の画面・ロール不足 / 凍結 → /login (#1176。docs/design/cross/12-operator-mfa.md §13.4.2)
  const actor = await requireRoleForPage(['admin', 'super_admin', 'support'], { next: '/admin/users' });

  // メールアドレスを見られるのは admin / super_admin だけ (support には列を出さず、メール検索も効かない)
  const canSeeEmail = canViewUserEmail(actor.roles);

  const q = searchParams.q ?? '';
  const status = searchParams.status ?? 'active';
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10));
  const perPage = 50;

  // GET /api/admin/users 経由でデータ取得
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  params.set('page', String(page));
  params.set('per_page', String(perPage));

  // 応答の形は route と同じ型 (src/lib/admin/users-schemas.ts の UsersListResponse) で読む (#1717)
  let users: UserListItem[] = [];
  let total = 0;

  try {
    const res = await adminFetch(`/api/admin/users?${params.toString()}`);
    if (res.ok) {
      const json = (await res.json()) as UsersListResponse;
      users = json.data ?? [];
      total = json.meta?.total ?? 0;
    } else {
      console.error('[admin/users page] API error:', res.status);
    }
  } catch (err) {
    console.error('[admin/users page] fetch failed:', err);
  }

  // 件数より後ろのページ (最後のページの唯一の行が消えたあと・URL のページ番号) は、空のページを見せずに最後のページへ移す (#1917)。
  // redirect は例外で抜けるので、上の try の外で呼ぶ
  const refetchPage = lastPageToRefetch({ rows: users.length, page, total, perPage });
  if (refetchPage !== null) {
    const lastPageParams = new URLSearchParams();
    if (q) lastPageParams.set('q', q);
    if (status) lastPageParams.set('status', status);
    lastPageParams.set('page', String(refetchPage));
    redirect(`/admin/users?${lastPageParams.toString()}`);
  }

  const totalPages = Math.ceil(total / perPage);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">ユーザー管理</h1>
        <span className="text-sm text-gray-500">全 {total.toLocaleString()} 件</span>
      </div>

      {/* 検索・フィルタ */}
      <form method="GET" className="mb-4 flex gap-3">
        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder={canSeeEmail ? '名前・メール・ID で検索' : '名前・ID で検索'}
          className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        />
        <select
          name="status"
          defaultValue={status}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        >
          <option value="">全ステータス</option>
          <option value="active">アクティブ</option>
          <option value="banned">BAN 済み</option>
        </select>
        <button
          type="submit"
          className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 transition-colors"
        >
          検索
        </button>
      </form>

      {/* ユーザーテーブル */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">ユーザー</th>
              {canSeeEmail && (
                <th className="px-4 py-3 text-left font-medium text-gray-600">メール</th>
              )}
              <th className="px-4 py-3 text-left font-medium text-gray-600">プラン</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">ロール</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">ステータス</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">登録日</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.length === 0 ? (
              <tr>
                <td colSpan={canSeeEmail ? 7 : 6} className="px-4 py-8 text-center text-gray-400">
                  ユーザーが見つかりません
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">
                      {normalizeProfileName(user.nickname) ?? '(名前なし)'}
                    </div>
                    <div className="text-xs text-gray-400 font-mono">{user.id.slice(0, 8)}...</div>
                  </td>
                  {canSeeEmail && (
                    <td className="px-4 py-3 text-gray-700 break-all">{user.email ?? '-'}</td>
                  )}
                  <td className="px-4 py-3">
                    <span className="inline-block bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded font-mono">
                      {user.plan_key ?? 'free'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(Array.isArray(user.roles) ? user.roles : ['user']).map((role) => (
                        <span
                          key={role}
                          className="inline-block bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5 rounded font-mono"
                        >
                          {role}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {user.is_banned ? (
                      <span className="inline-block bg-red-50 text-red-700 text-xs px-2 py-0.5 rounded font-medium">
                        BAN
                      </span>
                    ) : (
                      <span className="inline-block bg-green-50 text-green-700 text-xs px-2 py-0.5 rounded font-medium">
                        active
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {user.registered_at
                      ? new Date(user.registered_at).toLocaleDateString('ja-JP')
                      : '-'}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/users/${user.id}`}
                      className="text-orange-500 hover:text-orange-700 text-xs font-medium"
                    >
                      詳細
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ページネーション */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
          <span>
            {(page - 1) * perPage + 1}〜{Math.min(page * perPage, total)} 件 / {total} 件
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={`/admin/users?q=${encodeURIComponent(q)}&status=${status}&page=${page - 1}`}
                className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50 transition-colors"
              >
                前へ
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={`/admin/users?q=${encodeURIComponent(q)}&status=${status}&page=${page + 1}`}
                className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50 transition-colors"
              >
                次へ
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
