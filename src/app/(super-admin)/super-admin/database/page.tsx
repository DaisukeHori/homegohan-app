"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";

interface DbStats {
  tableCounts: Record<string, number>;
  todayStats: {
    newUsers: number;
    newMeals: number;
    aiSessions: number;
  };
  aiUsage: {
    totalMessages: number;
    totalTokens: number;
    estimatedCost: number;
  };
}

export default function SuperAdminDatabasePage() {
  const [dbStats, setDbStats] = useState<DbStats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/super-admin/db-stats");
      if (res.ok) {
        const data = await res.json();
        setDbStats(data);
      }
    } catch (error) {
      console.error("Failed to fetch stats:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-purple-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // テーブルをカテゴリ別に分類
  const categories: Record<string, string[]> = {
    "ユーザー関連": ["user_profiles", "user_badges", "health_records", "health_goals"],
    "食事関連": ["meal_plans", "planned_meals", "recipes"],
    "AI関連": ["ai_consultation_sessions", "ai_consultation_messages"],
    "組織関連": ["organizations"],
    "システム": ["announcements", "inquiries", "badges"],
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-white">データベース統計</h1>
          <p className="text-purple-300 mt-1">テーブル別のレコード数と統計</p>
        </div>
        <button
          onClick={fetchStats}
          className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 transition-colors"
        >
          🔄 更新
        </button>
      </div>

      {/* AI Usage Summary */}
      <div className="bg-gradient-to-br from-purple-600/30 to-indigo-600/30 rounded-2xl p-6">
        <h2 className="text-lg font-bold text-white mb-4">AI利用サマリー</h2>
        <div className="grid grid-cols-3 gap-6">
          <div className="bg-white/10 rounded-xl p-4 text-center">
            <p className="text-3xl font-bold text-white">
              {dbStats?.aiUsage.totalMessages?.toLocaleString() || 0}
            </p>
            <p className="text-purple-200 text-sm mt-1">総メッセージ数</p>
          </div>
          <div className="bg-white/10 rounded-xl p-4 text-center">
            <p className="text-3xl font-bold text-white">
              {((dbStats?.aiUsage.totalTokens || 0) / 1000000).toFixed(2)}M
            </p>
            <p className="text-purple-200 text-sm mt-1">総トークン数</p>
          </div>
          <div className="bg-white/10 rounded-xl p-4 text-center">
            <p className="text-3xl font-bold text-green-400">
              ${dbStats?.aiUsage.estimatedCost?.toFixed(2) || "0.00"}
            </p>
            <p className="text-purple-200 text-sm mt-1">推定コスト（累計）</p>
          </div>
        </div>
      </div>

      {/* Table Counts by Category */}
      {Object.entries(categories).map(([category, tables]) => (
        <div key={category} className="bg-white/10 backdrop-blur rounded-2xl p-6">
          <h2 className="text-lg font-bold text-white mb-4">{category}</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {tables.map((table) => {
              const count = dbStats?.tableCounts[table];
              return (
                <motion.div
                  key={table}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="bg-white/5 rounded-xl p-4"
                >
                  <p className="text-purple-300 text-sm truncate" title={table}>
                    {table.replace(/_/g, " ")}
                  </p>
                  <p className="text-2xl font-bold text-white mt-1">
                    {count !== undefined ? count.toLocaleString() : "-"}
                  </p>
                </motion.div>
              );
            })}
          </div>
        </div>
      ))}

      {/* All Tables */}
      <div className="bg-white/10 backdrop-blur rounded-2xl p-6">
        <h2 className="text-lg font-bold text-white mb-4">全テーブル一覧</h2>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/10">
                <th className="text-left px-4 py-2 text-purple-300 text-sm">テーブル名</th>
                <th className="text-right px-4 py-2 text-purple-300 text-sm">レコード数</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(dbStats?.tableCounts || {})
                .sort((a, b) => b[1] - a[1])
                .map(([table, count]) => (
                  <tr key={table} className="border-b border-white/5 hover:bg-white/5">
                    <td className="px-4 py-3 text-white">{table}</td>
                    <td className="px-4 py-3 text-right text-purple-200 font-mono">
                      {count.toLocaleString()}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

