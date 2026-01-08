"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface Summary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCost: number;
  avgDuration: number;
}

interface FunctionUsage {
  function_name: string;
  call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost: number;
  avg_duration: number;
}

interface UserUsage {
  user_id: string;
  call_count: number;
  total_tokens: number;
  total_cost: number;
}

interface ModelUsage {
  model: string;
  call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost: number;
}

interface TimeSeriesData {
  time_bucket: string;
  total_tokens: number;
  total_cost: number;
  call_count: number;
}

interface UsageData {
  period: string;
  summary: Summary;
  byFunction: FunctionUsage[];
  byUser: UserUsage[];
  byModel: ModelUsage[];
  timeSeries: TimeSeriesData[];
}

const COLORS = [
  "#8b5cf6", "#6366f1", "#3b82f6", "#0ea5e9", "#14b8a6",
  "#22c55e", "#84cc16", "#eab308", "#f97316", "#ef4444",
  "#ec4899", "#d946ef"
];

const PERIOD_OPTIONS = [
  { value: "1d", label: "24時間" },
  { value: "7d", label: "7日間" },
  { value: "30d", label: "30日間" },
  { value: "90d", label: "90日間" },
];

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}

function formatCost(n: number): string {
  return "$" + n.toFixed(4);
}

function formatDuration(ms: number): string {
  if (ms >= 60000) return (ms / 60000).toFixed(1) + "分";
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "秒";
  return Math.round(ms) + "ms";
}

