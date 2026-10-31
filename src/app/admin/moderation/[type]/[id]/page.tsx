/**
 * /admin/moderation/{type}/{id} — 個別審査画面
 * operator/03-ui-spec.md モデレーション準拠
 *
 * DB 直叩きを廃止し GET /api/admin/moderation/{type}/{id} 経由に統一。
 *
 * #1101: 審査アクションの欄は、クライアントコンポーネント (ModerationReviewForm) で JSON を送る。
 * 以前のサーバー側の <form method="POST"> は urlencoded で送られ、JSON だけを受ける API に毎回
 * 400 で拒否されていた。
 *
 * #1128 / #1911: type=ai_content (AI コンテンツ) にはバックエンドのテーブルが無く、API は 501 を返す。
 * 未完成の機能は画面に出さないので、API を呼ばずに 404 にする。
 *
 * #1538: 隠れているコンテンツには「表示」の項目と、右の列に「非表示の解除」のカード (ModerationRestoreForm) を出す。
 * 設計: docs/design/operator/13-hidden-content-restore.md §9.1
 *
 * #2086 V7: 「無い」(notFound()) にするのは API の 404 だけ。それ以外の失敗 (500 / 503 / 403・通信の失敗・壊れた応答) は
 * 「審査のアイテムを読み込めませんでした」と「再読み込み」を出す (以前は 404 以外の失敗も notFound() にして、消えたと誤解させていた)。
 */

export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireRoleForPage } from '@/lib/auth/page-guard';
import { adminFetch } from '@/lib/admin/fetch';
import { MODERATION_TYPES, type ModerationType } from '@/lib/admin/moderation-schemas';
import { isModerationBacked } from '@/lib/admin/moderation-backend';
import { moderationStatusLabel, moderationTypeLabel } from '@/lib/admin/moderation-labels';
import ModerationReviewForm from '@/components/operator/moderation/ModerationReviewForm';
import ModerationRestoreForm from '@/components/operator/moderation/ModerationRestoreForm';
import ModerationLoadFailure from '@/components/operator/moderation/ModerationLoadFailure';
import { MODERATION_DETAIL_LOAD_FAILED_MESSAGE, readModerationDetailBody } from '@/lib/admin/moderation-load-failure';
import {
  HIDDEN_CONTENT_RESTORE_WINDOW_DAYS,
  HIDDEN_CONTENT_RETENTION_DAYS,
  isWithinHiddenContentRestoreWindow,
} from '@/lib/admin/hidden-content-restore';

interface PageProps {
  params: Promise<{ type: string; id: string }>;
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
  /** コンテンツを隠した日時 (ISO)。隠れていなければ null (#1538) */
  hidden_at: string | null;
};

/** API の 404 (アイテムが無い)。これだけを notFound() にする */
const HTTP_NOT_FOUND = 404;

/** 詳細を読んだ結果。notFound は API の 404、failed はそれ以外の読み込みの失敗 */
type ModerationDetailLoad = { kind: 'ok'; item: ModerationItem } | { kind: 'notFound' } | { kind: 'failed' };

async function loadModerationDetail(type: string, id: string): Promise<ModerationDetailLoad> {
  try {
    const res = await adminFetch(`/api/admin/moderation/${type}/${id}`);
    if (res.status === HTTP_NOT_FOUND) return { kind: 'notFound' };
    if (!res.ok) {
      console.error('[admin/moderation detail page] API error:', res.status);
      return { kind: 'failed' };
    }
    const item = readModerationDetailBody<ModerationItem>(await res.json());
    if (!item) {
      console.error('[admin/moderation detail page] unexpected response body');
      return { kind: 'failed' };
    }
    return { kind: 'ok', item };
  } catch (err) {
    console.error('[admin/moderation detail page] fetch failed:', err);
    return { kind: 'failed' };
  }
}

