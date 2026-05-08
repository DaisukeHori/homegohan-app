"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface InfraMetric {
  id: string;
  metric_name: string;
  source: string;
  value: number;
  unit: string | null;
  tags: Record<string, unknown>;
  recorded_at: string;
}

const SOURCES = ["vercel", "supabase", "gemini", "xai", "anthropic", "openai", "custom"] as const;

export default function InfraMetricsPage() {
  const [metrics, setMetrics] = useState<InfraMetric[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string>("");
  const [metricName, setMetricName] = useState("");

  const fetchMetrics = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (source) params.set("source", source);
      if (metricName) params.set("metric_name", metricName);

      const res = await fetch(`/api/super-admin/infra/metrics?${params}`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      const { data } = await res.json();
      setMetrics(data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "読み込みに失敗しました");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const groupedByMetric = metrics.reduce<Record<string, InfraMetric[]>>((acc, m) => {
    const key = `${m.source}:${m.metric_name}`;
    acc[key] = acc[key] ?? [];
    acc[key].push(m);
    return acc;
  }, {});

  return (
    <div className="p-8">
      <div className="mb-6">
        <Link href="/super-admin/infra" className="text-slate-400 hover:text-white transition-colors">
          ← インフラ監視
        </Link>
      </div>

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">インフラメトリクス</h1>
          <p className="text-slate-400 mt-1">各サービスのメトリクス時系列</p>
        </div>
        <button
          onClick={fetchMetrics}
          className="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg text-sm transition-colors"
        >
          更新
        </button>
      </div>

      {/* フィルタ */}
      <div className="flex gap-3 mb-6">
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="bg-slate-800 text-white rounded-lg px-4 py-2.5 border border-slate-700 focus:border-purple-500 outline-none text-sm"
        >
          <option value="">全ソース</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          type="text"
          value={metricName}
          onChange={(e) => setMetricName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && fetchMetrics()}
          placeholder="メトリクス名でフィルタ"
          className="bg-slate-800 text-white rounded-lg px-4 py-2.5 border border-slate-700 focus:border-purple-500 outline-none text-sm flex-1"
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <div className="w-10 h-10 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-red-900/50 border border-red-500 rounded-xl p-4 text-red-300">{error}</div>
      ) : metrics.length === 0 ? (
        <div className="bg-slate-800 rounded-xl p-12 text-center text-slate-400 border border-slate-700">
          <div className="text-5xl mb-4">📊</div>
          <p>メトリクスデータがありません</p>
          <p className="text-sm mt-2">infra_metrics テーブルへの書き込みは operator-F (cron) が担当します</p>
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(groupedByMetric).map(([key, rows]) => {
            const latest = rows[0];
            const minVal = Math.min(...rows.map((r) => r.value));
            const maxVal = Math.max(...rows.map((r) => r.value));
            return (
              <div key={key} className="bg-slate-800 rounded-xl p-5 border border-slate-700">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <code className="text-purple-300 font-mono text-sm">{latest.metric_name}</code>
                    <span className="ml-3 bg-slate-700 text-slate-300 text-xs px-2 py-0.5 rounded">{latest.source}</span>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold text-white">
                      {latest.value.toFixed(2)}{latest.unit ? ` ${latest.unit}` : ""}
                    </div>
                    <div className="text-slate-400 text-xs">
                      最新: {new Date(latest.recorded_at).toLocaleString("ja-JP")}
                    </div>
                  </div>
                </div>

                {/* 簡易グラフ (SVG バー) */}
                {rows.length > 1 && (
                  <div className="flex items-end gap-0.5 h-12">
                    {rows.slice(0, 50).reverse().map((r, i) => {
                      const height = maxVal > minVal
                        ? ((r.value - minVal) / (maxVal - minVal)) * 100
                        : 50;
                      return (
                        <div
                          key={i}
                          className="flex-1 bg-purple-600/60 rounded-t"
                          style={{ height: `${Math.max(4, height)}%` }}
                          title={`${r.value}${r.unit ?? ""} @ ${new Date(r.recorded_at).toLocaleString("ja-JP")}`}
                        />
                      );
                    })}
                  </div>
                )}

                <div className="flex justify-between text-slate-500 text-xs mt-1">
                  <span>min: {minVal.toFixed(2)}</span>
                  <span>max: {maxVal.toFixed(2)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
