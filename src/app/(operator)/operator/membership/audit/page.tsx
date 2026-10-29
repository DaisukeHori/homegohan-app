'use client';

/**
 * /operator/membership/audit
 * membership_audit テーブル一覧 + フィルタ
 * 05-operator-emergency-ui.md §5.4 準拠
 *
 * 操作 (action)・対象 (scope) は内部の英字の値を出さず、日本語の表示名 (src/lib/membership/audit-labels.ts) にする。
 * 表に無い値は「不明な操作」「不明な対象」の固定の文 (#2086 V5)。
 */

import { useState, useEffect, useCallback } from 'react';
import { lastPageToRefetch } from '@/lib/list-pagination';
import {
  displayableOperatorError,
  fetchOperatorJson,
  operatorLoadFailedMessage,
  OperatorScreenError,
} from '@/lib/membership/operator-screen-messages';
import {
  MEMBERSHIP_AUDIT_ACTIONS,
  MEMBERSHIP_AUDIT_SCOPES,
  membershipAuditActionLabel,
  membershipAuditScopeLabel,
  type MembershipAuditScope,
} from '@/lib/membership/audit-labels';

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

/** 一覧の API の応答 ({ data, meta }) */
type AuditListBody = {
  data?: AuditRow[];
  meta?: { total?: number };
};

/** 読み込みの失敗の文の対象 */
const AUDIT_SUBJECT = '監査ログ';
/** 読み込みの失敗で、例外の文が出せないときの固定の文 */
const AUDIT_LOAD_FAILED_FALLBACK = `${AUDIT_SUBJECT}を読み込めませんでした`;

/** 絞り込みで「絞らない」の選択肢の文 */
const FILTER_ALL_LABEL = 'すべて';
/** 操作した人が無い (DB の関数が書いた) 行の、操作した人の文 */
const SYSTEM_ACTOR_LABEL = '(システム)';
/** 運営の強制操作の行の、操作した人の文の頭 (後ろに運営者の ID の先頭を付ける) */
const OPERATOR_ACTOR_LABEL = '運営';
/** 運営の強制操作の操作の値の頭 (operator_force_owner_transfer など) */
const OPERATOR_FORCE_ACTION_PREFIX = 'operator_force';
/** 一覧の操作した人の列に出す、ID の先頭の文字数 */
const ACTOR_ID_PREFIX_LENGTH = 8;

/** 対象の札の色 (表に無い対象は灰色) */
const SCOPE_BADGE_CLASSES: Record<MembershipAuditScope, string> = {
  organization: 'bg-blue-100 text-blue-700',
  family: 'bg-green-100 text-green-700',
};
const SCOPE_BADGE_UNKNOWN_CLASS = 'bg-gray-100 text-gray-700';

function scopeBadgeClass(scope: string): string {
  return Object.prototype.hasOwnProperty.call(SCOPE_BADGE_CLASSES, scope)
    ? SCOPE_BADGE_CLASSES[scope as MembershipAuditScope]
    : SCOPE_BADGE_UNKNOWN_CLASS;
}

/** 一覧の API の本文の data が配列か (data が配列でない壊れた応答を「0 件」と見せない。#2086 V7 と同じ型) */
function hasRows(body: AuditListBody): body is AuditListBody & { data: AuditRow[] } {
  return Array.isArray(body.data);
}

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
            <dt className="font-medium text-gray-500">記録の ID</dt>
            <dd className="text-gray-900 font-mono text-xs">{row.id}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">日時</dt>
            <dd className="text-gray-900">{new Date(row.created_at).toLocaleString('ja-JP')}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">対象 / ID</dt>
            <dd className="text-gray-900">
              {membershipAuditScopeLabel(row.scope)} / <span className="font-mono text-xs">{row.scope_id}</span>
            </dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">操作</dt>
            <dd className="text-gray-900">{membershipAuditActionLabel(row.action)}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">操作した人</dt>
            <dd className="text-gray-900 font-mono text-xs">{row.actor_id ?? SYSTEM_ACTOR_LABEL}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">相手の利用者</dt>
            <dd className="text-gray-900 font-mono text-xs">{row.target_user_id ?? '-'}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-500">付随の情報</dt>
            <dd className="bg-gray-50 rounded p-3 font-mono text-xs whitespace-pre-wrap break-all">
              {JSON.stringify(row.metadata, null, 2)}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

/** 対象の絞り込みの選択肢 (送る値は内部の値、文は表示名) */
const SCOPE_OPTIONS = [
  { value: '', label: FILTER_ALL_LABEL },
  ...MEMBERSHIP_AUDIT_SCOPES.map((value) => ({ value, label: membershipAuditScopeLabel(value) })),
];

/** 操作の絞り込みの選択肢 (DB の操作の全値。送る値は内部の値、文は表示名) */
const ACTION_OPTIONS = [
  { value: '', label: FILTER_ALL_LABEL },
  ...MEMBERSHIP_AUDIT_ACTIONS.map((value) => ({ value, label: membershipAuditActionLabel(value) })),
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

      // 通信の失敗・本文に文の無い失敗も日本語の文にする (ブラウザの英字の文・「HTTP 502」だけを出さない。#2080 U5)
      const json = (await fetchOperatorJson(`/api/operator/membership/audit?${sp.toString()}`, AUDIT_SUBJECT)) as AuditListBody;
      // data が配列でない壊れた応答は、読み込めなかったものとして扱う (「ログがありません」(0 件) と見せない。#2086 V7 と同じ型)
      if (!hasRows(json)) throw new OperatorScreenError(operatorLoadFailedMessage(AUDIT_SUBJECT, null));
      // 件数より後ろのページは、空のページを見せずに最後のページへ取り直す (#1917)
      const refetchPage = lastPageToRefetch({ rows: json.data.length, page, total: json.meta?.total ?? 0, perPage: limit });
      if (refetchPage !== null) {
        setPage(refetchPage);
        return;
      }
      setRows(json.data);
      setTotal(json.meta?.total ?? 0);
    } catch (err) {
      setError(displayableOperatorError(err, AUDIT_LOAD_FAILED_FALLBACK));
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
        <p className="text-sm text-gray-500 mt-1">組織・家族のメンバーシップの操作の記録をすべて閲覧できます (スーパー管理者のみ)</p>
      </div>

      {/* フィルタ */}
      <form onSubmit={handleSearch} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">対象</label>
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
            <label className="block text-xs text-gray-500 mb-1">操作</label>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              {ACTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">開始日</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">終了日</label>
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
                    <th className="px-4 py-3 font-medium">対象</th>
                    <th className="px-4 py-3 font-medium">操作</th>
                    <th className="px-4 py-3 font-medium">操作した人</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((row) => {
                    const isOperator = row.action.startsWith(OPERATOR_FORCE_ACTION_PREFIX);
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
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${scopeBadgeClass(row.scope)}`}>
                            {membershipAuditScopeLabel(row.scope)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-900 text-xs">{membershipAuditActionLabel(row.action)}</td>
                        <td className="px-4 py-3 text-gray-600 text-xs">
                          {isOperator ? (
                            <span className="text-orange-600 font-medium">
                              {OPERATOR_ACTOR_LABEL} ({operatorId ? operatorId.slice(0, ACTOR_ID_PREFIX_LENGTH) : '?'})
                            </span>
                          ) : row.actor_id ? (
                            <span className="font-mono">{row.actor_id.slice(0, ACTOR_ID_PREFIX_LENGTH)}...</span>
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
