'use client';

/**
 * /admin/data-requests — 個人情報の開示・訂正・利用停止・消去の請求の一覧 (#1178 / #1702 段 C)
 *
 * 設計: docs/design/cross/15-data-subject-requests.md §9.2。API は GET /api/admin/data-requests (`{ data, meta }`)。
 * 権限: admin / super_admin (DSR_OPERATOR_ROLES。サイドバーとカードも同じロールにだけ出す)。
 *
 * - タブ: 受付済み (既定) / 対応中 / 期限超過 (overdue=1) / 本人確認待ち / 終了 (対応済み・対応できず・取り下げをタブ内で切替) / すべて
 * - 列: 受付番号・種類・状態・請求者 (ニックネーム。無ければ user_id の先頭 8 桁、退会済みは「退会済み」)・受付・期限 (期限超過は赤)・作成
 * - 行を押すと詳細 (/admin/data-requests/[id]) へ。ページングは DSR_ADMIN_LIST_LIMITS.default 件ずつ
 */
import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { loginPathWithNext } from '@/lib/auth/signed-in-user';
import { forbiddenMessageOfResponse } from '@/lib/admin/api-error-message';
import {
  DSR_ADMIN_API_PATH,
  DSR_ADMIN_LIST_LIMITS,
  DSR_REQUEST_TYPE_LABELS,
  DSR_SHORT_ID_LENGTH,
  DSR_STATUS_LABELS,
  shortDsrId,
  type DsrAdminSummaryDto,
  type DsrStatus,
} from '@/lib/data-subject-requests/core';

/** 1 ページの件数 (API の既定と同じ) */
const PER_PAGE = DSR_ADMIN_LIST_LIMITS.default;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** 終了タブで切り替える状態 */
const FINISHED_STATUSES = ['fulfilled', 'rejected', 'withdrawn'] as const satisfies ReadonlyArray<DsrStatus>;
type FinishedStatus = (typeof FINISHED_STATUSES)[number];

type TabKey = 'received' | 'in_progress' | 'overdue' | 'pending_verification' | 'finished' | 'all';

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'received', label: '受付済み' },
  { key: 'in_progress', label: '対応中' },
  { key: 'overdue', label: '期限超過' },
  { key: 'pending_verification', label: '本人確認待ち' },
  { key: 'finished', label: '終了' },
  { key: 'all', label: 'すべて' },
];

const DEFAULT_TAB: TabKey = 'received';

const STATUS_COLORS: Record<DsrStatus, string> = {
  pending_verification: 'bg-gray-100 text-gray-700',
  received: 'bg-blue-100 text-blue-800',
  in_progress: 'bg-yellow-100 text-yellow-800',
  fulfilled: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
  withdrawn: 'bg-gray-200 text-gray-600',
};

const LOAD_FAILURE_MESSAGE = '請求の一覧を読み込めませんでした。再読み込みしてください';
/** 403 の文。本文の理由の文 (二段階認証の確認が要る など) があればそちらを出す (forbiddenMessageOfResponse。#1917) */
const FORBIDDEN_MESSAGE = '権限がありません';

/** タブと終了タブの状態から、一覧の API のクエリを作る */
function buildListQuery(tab: TabKey, finished: FinishedStatus, page: number): URLSearchParams {
  const params = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
  if (tab === 'overdue') params.set('overdue', '1');
  else if (tab === 'finished') params.set('status', finished);
  else if (tab !== 'all') params.set('status', tab);
  return params;
}

/** 日本時間の日時 (受付・期限・作成) */
function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '—';
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tokyo' }).format(
    new Date(time),
  );
}

/** 請求者の表示 (ニックネーム → user_id の先頭 → 退会済み) */
function requesterLabel(row: DsrAdminSummaryDto): string {
  if (!row.user_id) return '退会済み';
  return row.requester_nickname ?? row.user_id.slice(0, DSR_SHORT_ID_LENGTH);
}

function isSummaryList(body: unknown): body is { data: DsrAdminSummaryDto[]; meta?: { total?: number | null } } {
  return !!body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data);
}

