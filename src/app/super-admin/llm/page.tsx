"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface LLMUsageData {
  total_cost_usd: number;
  total_cost_jpy: number;
  total_requests: number;
  total_tokens: number;
  by_model: Array<{ model: string; provider: string; requests: number; tokens: number; cost_usd: number }>;
  by_function: Array<{ function: string; requests: number; cost_usd: number }>;
  top_users: Array<{ user_id: string; email: string | null; requests: number; cost_usd: number; is_anomaly: boolean }>;
  timeseries: Array<{ date: string; cost_usd: number; requests: number }>;
  anomalies: Array<{ user_id: string; email: string | null; daily_requests: number }>;
  period: { from: string; to: string };
}

const PROVIDERS = [
  { key: "gemini", label: "Gemini", color: "bg-blue-500" },
  { key: "xai", label: "xAI Grok", color: "bg-yellow-500" },
  { key: "anthropic", label: "Anthropic Claude", color: "bg-orange-500" },
  { key: "openai", label: "OpenAI", color: "bg-green-500" },
];

export default function LLMUsagePage() {
  const [period, setPeriod] = useState("7d");
  const [data, setData] = useState<LLMUsageData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async (selectedPeriod: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/super-admin/llm/usage?period=${selectedPeriod}`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "読み込みに失敗しました");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData(period);
  }, [period]);

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">LLM 使用量</h1>
          <p className="text-slate-400 mt-1">プロバイダー別使用量・コスト・クォータ管理</p>
        </div>

        <div className="flex gap-2">
          {["1d", "7d", "30d"].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                period === p ? "bg-purple-600 text-white" : "bg-slate-700 text-slate-300 hover:bg-slate-600"
              }`}
            >
              {p === "1d" ? "今日" : p === "7d" ? "7日" : "30日"}
            </button>
          ))}
        </div>
      </div>

      {/* アノマリーアラート */}
      {data?.anomalies && data.anomalies.length > 0 && (
        <div className="mb-6 bg-red-900/50 border border-red-500 rounded-xl p-4">
          <div className="flex items-center gap-2 text-red-300 font-semibold mb-2">
            ⚠️ 異常使用を検知 ({data.anomalies.length} ユーザー)
          </div>
          <p className="text-red-400 text-sm">1日 5,000 リクエスト超のユーザーがいます</p>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-20">
          <div className="w-10 h-10 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-red-900/50 border border-red-500 rounded-xl p-4 text-red-300">{error}</div>
      ) : data ? (
        <div className="space-y-6">
          {/* KPI カード */}
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
              <div className="text-slate-400 text-sm">総コスト (USD)</div>
              <div className="text-2xl font-bold text-white mt-1">${data.total_cost_usd.toFixed(2)}</div>
              <div className="text-slate-500 text-sm mt-0.5">¥{data.total_cost_jpy.toLocaleString()}</div>
            </div>
            <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
              <div className="text-slate-400 text-sm">総リクエスト</div>
              <div className="text-2xl font-bold text-white mt-1">{data.total_requests.toLocaleString()}</div>
            </div>
            <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
              <div className="text-slate-400 text-sm">総トークン</div>
              <div className="text-2xl font-bold text-white mt-1">{(data.total_tokens / 1000).toFixed(1)}K</div>
            </div>
            <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
              <div className="text-slate-400 text-sm">異常ユーザー</div>
              <div className={`text-2xl font-bold mt-1 ${data.anomalies.length > 0 ? "text-red-400" : "text-green-400"}`}>
                {data.anomalies.length}
              </div>
            </div>
          </div>

          {/* プロバイダーリンク */}
          <div className="grid grid-cols-4 gap-3">
            {PROVIDERS.map((p) => (
              <Link
                key={p.key}
                href={`/super-admin/llm/${p.key}`}
                className="bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl p-4 flex items-center gap-3 transition-colors"
              >
                <div className={`w-3 h-3 rounded-full ${p.color}`} />
                <span className="text-white text-sm font-medium">{p.label}</span>
              </Link>
            ))}
          </div>

          {/* モデル別内訳 */}
          {data.by_model.length > 0 && (
            <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-4">モデル別内訳</h2>
              <table className="w-full">
                <thead>
                  <tr className="text-slate-400 text-sm border-b border-slate-700">
                    <th className="text-left pb-3">モデル</th>
                    <th className="text-left pb-3">プロバイダー</th>
                    <th className="text-right pb-3">リクエスト</th>
                    <th className="text-right pb-3">コスト (USD)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700">
                  {data.by_model.map((m) => (
                    <tr key={m.model}>
                      <td className="py-3 text-white font-mono text-sm">{m.model}</td>
                      <td className="py-3 text-slate-400 text-sm">{m.provider}</td>
                      <td className="py-3 text-slate-300 text-sm text-right">{m.requests.toLocaleString()}</td>
                      <td className="py-3 text-slate-300 text-sm text-right">${m.cost_usd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ユーザー別 Top 使用 */}
          {data.top_users.length > 0 && (
            <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">ユーザー別使用量 Top 50</h2>
                <Link
                  href="/super-admin/llm/quotas"
                  className="text-purple-400 hover:text-purple-300 text-sm"
                >
                  クォータ設定 →
                </Link>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="text-slate-400 text-sm border-b border-slate-700">
                    <th className="text-left pb-3">ユーザー ID</th>
                    <th className="text-right pb-3">リクエスト</th>
                    <th className="text-right pb-3">コスト (USD)</th>
                    <th className="text-right pb-3">異常</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700">
                  {data.top_users.slice(0, 20).map((u) => (
                    <tr key={u.user_id} className={u.is_anomaly ? "bg-red-900/20" : ""}>
                      <td className="py-3 text-slate-300 text-xs font-mono">{u.user_id}</td>
                      <td className="py-3 text-slate-300 text-sm text-right">{u.requests.toLocaleString()}</td>
                      <td className="py-3 text-slate-300 text-sm text-right">${u.cost_usd.toFixed(4)}</td>
                      <td className="py-3 text-right">
                        {u.is_anomaly && <span className="text-red-400 text-xs">⚠️ 異常</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
