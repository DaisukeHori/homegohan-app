"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface DataExport {
  id: string;
  export_type: string;
  format: string;
  status: string;
  requested_by: string;
  created_at: string;
  file_url: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-yellow-800 text-yellow-200",
  processing: "bg-blue-800 text-blue-200",
  completed: "bg-green-800 text-green-200",
  failed: "bg-red-800 text-red-200",
  cancelled: "bg-slate-700 text-slate-300",
};

const EXPORT_TYPE_LABELS: Record<string, string> = {
  user_data: "ユーザーデータ",
  audit_logs: "監査ログ",
  meal_records: "食事記録",
  org_data: "組織データ",
  gdpr: "GDPR削除",
};

export default function ExportsPage() {
  const [exports, setExports] = useState<DataExport[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchExports = async () => {
      try {
        const res = await fetch("/api/super-admin/exports");
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        const { data } = await res.json();
        setExports(data ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "読み込みに失敗しました");
      } finally {
        setIsLoading(false);
      }
    };
    fetchExports();
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm("このエクスポートをキャンセルしますか？")) return;
    try {
      const res = await fetch(`/api/super-admin/exports/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      setExports((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : "キャンセルに失敗しました");
    }
  };

  if (isLoading) {
    return (
      <div className="p-8 flex justify-center">
        <div className="w-10 h-10 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-900/50 border border-red-500 rounded-xl p-4 text-red-300">{error}</div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">データエクスポート</h1>
          <p className="text-slate-400 mt-1">DB エクスポート・GDPR 削除リクエスト管理</p>
        </div>
        <Link
          href="/super-admin/exports/new"
          className="bg-purple-600 hover:bg-purple-700 text-white px-5 py-2.5 rounded-lg font-semibold transition-colors"
        >
          + 新規エクスポート
        </Link>
      </div>

      <div className="mb-4 bg-blue-900/30 border border-blue-700 rounded-xl p-4 text-blue-300 text-sm">
        ⚠️ 実エクスポート処理は cron ジョブが担当します。本画面はリクエスト管理とステータス追跡のみです。
      </div>

      {exports.length === 0 ? (
        <div className="bg-slate-800 rounded-xl p-12 text-center text-slate-400 border border-slate-700">
          <div className="text-5xl mb-4">📤</div>
          <p>エクスポートリクエストがありません</p>
          <Link href="/super-admin/exports/new" className="mt-4 inline-block text-purple-400 hover:text-purple-300">
            エクスポートを開始する
          </Link>
        </div>
      ) : (
        <div className="bg-slate-800 rounded-xl overflow-hidden border border-slate-700">
          <table className="w-full">
            <thead className="border-b border-slate-700">
              <tr className="text-slate-400 text-sm">
                <th className="text-left px-6 py-4 font-medium">種別</th>
                <th className="text-left px-6 py-4 font-medium">形式</th>
                <th className="text-left px-6 py-4 font-medium">ステータス</th>
                <th className="text-left px-6 py-4 font-medium">依頼日</th>
                <th className="text-left px-6 py-4 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {exports.map((exp) => {
                const badge = STATUS_BADGE[exp.status] ?? STATUS_BADGE.pending;
                return (
                  <tr key={exp.id} className="hover:bg-slate-700/50 transition-colors">
                    <td className="px-6 py-4 text-white text-sm">
                      {EXPORT_TYPE_LABELS[exp.export_type] ?? exp.export_type}
                    </td>
                    <td className="px-6 py-4">
                      <code className="text-slate-300 text-xs bg-slate-700 px-2 py-1 rounded">{exp.format.toUpperCase()}</code>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${badge}`}>
                        {exp.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-slate-300 text-sm">
                      {new Date(exp.created_at).toLocaleString("ja-JP")}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-3">
                        {exp.file_url && (
                          <a
                            href={exp.file_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-purple-400 hover:text-purple-300 text-sm transition-colors"
                          >
                            DL
                          </a>
                        )}
                        {(exp.status === "pending" || exp.status === "processing") && (
                          <button
                            onClick={() => handleDelete(exp.id)}
                            className="text-red-400 hover:text-red-300 text-sm transition-colors"
                          >
                            キャンセル
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