/** パンくずに出す、通報の ID の先頭の文字数 */
const BREADCRUMB_ID_PREFIX_LENGTH = 8;

/** パンくず (一覧へ戻る道)。読み込みの失敗の画面にも出す */
function Breadcrumb({ id }: { id: string }) {
  return (
    <nav className="mb-4 text-sm text-gray-500">
      <Link href="/admin/moderation" className="hover:text-orange-500 transition-colors">
        モデレーション
      </Link>
      {' / '}
      <span className="text-gray-900">審査 #{id.slice(0, BREADCRUMB_ID_PREFIX_LENGTH)}</span>
    </nav>
  );
}

export default async function AdminModerationDetailPage(props: PageProps) {
  const params = await props.params;
  const { type, id } = params;
  // 未認証 → /login?next=・2FA 未完了 → MFA の画面・ロール不足 / 凍結 → /login (#1176。docs/design/cross/12-operator-mfa.md §13.4.2)
  const actor = await requireRoleForPage(['admin', 'super_admin', 'content_moderator'], { next: `/admin/moderation/${encodeURIComponent(type)}/${encodeURIComponent(id)}` });

  // type バリデーション。審査できない種類 (ai_content。#1128) は API を呼ばずに 404 (#1911: 未完成の機能は画面に出さない)
  if (!MODERATION_TYPES.includes(type as ModerationType) || !isModerationBacked(type as ModerationType)) {
    notFound();
  }

  // GET /api/admin/moderation/{type}/{id} 経由でデータ取得。404 だけを「無い」にする (#2086 V7)
  const load = await loadModerationDetail(type, id);
  if (load.kind !== 'ok') {
    if (load.kind === 'notFound') notFound();
    return (
      <div className="max-w-3xl">
        <Breadcrumb id={id} />
        <h1 className="text-2xl font-bold text-gray-900 mb-6">コンテンツ審査</h1>
        <ModerationLoadFailure message={MODERATION_DETAIL_LOAD_FAILED_MESSAGE} />
      </div>
    );
  }

  const resolvedItem = load.item;
  const isSuperAdmin = actor.roles.includes('super_admin');

  return (
    <div className="max-w-3xl">
      {/* パンくず */}
      <Breadcrumb id={id} />

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
                <span className="inline-block bg-purple-50 text-purple-700 text-xs px-2 py-0.5 rounded">
                  {moderationTypeLabel(resolvedItem.type)}
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
                  {/* 状態・種類は内部の英字の値を出さず、日本語の表示名にする (#2080 U6) */}
                  {moderationStatusLabel(resolvedItem.status)}
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
            <div>
              <dt className="text-gray-500">表示</dt>
              <dd className="text-gray-700">
                {resolvedItem.hidden_at
                  ? `非表示中 (隠した日時: ${new Date(resolvedItem.hidden_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})`
                  : '表示中'}
              </dd>
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

        {/* 右の列: 審査アクション + 非表示の解除 (#1538) */}
        <div className="space-y-6">
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

          {/*
            非表示の解除 (#1538)。条件なしで描く: 戻せたあとの router.refresh() で hidden_at が null になっても、
            同じ位置・同じ key のままなので「表示に戻しました」と 409 の文面が画面に残る (設計 §9.1)。
            カードの枠と見出しはコンポーネントが持ち、隠れていなくて結果も失敗の文も無いときは何も描かない
          */}
          <ModerationRestoreForm
            key={`restore:${type}:${id}`}
            type={type}
            id={id}
            hiddenAt={resolvedItem.hidden_at}
            restorable={
              resolvedItem.hidden_at !== null && isWithinHiddenContentRestoreWindow(resolvedItem.hidden_at, new Date())
            }
            restoreWindowDays={HIDDEN_CONTENT_RESTORE_WINDOW_DAYS}
            retentionDays={HIDDEN_CONTENT_RETENTION_DAYS}
          />
        </div>
      </div>
    </div>
  );
}
