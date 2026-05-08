"use client";

import { useState, useEffect, useCallback } from "react";

interface AuditLogEntry {
  id: string;
  actor_id: string | null;
  actor_email_snapshot: string | null;
  actor_role_snapshot: string | null;
  action_type: string;
  target_id: string | null;
  target_type: string | null;
  details: Record<string, unknown>;
  severity: "info" | "warn" | "critical";
  ip_address: string | null;
  created_at: string;
}

const SEVERITY_BADGE: Record<string, string> = {
  info: "bg-blue-900 text-blue-300",
  warn: "bg-yellow-900 text-yellow-300",
  critical: "bg-red-900 text-red-300",
};

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // フィルタ
  const [actorId, setActorId] = useState("");
  const [actionType, setActionType] = useState("");
  const [severity, setSeverity] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const PER_PAGE = 50;

  const fetchLogs = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
      if (actorId) params.set("actor_id", actorId);
      if (actionType) params.set("action_type", actionType);
      if (severity) params.set("severity", severity);
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);

      const res = await fetch(`/api/super-admin/audit-logs?${params}`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      const { data, meta } = await res.json();
      setLogs(data ?? []);
      setTotal(meta?.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "読み込みに失敗しました");
    } finally {
      setIsLoading(false);
    }
  }, [page, actorId, actionType, severity, fromDate, toDate]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const handleCSVExport = async () => {
    const params = new URLSearchParams({ format: "csv", per_page: "10000" });
    if (actorId) params.set("actor_id", actorId);
    if (actionType) params.set("action_type", actionType);
    if (severity) params.set("severity", severity);
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);

    const res = await fetch(`/api/super-admin/audit-logs?${params}`);
    if (!res.ok) {
      alert("CSV エクスポートに失敗しました");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalPages = Math.ceil(total / PER_PAGE);

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">監査ログ閲覧</h1>
          <p className="text-slate-400 mt-1">
            全操作履歴 — super_admin のみ閲覧可 (7年保管)
          </p>
        </div>
        <button
          onClick={handleCSVExport}
          className="bg-slate-700 hover:bg-slate-600 text-white px-5 py-2.5 rounded-lg font-semibold transition-colors text-sm"
        >
          CSV エクスポート
        </button>
      </div>

      {/* フィルタ */}
      <div className="bg-slate-800 rounded-xl p-5 border border-slate-700 mb-6">
        <div className="grid grid-cols-5 gap-3">
          <input
            type="text"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
            placeholder="操作者 UUID"
            className="bg-slate-700 text-white rounded-lg px-3 py-2 border border-slate-600 focus:border-purple-500 outline-none text-sm"
          />
          <input
            type="text"
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
            placeholder="アクション (部分一致)"
            className="bg-slate-700 text-white rounded-lg px-3 py-2 border border-slate-600 focus:border-purple-500 outline-none text-sm"
          />
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="bg-slate-700 text-white rounded-lg px-3 py-2 border border-slate-600 focus:border-purple-500 outline-none text-sm"
          >
            <option value="">全重要度</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="critical">critical</option>
          </select>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="bg-slate-700 text-white rounded-lg px-3 py-2 border border-slate-600 focus:border-purple-500 outline-none text-sm"
          />
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="bg-slate-700 text-white rounded-lg px-3 py-2 border border-slate-600 focus:border-purple-500 outline-none text-sm"
          />
        </div>
        <div className="flex justify-end mt-3">
          <button
            onClick={() => { setPage(1); fetchLogs(); }}
            className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            絞り込む
          </button>
        </div>
      </div>

      {/* テーブル */}
      {isLoading ? (
        <div className="flex justify-center py-20">
          <div className="w-10 h-10 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-red-900/50 border border-red-500 rounded-xl p-4 text-red-300">{error}</div>
      ) : logs.length === 0 ? (
        <div className="bg-slate-800 rounded-xl p-12 text-center text-slate-400 border border-slate-700">
          <div className="text-5xl mb-4">📋</div>
          <p>監査ログがありません</p>
        </div>
      ) : (
        <div className="bg-slate-800 rounded-xl overflow-hidden border border-slate-700">
          <div className="px-6 py-3 border-b border-slate-700 text-slate-400 text-sm">
            全 {total.toLocaleString()} 件
          </div>
          <table className="w-full">
            <thead className="border-b border-slate-700">
              <tr className="text-slate-400 text-xs">
                <th className="text-left px-4 py-3 font-medium">日時</th>
                <th className="text-left px-4 py-3 font-medium">操作者</th>
                <th className="text-left px-4 py-3 font-medium">アクション</th>
                <th className="text-left px-4 py-3 font-medium">対象</th>
                <th className="text-left px-4 py-3 font-medium">重要度</th>
                <th className="text-left px-4 py-3 font-medium">詳細</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {logs.map((log) => (
                <>
                  <tr key={log.id} className="hover:bg-slate-700/50 transition-colors">
                    <td className="px-4 py-3 text-slate-300 text-xs whitespace-nowrap">
                      {new Date(log.created_at).toLocaleString("ja-JP")}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-slate-300 text-xs">
                        {log.actor_email_snapshot ?? log.actor_id?.slice(0, 8) ?? "—"}
                      </div>
                      {log.actor_role_snapshot && (
                        <div className="text-slate-500 text-xs">{log.actor_role_snapshot}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-purple-300 text-xs font-mono">{log.action_type}</code>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs">
                      {log.target_type && <span className="text-slate-500">{log.target_type}: </span>}
                      {log.target_id ? log.target_id.slice(0, 8) + "..." : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${SEVERITY_BADGE[log.severity]}`}>
                        {log.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                        className="text-purple-400 hover:text-purple-300 text-xs transition-colors"
                      >
                        {expandedId === log.id ? "閉じる" : "展開"}
                      </button>
                    </td>
                  </tr>
                  {expandedId === log.id && (
                    <tr key={`${log.id}-details`} className="bg-slate-900">
                      <td colSpan={6} className="px-4 py-4">
                        <pre className="text-green-300 text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                          {JSON.stringify(log.details, null, 2)}
                        </pre>
                        {log.ip_address && (
                          <div className="mt-2 text-slate-500 text-xs">IP: {log.ip_address}</div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>

          {/* ページネーション */}
          {totalPages > 1 && (
            <div className="px-6 py-4 border-t border-slate-700 flex items-center justify-between">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed text-sm"
              >
                ← 前へ
              </button>
              <span className="text-slate-400 text-sm">
                {page} / {totalPages} ページ
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed text-sm"
              >
                次へ →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
