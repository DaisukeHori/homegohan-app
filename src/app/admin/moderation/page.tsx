/**
 * /admin/moderation — モデレーションキュー一覧
 * operator/03-ui-spec.md §5 モデレーション画面準拠
 *
 * DB 直叩きを廃止し GET /api/admin/moderation/queue 経由に統一。
 *
 * #1128: AI コンテンツ (ai_content) にはバックエンドのテーブルが無く、API は 501 を返す。
 * #1911: 未完成の機能は画面に出さない。絞り込みの選択肢は審査できる種類 (食事画像・レシピ) だけにし、
 * URL で ai_content (やほかの知らない種類) を指定されたときは、種類を絞らない一覧 (全タイプ) として扱う。
 * #2086 V7: 一覧の読み込みの失敗 (API の失敗・通信の失敗・data が配列でない壊れた応答) は 0 件と分ける。
 * 「審査待ちのアイテムはありません」・件数 0 を出さず、「審査の一覧を読み込めませんでした」と「再読み込み」を出す
 * (以前は失敗を console.error で捨てて 0 件のまま描き、運営が審査待ちの通報を 0 件と誤解しうる状態だった)。
 */

export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireRoleForPage } from '@/lib/auth/page-guard';
import { adminFetch } from '@/lib/admin/fetch';
import { MODERATION_TYPES, type ModerationType } from '@/lib/admin/moderation-schemas';
import { isModerationBacked } from '@/lib/admin/moderation-backend';
import { moderationStatusLabel, moderationTypeLabel } from '@/lib/admin/moderation-labels';
import {
  MODERATION_LIST_LOAD_FAILED_MESSAGE,
  readModerationQueueBody,
  type ModerationQueueLoad,
} from '@/lib/admin/moderation-load-failure';
import ModerationLoadFailure from '@/components/operator/moderation/ModerationLoadFailure';

interface PageProps {
  searchParams: Promise<{ status?: string; type?: string; page?: string }>;
}

interface ModerationItem {
  id: string;
  type: string;
  content_url: string | null;
  reporter_count: number;
  user_id: string;
  status: string;
  created_at: string;
  /** コンテンツを隠した日時 (ISO)。隠れていなければ null (#1538) */
  hidden_at: string | null;
}

export default async function AdminModerationPage(props: PageProps) {
  const searchParams = await props.searchParams;
  // 未認証 → /login?next=・2FA 未完了 → MFA の画面・ロール不足 / 凍結 → /login (#1176。docs/design/cross/12-operator-mfa.md §13.4.2)
  await requireRoleForPage(['admin', 'super_admin', 'content_moderator'], { next: '/admin/moderation' });

  const status = searchParams.status ?? 'pending';
  // 審査できる種類 (食事画像・レシピ) だけを絞り込みに使う。それ以外は絞らない (全タイプ)
  const requestedType = searchParams.type ?? '';
  const type =
    MODERATION_TYPES.includes(requestedType as ModerationType) && isModerationBacked(requestedType as ModerationType)
      ? requestedType
      : '';
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10));
  const perPage = 30;

  // GET /api/admin/moderation/queue 経由でデータ取得
  const params = new URLSearchParams();
  params.set('status', status);
  if (type) params.set('type', type);
  params.set('page', String(page));
  params.set('per_page', String(perPage));

  // 読み込みの失敗 (!res.ok・例外・壊れた応答) は ok: false。0 件 (ok: true・items が空) と分けて描く (#2086 V7)
  let load: ModerationQueueLoad<ModerationItem> = { ok: false };

  try {
    const res = await adminFetch(`/api/admin/moderation/queue?${params.toString()}`);
    if (res.ok) {
      load = readModerationQueueBody<ModerationItem>(await res.json());
      if (!load.ok) console.error('[admin/moderation page] unexpected response body');
    } else {
      console.error('[admin/moderation page] API error:', res.status);
    }
  } catch (err) {
    console.error('[admin/moderation page] fetch failed:', err);
  }

  const items = load.ok ? load.items : [];
  const total = load.ok ? load.total : 0;
  const totalPages = Math.ceil(total / perPage);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">モデレーション</h1>
        {/* 読み込めなかったときは件数を出さない (「件数: 0」と見せない。#2086 V7) */}
        {load.ok && (
          <span className="text-sm text-gray-500">
            {moderationStatusLabel(status)} 件数: {total.toLocaleString()}
          </span>
        )}
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
        </select>
        <button
          type="submit"
          className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 transition-colors"
        >
          絞り込み
        </button>
      </form>

      {/* 読み込みの失敗: 0 件の文・表を出さず、失敗の文と「再読み込み」を出す (#2086 V7) */}
      {!load.ok && <ModerationLoadFailure message={MODERATION_LIST_LOAD_FAILED_MESSAGE} />}

      {/* キューテーブル */}
      {load.ok && (
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
                      <span className="inline-block bg-purple-50 text-purple-700 text-xs px-2 py-0.5 rounded">
                        {moderationTypeLabel(item.type)}
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
                        {/* 状態・種類は内部の英字の値を出さず、日本語の表示名にする (#2080 U6) */}
                        {moderationStatusLabel(item.status)}
                      </span>
                      {/* #1538: コンテンツが運営の判定で隠れている通報 (status に関わらず) */}
                      {item.hidden_at && (
                        <span className="ml-1 inline-block bg-gray-100 text-gray-700 text-xs px-2 py-0.5 rounded font-medium">
                          非表示中
                        </span>
                      )}
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
      )}

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
