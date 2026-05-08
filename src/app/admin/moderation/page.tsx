/**
 * /admin/moderation — モデレーションキュー一覧
 * operator/03-ui-spec.md §5 モデレーション画面準拠
 *
 * DB 直叩きを廃止し GET /api/admin/moderation/queue 経由に統一。
 */

export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { adminFetch } from '@/lib/admin/fetch';

interface PageProps {
  searchParams: { status?: string; type?: string; page?: string };
}

interface ModerationItem {
  id: string;
  type: string;
  content_url: string | null;
  reporter_count: number;
  user_id: string;
  status: string;
  created_at: string;
}

interface ModerationApiResponse {
  data: ModerationItem[];
  meta: {
    total: number;
    page: number;
    per_page: number;
  };
}

export default async function AdminModerationPage({ searchParams }: PageProps) {
  try {
    await requireRole(['admin', 'super_admin', 'content_moderator']);
  } catch (err) {
    if (err instanceof AuthError || err instanceof ForbiddenError) {
      redirect('/login');
    }
    throw err;
  }

  const status = searchParams.status ?? 'pending';
  const type = searchParams.type ?? '';
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10));
  const perPage = 30;

  // GET /api/admin/moderation/queue 経由でデータ取得
  const params = new URLSearchParams();
  params.set('status', status);
  if (type) params.set('type', type);
  params.set('page', String(page));
  params.set('per_page', String(perPage));

  let items: ModerationItem[] = [];
  let total = 0;

  try {
    const res = await adminFetch(`/api/admin/moderation/queue?${params.toString()}`);
    if (res.ok) {
      const json = (await res.json()) as ModerationApiResponse;
      items = json.data ?? [];
      total = json.meta?.total ?? 0;
    } else {
      console.error('[admin/moderation page] API error:', res.status);
    }
  } catch (err) {
    console.error('[admin/moderation page] fetch failed:', err);
  }

  const totalPages = Math.ceil(total / perPage);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">モデレーション</h1>
        <span className="text-sm text-gray-500">
          {status === 'pending' ? '未審査' : status} 件数: {total.toLocaleString()}
        </span>
      </div>

      {/* フィルタ */}
      <form method="GET" className="mb-4 flex gap-3">
        <select
          name="status"
          defaultValue={status}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        >
          <option value="pending">未審査</option>
          <option value="approved">承認済み</option>
          <option value="rejected">却下済み</option>
          <option value="escalated">エスカレーション</option>
        </select>
        <select
          name="type"
          defaultValue={type}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        >
          <option value="">全タイプ</option>
          <option value="food">食事画像</option>
          <option value="recipe">レシピ</option>
          <option value="ai_content">AI コンテンツ</option>
        </select>
        <button
          type="submit"
          className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 transition-colors"
        >
          絞り込み
        </button>
      </form>

      {/* キューテーブル */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">タイプ</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">コンテンツ</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">通報数</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">ステータス</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">投稿日時</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                  {status === 'pending' ? '審査待ちのアイテムはありません' : 'アイテムが見つかりません'}
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <span className="inline-block bg-purple-50 text-purple-700 text-xs px-2 py-0.5 rounded font-mono">
                      {item.type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {item.content_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.content_url}
                          alt="コンテンツ"
                          className="w-10 h-10 object-cover rounded"
                        />
                      )}
                      <span className="font-mono text-xs text-gray-400">{item.id.slice(0, 8)}...</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {item.reporter_count > 0 ? (
                      <span className="inline-flex items-center gap-1 bg-red-50 text-red-700 text-xs px-2 py-0.5 rounded font-medium">
                        {item.reporter_count} 件
                      </span>
                    ) : (
                      <span className="text-gray-400 text-xs">0</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block text-xs px-2 py-0.5 rounded font-medium ${
                        item.status === 'pending'
                          ? 'bg-yellow-50 text-yellow-700'
                          : item.status === 'approved'
                            ? 'bg-green-50 text-green-700'
                            : item.status === 'rejected'
                              ? 'bg-red-50 text-red-700'
                              : 'bg-orange-50 text-orange-700'
                      }`}
                    >
                      {item.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {new Date(item.created_at).toLocaleString('ja-JP')}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/moderation/${item.type}/${item.id}`}
                      className="text-orange-500 hover:text-orange-700 text-xs font-medium"
                    >
                      審査
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
                href={`/admin/moderation?status=${status}&type=${type}&page=${page - 1}`}
                className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50 transition-colors"
              >
                前へ
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={`/admin/moderation?status=${status}&type=${type}&page=${page + 1}`}
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
