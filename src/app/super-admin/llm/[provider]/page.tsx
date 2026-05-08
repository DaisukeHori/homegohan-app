"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

const PROVIDER_LABELS: Record<string, { label: string; models: string[] }> = {
  gemini: {
    label: "Google Gemini",
    models: ["gemini-2.0-flash", "gemini-2.0-flash-lite"],
  },
  xai: {
    label: "xAI Grok",
    models: ["grok-4-1-fast-non-reasoning", "grok-4-1-fast", "grok-4"],
  },
  anthropic: {
    label: "Anthropic Claude",
    models: ["claude-3-5-sonnet-20241022"],
  },
  openai: {
    label: "OpenAI",
    models: ["gpt-4o", "gpt-4o-mini"],
  },
};

interface ModelStats {
  model: string;
  provider: string;
  requests: number;
  tokens: number;
  cost_usd: number;
}

export default function ProviderDetailPage({ params }: { params: { provider: string } }) {
  const [period, setPeriod] = useState("7d");
  const [modelStats, setModelStats] = useState<ModelStats[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const providerInfo = PROVIDER_LABELS[params.provider];

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/super-admin/llm/usage?period=${period}&provider=${params.provider}`);
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        const { data } = await res.json();
        setModelStats(data.by_model ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "読み込みに失敗しました");
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, [period, params.provider]);

  if (!providerInfo) {
    return (
      <div className="p-8">
        <div className="bg-red-900/50 border border-red-500 rounded-xl p-4 text-red-300">
          不明なプロバイダーです: {params.provider}
        </div>
      </div>
    );
  }

  const totalCost = modelStats.reduce((s, m) => s + m.cost_usd, 0);
  const totalRequests = modelStats.reduce((s, m) => s + m.requests, 0);

  return (
    <div className="p-8">
      <div className="mb-6">
        <Link href="/super-admin/llm" className="text-slate-400 hover:text-white transition-colors">
          ← LLM 使用量
        </Link>
      </div>

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">{providerInfo.label}</h1>
          <p className="text-slate-400 mt-1">プロバイダー別詳細使用量</p>
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

      {isLoading ? (
        <div className="flex justify-center py-20">
          <div className="w-10 h-10 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-red-900/50 border border-red-500 rounded-xl p-4 text-red-300">{error}</div>
      ) : (
        <div className="space-y-6">
          {/* 集計 */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
              <div className="text-slate-400 text-sm">総コスト</div>
              <div className="text-2xl font-bold text-white mt-1">${totalCost.toFixed(4)}</div>
            </div>
            <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
              <div className="text-slate-400 text-sm">総リクエスト</div>
              <div className="text-2xl font-bold text-white mt-1">{totalRequests.toLocaleString()}</div>
            </div>
            <div className="bg-slate-800 rounded-xl p-5 border border-slate-700">
              <div className="text-slate-400 text-sm">使用モデル数</div>
              <div className="text-2xl font-bold text-white mt-1">{modelStats.length}</div>
            </div>
          </div>

          {/* モデル別詳細 */}
          <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
            <h2 className="text-lg font-semibold text-white mb-4">モデル別詳細</h2>

            {modelStats.length === 0 ? (
              <div className="text-center py-8 text-slate-400">
                <div className="text-4xl mb-3">📊</div>
                <p>この期間の使用データがありません</p>
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="text-slate-400 text-sm border-b border-slate-700">
                    <th className="text-left pb-3">モデル</th>
                    <th className="text-right pb-3">リクエスト</th>
                    <th className="text-right pb-3">トークン</th>
                    <th className="text-right pb-3">コスト (USD)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700">
                  {modelStats.map((m) => (
                    <tr key={m.model}>
                      <td className="py-3 text-white font-mono text-sm">{m.model}</td>
                      <td className="py-3 text-slate-300 text-sm text-right">{m.requests.toLocaleString()}</td>
                      <td className="py-3 text-slate-300 text-sm text-right">{(m.tokens / 1000).toFixed(1)}K</td>
                      <td className="py-3 text-slate-300 text-sm text-right">${m.cost_usd.toFixed(6)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 想定モデル一覧 */}
          <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
            <h2 className="text-lg font-semibold text-white mb-4">このプロバイダーのモデル (設計書 operator/06)</h2>
            <div className="flex flex-wrap gap-2">
              {providerInfo.models.map((m) => (
                <span key={m} className="bg-slate-700 text-slate-300 text-xs font-mono px-3 py-1.5 rounded-lg">
                  {m}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
