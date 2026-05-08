"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface InfraAlert {
  id: string;
  metric_name: string;
  threshold: number;
  comparison: string;
  triggered_at: string;
  resolved_at: string | null;
  details: Record<string, unknown> | null;
  ack_by: string | null;
  ack_at: string | null;
}

interface ExternalSource {
  source: string;
  available: boolean;
}

export default function InfraPage() {
  const [alerts, setAlerts] = useState<InfraAlert[]>([]);
  const [externalSources, setExternalSources] = useState<ExternalSource[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("open");

  useEffect(() => {
    const fetchAlerts = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const resolved = filter === "all" ? "" : filter === "resolved" ? "true" : "false";
        const res = await fetch(`/api/super-admin/infra/alerts?resolved=${resolved}`);
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        const { data, external_sources } = await res.json();
        setAlerts(data ?? []);
        setExternalSources(external_sources ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "読み込みに失敗しました");
      } finally {
        setIsLoading(false);
      }
    };
    fetchAlerts();
  }, [filter]);

  const openCount = alerts.filter((a) => !a.resolved_at).length;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">インフラ監視</h1>
          <p className="text-slate-400 mt-1">アラート一覧・メトリクス</p>
        </div>
        <Link
          href="/super-admin/infra/metrics"
          className="bg-slate-700 hover:bg-slate-600 text-white px-5 py-2.5 rounded-lg font-semibold transition-colors text-sm"
        >
          メトリクスグラフ →
        </Link>
      </div>

      {/* 外部サービス接続状態 (graceful) */}
      <div className="mb-6 flex gap-3">
        {externalSources.map((src) => (
          <div
            key={src.source}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
              src.available ? "bg-green-900/50 text-green-300 border border-green-700" : "bg-slate-800 text-slate-500 border border-slate-700"
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${src.available ? "bg-green-400" : "bg-slate-500"}`} />
            {src.source === "sentry" ? "Sentry" : "Better Stack"}
            {!src.available && " (未設定)"}
          </div>
        ))}
      </div>

      {/* フィルタ */}
      <div className="flex gap-2 mb-6">
        {(["all", "open", "resolved"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filter === f ? "bg-purple-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"
            }`}
          >
            {f === "all" ? "すべて" : f === "open" ? `未解決 (${openCount})` : "解決済み"}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <div className="w-10 h-10 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-red-900/50 border border-red-500 rounded-xl p-4 text-red-300">{error}</div>
      ) : alerts.length === 0 ? (
        <div className="bg-slate-800 rounded-xl p-12 text-center text-slate-400 border border-slate-700">
          <div className="text-5xl mb-4">✅</div>
          <p>{filter === "open" ? "未解決のアラートはありません" : "アラートがありません"}</p>
        </div>
      ) : (
        <div className="bg-slate-800 rounded-xl overflow-hidden border border-slate-700">
          <table className="w-full">
            <thead className="border-b border-slate-700">
              <tr className="text-slate-400 text-sm">
                <th className="text-left px-6 py-4 font-medium">メトリクス</th>
                <th className="text-left px-6 py-4 font-medium">閾値</th>
                <th className="text-left px-6 py-4 font-medium">発火日時</th>
                <th className="text-left px-6 py-4 font-medium">ステータス</th>
                <th className="text-left px-6 py-4 font-medium">確認者</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {alerts.map((alert) => (
                <tr key={alert.id} className="hover:bg-slate-700/50 transition-colors">
                  <td className="px-6 py-4">
                    <code className="text-purple-300 text-sm font-mono">{alert.metric_name}</code>
                  </td>
                  <td className="px-6 py-4 text-slate-300 text-sm">
                    {alert.comparison} {alert.threshold}
                  </td>
                  <td className="px-6 py-4 text-slate-300 text-sm">
                    {new Date(alert.triggered_at).toLocaleString("ja-JP")}
                  </td>
                  <td className="px-6 py-4">
                    {alert.resolved_at ? (
                      <span className="bg-green-800 text-green-200 text-xs px-2.5 py-1 rounded-full">解決済み</span>
                    ) : (
                      <span className="bg-red-800 text-red-200 text-xs px-2.5 py-1 rounded-full">未解決</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-slate-400 text-sm">
                    {alert.ack_by ? "確認済み" : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
