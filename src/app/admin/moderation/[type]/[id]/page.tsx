/**
 * /admin/moderation/{type}/{id} — 個別審査画面
 * operator/03-ui-spec.md モデレーション準拠
 *
 * DB 直叩きを廃止し GET /api/admin/moderation/{type}/{id} 経由に統一。
 *
 * #1101: 審査アクションの欄は、クライアントコンポーネント (ModerationReviewForm) で JSON を送る。
 * 以前のサーバー側の <form method="POST"> は urlencoded で送られ、JSON だけを受ける API に毎回
 * 400 で拒否されていた。
 */

export const dynamic = 'force-dynamic';

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { adminFetch } from '@/lib/admin/fetch';
import { MODERATION_TYPES, type ModerationType } from '@/lib/admin/moderation-schemas';
import ModerationReviewForm from '@/components/operator/moderation/ModerationReviewForm';

interface PageProps {
  params: { type: string; id: string };
}

type ModerationItem = {
  id: string;
  type: string;
  /** 通報されたコンテンツ本体の ID (meals.id / recipes.id)。紐づかない通報では null */
  content_id: string | null;
  content_url: string | null;
  reporter_count: number;
  /** コンテンツの持ち主。特定できない通報 (コンテンツが紐づかない) では null */
  user_id: string | null;
  status: string;
  created_at: string;
  resolution_note: string | null;
};

interface ModerationDetailApiResponse {
  data: ModerationItem;
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

  // GET /api/admin/moderation/{type}/{id} 経由でデータ取得
  const res = await adminFetch(`/api/admin/moderation/${type}/${id}`);
  if (res.status === 404) {
    notFound();
  }
  if (!res.ok) {
    notFound();
  }

  const json = (await res.json()) as ModerationDetailApiResponse;
  const resolvedItem = json.data;
  const isSuperAdmin = actor.roles.includes('super_admin');

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
              <dt className="text-gray-500">コンテンツ ID</dt>
              <dd className="font-mono text-xs text-gray-700">
                {resolvedItem.content_id ?? '(紐づくコンテンツなし)'}
              </dd>
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
                {resolvedItem.user_id ? (
                  <Link
                    href={`/admin/users/${resolvedItem.user_id}`}
                    className="font-mono text-xs text-orange-500 hover:text-orange-700"
                  >
                    {resolvedItem.user_id.slice(0, 8)}... →
                  </Link>
                ) : (
                  <span className="text-xs text-gray-500">(特定できません)</span>
                )}
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
          <ModerationReviewForm
            key={`${type}:${id}`}
            type={type}
            id={id}
            status={resolvedItem.status}
            isSuperAdmin={isSuperAdmin}
          />
        </div>
      </div>
    </div>
  );
}