export default function AdminDataRequestsPage() {
  const router = useRouter();
  // ログインが切れた (401) ときに、ログインし直したあとこの画面へ戻れるよう next に付けるパス (#2101 X5)
  const pathname = usePathname();
  const [tab, setTab] = useState<TabKey>(DEFAULT_TAB);
  const [finished, setFinished] = useState<FinishedStatus>('fulfilled');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<DsrAdminSummaryDto[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${DSR_ADMIN_API_PATH}?${buildListQuery(tab, finished, page).toString()}`, {
        cache: 'no-store',
      });
      if (res.status === HTTP_UNAUTHORIZED) {
        router.push(loginPathWithNext(pathname));
        return;
      }
      if (res.status === HTTP_FORBIDDEN) {
        setRows([]);
        setError(await forbiddenMessageOfResponse(res, FORBIDDEN_MESSAGE));
        return;
      }
      const body: unknown = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok || !isSummaryList(body)) {
        setRows([]);
        setError(LOAD_FAILURE_MESSAGE);
        return;
      }
      setRows(body.data);
      setTotal(body.meta?.total ?? null);
    } catch {
      setRows([]);
      setError(LOAD_FAILURE_MESSAGE);
    } finally {
      setLoading(false);
    }
  }, [tab, finished, page, router, pathname]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = total === null ? null : Math.max(1, Math.ceil(total / PER_PAGE));
  const hasNext = totalPages === null ? rows.length === PER_PAGE : page < totalPages;

  return (
    <div className="max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">開示等の請求</h1>
        <p className="mt-1 text-sm text-gray-500">
          個人情報の開示・訂正・利用停止・消去の請求です。本人確認が済んだもの (受付済み) から対応してください。
          {total !== null && ` 全 ${total} 件`}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-1 mb-4 border-b border-gray-200" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            data-testid={`admin-dsr-tab-${t.key}`}
            onClick={() => {
              setTab(t.key);
              setPage(1);
            }}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
        {tab === 'finished' && (
          <div className="ml-auto flex items-center gap-2 pb-2">
            <label htmlFor="admin-dsr-finished-status" className="text-sm text-gray-500">
              状態:
            </label>
            <select
              id="admin-dsr-finished-status"
              data-testid="admin-dsr-finished-status"
              value={finished}
              onChange={(e) => {
                setFinished(e.target.value as FinishedStatus);
                setPage(1);
              }}
              className="text-sm border border-gray-300 rounded px-2 py-1"
            >
              {FINISHED_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {DSR_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4" role="alert">
          {error}
        </div>
      )}

      <div className="bg-white rounded-lg shadow overflow-x-auto" data-testid="admin-dsr-list">
        {loading ? (
          <div className="text-center py-12 text-gray-500">読み込み中...</div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12 text-gray-500">該当する請求はありません</div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">受付番号</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">種類</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">状態</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">請求者</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">受付</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">期限</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">作成</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid="admin-dsr-row"
                  onClick={() => router.push(`/admin/data-requests/${row.id}`)}
                  className="hover:bg-gray-50 cursor-pointer"
                >
                  <td className="px-4 py-3 text-sm font-mono text-gray-600">#{shortDsrId(row.id)}</td>
                  <td className="px-4 py-3 text-sm text-gray-900">{DSR_REQUEST_TYPE_LABELS[row.request_type]}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${STATUS_COLORS[row.status]}`}>
                      {DSR_STATUS_LABELS[row.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">{requesterLabel(row)}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{formatDateTime(row.verified_at)}</td>
                  <td
                    data-testid="admin-dsr-due"
                    data-overdue={row.overdue ? 'true' : 'false'}
                    className={`px-4 py-3 text-sm ${row.overdue ? 'text-red-600 font-semibold' : 'text-gray-600'}`}
                  >
                    {formatDateTime(row.due_at)}
                    {row.overdue && <span className="ml-1">(期限超過)</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{formatDateTime(row.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(page > 1 || hasNext) && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="px-3 py-1 rounded border border-gray-300 text-sm disabled:opacity-50"
          >
            前へ
          </button>
          <span className="text-sm text-gray-600">
            {page}
            {totalPages !== null && ` / ${totalPages}`}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => p + 1)}
            disabled={!hasNext || loading}
            className="px-3 py-1 rounded border border-gray-300 text-sm disabled:opacity-50"
          >
            次へ
          </button>
        </div>
      )}
    </div>
  );
}