export default function LLMUsageDashboard() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("7d");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setRefreshing(true);
      const res = await fetch(`/api/super-admin/llm-usage?period=${period}`);
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to fetch data");
      }
      const result = await res.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [period]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // 自動更新（30秒ごと）
  useEffect(() => {
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-purple-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-500/20 rounded-xl p-6 text-red-300">
        <h3 className="font-bold mb-2">エラー</h3>
        <p>{error}</p>
        <button
          onClick={fetchData}
          className="mt-4 px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-white"
        >
          再試行
        </button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">LLMトークン使用量</h1>
          <p className="text-purple-300 mt-1">AI機能のトークン消費とコストを監視</p>
        </div>
        <div className="flex items-center gap-4">
          {/* Period Selector */}
          <div className="flex bg-white/10 rounded-xl p-1">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  period === opt.value
                    ? "bg-purple-600 text-white"
                    : "text-purple-300 hover:text-white"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {/* Refresh Button */}
          <button
            onClick={fetchData}
            disabled={refreshing}
            className="p-2 bg-white/10 hover:bg-white/20 rounded-xl transition-colors disabled:opacity-50"
          >
            <span className={`text-xl ${refreshing ? "animate-spin" : ""}`}>🔄</span>
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-gradient-to-br from-purple-600 to-indigo-600 rounded-2xl p-4 text-white"
        >
          <p className="text-sm text-purple-200">総呼び出し回数</p>
          <p className="text-2xl font-bold mt-1">{formatNumber(data.summary.totalCalls)}</p>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="bg-gradient-to-br from-blue-600 to-cyan-600 rounded-2xl p-4 text-white"
        >
          <p className="text-sm text-blue-200">入力トークン</p>
          <p className="text-2xl font-bold mt-1">{formatNumber(data.summary.totalInputTokens)}</p>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-gradient-to-br from-green-600 to-emerald-600 rounded-2xl p-4 text-white"
        >
          <p className="text-sm text-green-200">出力トークン</p>
          <p className="text-2xl font-bold mt-1">{formatNumber(data.summary.totalOutputTokens)}</p>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="bg-gradient-to-br from-yellow-600 to-orange-600 rounded-2xl p-4 text-white"
        >
          <p className="text-sm text-yellow-200">合計トークン</p>
          <p className="text-2xl font-bold mt-1">{formatNumber(data.summary.totalTokens)}</p>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-gradient-to-br from-red-600 to-pink-600 rounded-2xl p-4 text-white"
        >
          <p className="text-sm text-red-200">推定コスト</p>
          <p className="text-2xl font-bold mt-1">{formatCost(data.summary.totalCost)}</p>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="bg-gradient-to-br from-slate-600 to-slate-700 rounded-2xl p-4 text-white"
        >
          <p className="text-sm text-slate-300">平均レスポンス</p>
          <p className="text-2xl font-bold mt-1">{formatDuration(data.summary.avgDuration)}</p>
        </motion.div>
      </div>

      {/* Time Series Chart */}
      {data.timeSeries.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-white/10 backdrop-blur rounded-2xl p-6"
        >
          <h2 className="text-lg font-bold text-white mb-4">トークン使用量の推移</h2>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.timeSeries}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff20" />
                <XAxis 
                  dataKey="time_bucket" 
                  stroke="#a78bfa"
                  tick={{ fill: "#a78bfa", fontSize: 12 }}
                  tickFormatter={(value) => {
                    if (period === "1d") {
                      return value.slice(11, 16);
                    }
                    return value.slice(5, 10);
                  }}
                />
                <YAxis 
                  stroke="#a78bfa"
                  tick={{ fill: "#a78bfa", fontSize: 12 }}
                  tickFormatter={formatNumber}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1e1b4b",
                    border: "1px solid #6366f1",
                    borderRadius: "12px",
                    color: "#fff",
                  }}
                  formatter={(value: number, name: string) => [
                    name === "total_tokens" ? formatNumber(value) : formatCost(value),
                    name === "total_tokens" ? "トークン" : "コスト"
                  ]}
                  labelFormatter={(label) => period === "1d" ? `${label}` : label}
                />
                <Legend 
                  formatter={(value) => value === "total_tokens" ? "トークン" : "コスト"}
                />
                <Line
                  type="monotone"
                  dataKey="total_tokens"
                  stroke="#8b5cf6"
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 6 }}
                />
                <Line
                  type="monotone"
                  dataKey="call_count"
                  stroke="#22c55e"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </motion.div>
      )}

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* By Function */}
        {data.byFunction.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35 }}
            className="bg-white/10 backdrop-blur rounded-2xl p-6"
          >
            <h2 className="text-lg font-bold text-white mb-4">関数別使用量</h2>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.byFunction.slice(0, 10)} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff20" />
                  <XAxis 
                    type="number" 
                    stroke="#a78bfa"
                    tick={{ fill: "#a78bfa", fontSize: 12 }}
                    tickFormatter={formatNumber}
                  />
                  <YAxis 
                    type="category" 
                    dataKey="function_name" 
                    stroke="#a78bfa"
                    tick={{ fill: "#a78bfa", fontSize: 11 }}
                    width={140}
                    tickFormatter={(value) => value.length > 18 ? value.slice(0, 18) + "..." : value}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#1e1b4b",
                      border: "1px solid #6366f1",
                      borderRadius: "12px",
                      color: "#fff",
                    }}
                    formatter={(value: number) => formatNumber(value)}
                  />
                  <Bar dataKey="total_tokens" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </motion.div>
        )}

        {/* By Model */}
        {data.byModel.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="bg-white/10 backdrop-blur rounded-2xl p-6"
          >
            <h2 className="text-lg font-bold text-white mb-4">モデル別使用量</h2>
            <div className="h-80 flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data.byModel}
                    dataKey="total_tokens"
                    nameKey="model"
                    cx="50%"
                    cy="50%"
                    outerRadius={100}
                    label={({ model, percent }) => `${model} (${(percent * 100).toFixed(0)}%)`}
                    labelLine={{ stroke: "#a78bfa" }}
                  >
                    {data.byModel.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#1e1b4b",
                      border: "1px solid #6366f1",
                      borderRadius: "12px",
                      color: "#fff",
                    }}
                    formatter={(value: number) => [formatNumber(value), "トークン"]}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </motion.div>
        )}
      </div>

      {/* Detailed Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Function Table */}
        {data.byFunction.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45 }}
            className="bg-white/10 backdrop-blur rounded-2xl p-6"
          >
            <h2 className="text-lg font-bold text-white mb-4">関数別詳細</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-purple-300 border-b border-white/10">
                    <th className="text-left py-3 px-2">関数名</th>
                    <th className="text-right py-3 px-2">呼出</th>
                    <th className="text-right py-3 px-2">トークン</th>
                    <th className="text-right py-3 px-2">コスト</th>
                    <th className="text-right py-3 px-2">平均時間</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byFunction.map((row, i) => (
                    <tr key={row.function_name} className="text-white border-b border-white/5 hover:bg-white/5">
                      <td className="py-3 px-2 font-mono text-xs">{row.function_name}</td>
                      <td className="py-3 px-2 text-right">{row.call_count.toLocaleString()}</td>
                      <td className="py-3 px-2 text-right">{formatNumber(row.total_tokens)}</td>
                      <td className="py-3 px-2 text-right">{formatCost(row.total_cost)}</td>
                      <td className="py-3 px-2 text-right">{formatDuration(row.avg_duration)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        )}

        {/* User Table */}
        {data.byUser.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="bg-white/10 backdrop-blur rounded-2xl p-6"
          >
            <h2 className="text-lg font-bold text-white mb-4">ユーザー別使用量 (Top 20)</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-purple-300 border-b border-white/10">
                    <th className="text-left py-3 px-2">#</th>
                    <th className="text-left py-3 px-2">ユーザーID</th>
                    <th className="text-right py-3 px-2">呼出</th>
                    <th className="text-right py-3 px-2">トークン</th>
                    <th className="text-right py-3 px-2">コスト</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byUser.map((row, i) => (
                    <tr key={row.user_id} className="text-white border-b border-white/5 hover:bg-white/5">
                      <td className="py-3 px-2 text-purple-300">{i + 1}</td>
                      <td className="py-3 px-2 font-mono text-xs">{row.user_id.slice(0, 8)}...</td>
                      <td className="py-3 px-2 text-right">{row.call_count.toLocaleString()}</td>
                      <td className="py-3 px-2 text-right">{formatNumber(row.total_tokens)}</td>
                      <td className="py-3 px-2 text-right">{formatCost(row.total_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        )}
      </div>

      {/* No Data Message */}
      {data.byFunction.length === 0 && data.timeSeries.length === 0 && (
        <div className="bg-white/10 backdrop-blur rounded-2xl p-12 text-center">
          <div className="text-6xl mb-4">📊</div>
          <h3 className="text-xl font-bold text-white mb-2">データがありません</h3>
          <p className="text-purple-300">
            選択した期間内にLLM使用量の記録がありません。
            <br />
            Edge Functionsが実行されると、ここにデータが表示されます。
          </p>
        </div>
      )}
    </div>
  );
}
