'use client';

/**
 * /operator/membership/audit
 * membership_audit テーブル一覧 + フィルタ
 * 05-operator-emergency-ui.md §5.4 準拠
 */

import { useState, useEffect, useCallback } from 'react';

type AuditRow = {
  id: string;
  scope: string;
  scope_id: string;
  action: string;
  actor_id: string | null;
  target_user_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

type MetaDetailModalProps = {
  row: AuditRow;
  onClose: () => void;
};

function MetaDetailModal({ row, onClose }: MetaDetailModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900">監査ログ詳細</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl font-bold">&#215;</button>
        </div>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-medium text-gray-500">ID</dt>
            <dd className="text-gray-900 font-mono text-xs">{row.id}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">日時</dt>
            <dd className="text-gray-900">{new Date(row.created_at).toLocaleString('ja-JP')}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">Scope / ID</dt>
            <dd className="text-gray-900">{row.scope} / <span className="font-mono text-xs">{row.scope_id}</span></dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">Action</dt>
            <dd className="text-gray-900">{row.action}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">Actor</dt>
            <dd className="text-gray-900 font-mono text-xs">{row.actor_id ?? '(system)'}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">Target User</dt>
            <dd className="text-gray-900 font-mono text-xs">{row.target_user_id ?? '-'}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">Metadata</dt>
            <dd className="bg-gray-50 rounded p-3 font-mono text-xs whitespace-pre-wrap break-all">
              {JSON.stringify(row.metadata, null, 2)}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

const SCOPE_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'organization', label: '組織' },
  { value: 'family', label: '家族' },
];

const ACTION_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'operator_force_owner_transfer', label: 'operator_force_owner_transfer' },
  { value: 'operator_force_representative_transfer', label: 'operator_force_representative_transfer' },
  { value: 'operator_force_dissolve', label: 'operator_force_dissolve' },
  { value: 'invite_accepted', label: 'invite_accepted' },
  { value: 'member_left', label: 'member_left' },
  { value: 'owner_transferred', label: 'owner_transferred' },
  { value: 'representative_transferred', label: 'representative_transferred' },
];

export default function MembershipAuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailRow, setDetailRow] = useState<AuditRow | null>(null);

  // フィルタ
  const [scope, setScope] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const limit = 50;

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams();
      if (scope) sp.set('scope', scope);
      if (action) sp.set('action', action);
      if (from) sp.set('from', from);
      if (to) sp.set('to', to);
      sp.set('page', String(page));
      sp.set('limit', String(limit));

      const res = await fetch(`/api/operator/membership/audit?${sp.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setRows(json.data ?? []);
      setTotal(json.meta?.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'データ取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }, [scope, action, from, to, page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    fetchData();
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">メンバシップ 監査ログ</h1>
        <p className="text-sm text-gray-500 mt-1">全ての membership_audit イベントを閲覧できます (super_admin のみ)</p>
      </div>

      {/* フィルタ */}
      <form onSubmit={handleSearch} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Scope</label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              {SCOPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Action</label>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              {ACTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label || 'All'}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">From</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">To</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
          >
            検索
          </button>
          <button
            type="button"
            onClick={() => { setScope(''); setAction(''); setFrom(''); setTo(''); setPage(1); }}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            リセット
          </button>
        </div>
      </form>

      {/* テーブル */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        {loading && (
          <div className="flex items-center justify-center py-12 text-gray-500 text-sm">
            読み込み中...
          </div>
        )}

        {error && (
          <div className="p-4 text-red-700 text-sm">{error}</div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div className="flex items-center justify-center py-12 text-gray-500 text-sm">
            ログがありません
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-500 bg-gray-50">
                    <th className="px-4 py-3 font-medium">日時</th>
                    <th className="px-4 py-3 font-medium">Scope</th>
                    <th className="px-4 py-3 font-medium">Action</th>
                    <th className="px-4 py-3 font-medium">Actor</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((row) => {
                    const isOperator = row.action.startsWith('operator_force');
                    const operatorId = isOperator
                      ? (row.metadata.operator_id as string | undefined)
                      : null;
                    return (
                      <tr
                        key={row.id}
                        className="hover:bg-gray-50 cursor-pointer"
                        onClick={() => setDetailRow(row)}
                      >
                        <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                          {new Date(row.created_at).toLocaleString('ja-JP')}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            row.scope === 'organization'
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-green-100 text-green-700'
                          }`}>
                            {row.scope === 'organization' ? '組織' : '家族'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-900 font-mono text-xs">{row.action}</td>
                        <td className="px-4 py-3 text-gray-600 text-xs">
                          {isOperator ? (
                            <span className="text-orange-600 font-medium">
                              [SYS] op:{operatorId ? operatorId.slice(0, 8) : '?'}
                            </span>
                          ) : row.actor_id ? (
                            <span className="font-mono">{row.actor_id.slice(0, 8)}...</span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* ページネーション */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
              <p className="text-xs text-gray-500">全 {total} 件 / {page} / {totalPages} ページ</p>
              <div className="flex gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                >
                  前へ
                </button>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                >
                  次へ
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {detailRow && (
        <MetaDetailModal row={detailRow} onClose={() => setDetailRow(null)} />
      )}
    </div>
  );
}
