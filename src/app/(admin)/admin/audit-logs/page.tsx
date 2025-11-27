"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";

interface AuditLog {
  id: string;
  adminId: string;
  adminName: string;
  actionType: string;
  targetId: string | null;
  details: any;
  severity: string;
  createdAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  update_role: "ロール変更",
  ban_user: "ユーザーBAN",
  unban_user: "BAN解除",
  create_announcement: "お知らせ作成",
  update_announcement: "お知らせ更新",
  delete_announcement: "お知らせ削除",
  resolve_inquiry: "問い合わせ解決",
  moderation_approve: "モデレーション承認",
  moderation_delete: "モデレーション削除",
  add_user_note: "ユーザーノート追加",
  create_organization: "組織作成",
  change_admin_role: "管理者ロール変更",
  update_system_setting: "システム設定変更",
  update_feature_flags: "機能フラグ更新",
};

const SEVERITY_COLORS: Record<string, string> = {
  info: "bg-blue-100 text-blue-700",
  warning: "bg-yellow-100 text-yellow-700",
  high: "bg-red-100 text-red-700",
};

export default function AdminAuditLogsPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [actionFilter, setActionFilter] = useState("");

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      params.set("limit", "50");
      if (actionFilter) params.set("action_type", actionFilter);

      const res = await fetch(`/api/admin/audit-logs?${params}`);
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs);
        setTotalPages(data.pagination.totalPages);
      }
    } catch (error) {
      console.error("Failed to fetch audit logs:", error);
    } finally {
      setLoading(false);
    }
  }, [page, actionFilter]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-orange-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-bold text-gray-800">監査ログ</h1>
        <select
          value={actionFilter}
          onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
          className="px-4 py-2 bg-white border border-gray-200 rounded-lg"
        >
          <option value="">すべてのアクション</option>
          {Object.entries(ACTION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      <div className="bg-white rounded-xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">日時</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">管理者</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">アクション</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">詳細</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-600">重要度</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {logs.map((log) => (
              <motion.tr
                key={log.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="hover:bg-gray-50"
              >
                <td className="px-4 py-3 text-sm text-gray-600">
                  {new Date(log.createdAt).toLocaleString('ja-JP')}
                </td>
                <td className="px-4 py-3 text-sm text-gray-800 font-medium">
                  {log.adminName}
                </td>
                <td className="px-4 py-3 text-sm text-gray-800">
                  {ACTION_LABELS[log.actionType] || log.actionType}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">
                  {log.targetId ? `ID: ${log.targetId.substring(0, 8)}...` : "-"}
                  {log.details && (
                    <span className="ml-2 text-xs text-gray-400">
                      {JSON.stringify(log.details).substring(0, 50)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${SEVERITY_COLORS[log.severity] || 'bg-gray-100'}`}>
                    {log.severity}
                  </span>
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
        {logs.length === 0 && (
          <div className="p-8 text-center text-gray-400">ログがありません</div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-4 py-2 bg-gray-100 rounded-lg disabled:opacity-50"
          >
            前へ
          </button>
          <span className="px-4 py-2">{page} / {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-4 py-2 bg-gray-100 rounded-lg disabled:opacity-50"
          >
            次へ
          </button>
        </div>
      )}
    </div>
  );
}

