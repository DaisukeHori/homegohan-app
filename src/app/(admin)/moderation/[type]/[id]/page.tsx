/**
 * /admin/moderation/{type}/{id} — 個別審査画面
 * operator/03-ui-spec.md モデレーション準拠
 */

export const dynamic = 'force-dynamic';

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';
import { MODERATION_TYPES, type ModerationType } from '@/lib/admin/moderation-schemas';

interface PageProps {
  params: { type: string; id: string };
}

export default async function AdminModerationDetailPage({ params }: PageProps) {
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin', 'content_moderator']);
  } catch (err) {
    if (err instanceof AuthError || err instanceof ForbiddenError) {
      redirect('/login');
    }
    throw err;
  }

  const { type, id } = params;

  // type バリデーション
  if (!MODERATION_TYPES.includes(type as ModerationType)) {
    notFound();
  }

  const supabase = await createClient();

  type ModerationItem = {
    id: string;
    type: string;
    content_url: string | null;
    reporter_count: number;
    user_id: string;
    status: string;
    created_at: string;
    resolution_note: string | null;
  };

  let item: ModerationItem;

  try {
    const { data, error } = await supabase
      .from('moderation_items')
      .select('*')
      .eq('id', id)
      .eq('type', type)
      .single();

    if (error || !data) {
      notFound();
    }
    // data が存在することが確認済み (notFound() が throw される場合は到達しない)
    item = data as unknown as ModerationItem;
  } catch {
    notFound();
  }

  // item は ModerationItem として確定 (notFound() が throw するため null の場合は到達しない)
  const resolvedItem = item as ModerationItem;
  const isSuperAdmin = actor.roles.includes('super_admin');
  const isPending = resolvedItem.status === 'pending';

  return (
    <div className="max-w-3xl">
      {/* パンくず */}
      <nav className="mb-4 text-sm text-gray-500">
        <Link href="/admin/moderation" className="hover:text-orange-500 transition-colors">
          モデレーション
        </Link>
        {' / '}
        <span className="text-gray-900">審査 #{id.slice(0, 8)}</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 mb-6">コンテンツ審査</h1>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* コンテンツプレビュー */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">コンテンツ情報</h2>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-gray-500">ID</dt>
              <dd className="font-mono text-xs text-gray-700">{resolvedItem.id}</dd>
            </div>
            <div>
              <dt className="text-gray-500">タイプ</dt>
              <dd>
                <span className="inline-block bg-purple-50 text-purple-700 text-xs px-2 py-0.5 rounded font-mono">
                  {resolvedItem.type}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">ステータス</dt>
              <dd>
                <span
                  className={`inline-block text-xs px-2 py-0.5 rounded font-medium ${
                    resolvedItem.status === 'pending'
                      ? 'bg-yellow-50 text-yellow-700'
                      : resolvedItem.status === 'approved'
                        ? 'bg-green-50 text-green-700'
                        : resolvedItem.status === 'rejected'
                          ? 'bg-red-50 text-red-700'
                          : 'bg-orange-50 text-orange-700'
                  }`}
                >
                  {resolvedItem.status}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">通報数</dt>
              <dd className="font-medium text-red-600">{resolvedItem.reporter_count} 件</dd>
            </div>
            <div>
              <dt className="text-gray-500">投稿者 ID</dt>
              <dd>
                <Link
                  href={`/admin/users/${resolvedItem.user_id}`}
                  className="font-mono text-xs text-orange-500 hover:text-orange-700"
                >
                  {resolvedItem.user_id.slice(0, 8)}... →
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">投稿日時</dt>
              <dd className="text-gray-700">{new Date(resolvedItem.created_at).toLocaleString('ja-JP')}</dd>
            </div>
          </dl>

          {/* コンテンツ画像プレビュー */}
          {resolvedItem.content_url && (
            <div className="mt-4">
              <p className="text-sm text-gray-500 mb-2">コンテンツ</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={resolvedItem.content_url}
                alt="モデレーション対象コンテンツ"
                className="w-full rounded-lg object-cover max-h-64"
              />
            </div>
          )}

          {/* 既存の解決メモ */}
          {resolvedItem.resolution_note && (
            <div className="mt-4 p-3 bg-gray-50 rounded-lg">
              <p className="text-xs text-gray-500 mb-1">解決メモ</p>
              <p className="text-sm text-gray-700">{resolvedItem.resolution_note}</p>
            </div>
          )}
        </div>

        {/* 審査アクション */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">審査アクション</h2>

          {!isPending ? (
            <div className="text-center py-8 text-gray-400">
              <p className="text-sm">このアイテムは既に審査済みです</p>
              <p className="text-xs mt-1">ステータス: {resolvedItem.status}</p>
            </div>
          ) : (
            <form
              action={`/api/admin/moderation/${type}/${id}`}
              method="POST"
              className="space-y-4"
            >
              <div>
                <label htmlFor="action" className="block text-sm font-medium text-gray-700 mb-1">
                  アクション <span className="text-red-500">*</span>
                </label>
                <select
                  id="action"
                  name="action"
                  required
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                >
                  <option value="">選択してください</option>
                  <option value="approve">承認 (問題なし)</option>
                  <option value="delete_only">コンテンツ削除のみ</option>
                  <option value="delete_and_warn">削除 + 警告</option>
                  <option value="delete_and_temp_ban">削除 + 一時 BAN</option>
                  {isSuperAdmin && (
                    <option value="delete_and_perm_ban">削除 + 永久 BAN (super_admin のみ)</option>
                  )}
                  <option value="escalate">エスカレーション</option>
                </select>
              </div>

              <div>
                <label htmlFor="ban_duration_days" className="block text-sm font-medium text-gray-700 mb-1">
                  BAN 期間 (日数)
                  <span className="text-gray-400 text-xs ml-1">一時 BAN の場合のみ</span>
                </label>
                <input
                  id="ban_duration_days"
                  name="ban_duration_days"
                  type="number"
                  min={1}
                  max={365}
                  defaultValue={7}
                  className="w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                />
              </div>

              <div>
                <label htmlFor="resolution_note" className="block text-sm font-medium text-gray-700 mb-1">
                  解決メモ
                </label>
                <textarea
                  id="resolution_note"
                  name="resolution_note"
                  rows={4}
                  placeholder="審査内容の説明を入力してください"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                />
              </div>

              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                <p className="text-xs text-yellow-700">
                  この操作は admin_audit_logs に記録されます。
                </p>
              </div>

              <div className="flex gap-3">
                <Link
                  href="/admin/moderation"
                  className="flex-1 text-center px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  キャンセル
                </Link>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 rounded-lg bg-orange-500 text-white text-sm font-medium hover:bg-orange-600 transition-colors"
                >
                  審査を確定
                </button>
              </div>
              <p className="text-xs text-gray-400">
                ※ この操作は API (POST /api/admin/moderation/{type}/{id}) を直接呼び出してください
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
