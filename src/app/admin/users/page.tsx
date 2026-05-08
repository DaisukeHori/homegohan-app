/**
 * /admin/users — ユーザー一覧・検索
 * operator/03-ui-spec.md §5 準拠
 */

export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';

interface PageProps {
  searchParams: { q?: string; status?: string; page?: string };
}

export default async function AdminUsersPage({ searchParams }: PageProps) {
  try {
    await requireRole(['admin', 'super_admin', 'support']);
  } catch (err) {
    if (err instanceof AuthError || err instanceof ForbiddenError) {
      redirect('/login');
    }
    throw err;
  }

  const q = searchParams.q ?? '';
  const status = searchParams.status ?? 'active';
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10));
  const perPage = 50;

  const supabase = await createClient();

  let query = supabase
    .from('user_profiles')
    .select('id, display_name, roles, plan_key_cached, last_login_at, created_at', { count: 'exact' });

  if (q) {
    query = query.ilike('display_name', `%${q}%`);
  }

  if (status === 'banned') {
    query = query.contains('roles', ['banned']);
  } else if (status === 'active') {
    query = query.not('roles', 'cs', '["banned"]');
  }

  query = query
    .order('created_at', { ascending: false })
    .range((page - 1) * perPage, page * perPage - 1);

  const { data: users, count } = await query;
  const total = count ?? 0;
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
          placeholder="名前・メール・ID で検索"
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
              <th className="px-4 py-3 text-left font-medium text-gray-600">プラン</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">ロール</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">ステータス</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">登録日</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(users ?? []).length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                  ユーザーが見つかりません
                </td>
              </tr>
            ) : (
              (users ?? []).map((user) => {
                const isBanned = Array.isArray(user.roles) && user.roles.includes('banned');
                return (
                  <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">
                        {user.display_name ?? '(名前なし)'}
                      </div>
                      <div className="text-xs text-gray-400 font-mono">{user.id.slice(0, 8)}...</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-block bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded font-mono">
                        {user.plan_key_cached ?? 'free'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(Array.isArray(user.roles) ? user.roles : ['user'])
                          .filter((r) => r !== 'banned')
                          .map((role) => (
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
                      {isBanned ? (
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
                      {user.created_at
                        ? new Date(user.created_at).toLocaleDateString('ja-JP')
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
                );
              })
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
                href={`/admin/users?q=${q}&status=${status}&page=${page - 1}`}
                className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50 transition-colors"
              >
                前へ
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={`/admin/users?q=${q}&status=${status}&page=${page + 1}`}
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
