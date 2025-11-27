"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";

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

export default function SuperAdminDashboard() {
  const [dbStats, setDbStats] = useState<DbStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
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
    };
    fetchStats();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-4 border-purple-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Super Admin Dashboard</h1>
        <p className="text-purple-300 mt-1">システム全体の管理と監視</p>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Link href="/super-admin/admins">
          <motion.div
            whileHover={{ scale: 1.02 }}
            className="bg-gradient-to-br from-purple-600 to-indigo-600 rounded-2xl p-6 text-white shadow-lg cursor-pointer"
          >
            <div className="text-3xl mb-2">👑</div>
            <h3 className="font-bold">管理者管理</h3>
            <p className="text-sm text-purple-200 mt-1">ロールの割り当て</p>
          </motion.div>
        </Link>
        <Link href="/super-admin/settings">
          <motion.div
            whileHover={{ scale: 1.02 }}
            className="bg-gradient-to-br from-blue-600 to-cyan-600 rounded-2xl p-6 text-white shadow-lg cursor-pointer"
          >
            <div className="text-3xl mb-2">⚙️</div>
            <h3 className="font-bold">システム設定</h3>
            <p className="text-sm text-blue-200 mt-1">全体設定の変更</p>
          </motion.div>
        </Link>
        <Link href="/super-admin/feature-flags">
          <motion.div
            whileHover={{ scale: 1.02 }}
            className="bg-gradient-to-br from-green-600 to-emerald-600 rounded-2xl p-6 text-white shadow-lg cursor-pointer"
          >
            <div className="text-3xl mb-2">🚩</div>
            <h3 className="font-bold">機能フラグ</h3>
            <p className="text-sm text-green-200 mt-1">機能のON/OFF</p>
          </motion.div>
        </Link>
        <Link href="/super-admin/database">
          <motion.div
            whileHover={{ scale: 1.02 }}
            className="bg-gradient-to-br from-orange-600 to-red-600 rounded-2xl p-6 text-white shadow-lg cursor-pointer"
          >
            <div className="text-3xl mb-2">🗄️</div>
            <h3 className="font-bold">データベース</h3>
            <p className="text-sm text-orange-200 mt-1">統計とヘルス</p>
          </motion.div>
        </Link>
      </div>

      {/* Today Stats */}
      <div className="bg-white/10 backdrop-blur rounded-2xl p-6">
        <h2 className="text-lg font-bold text-white mb-4">本日の統計</h2>
        <div className="grid grid-cols-3 gap-6">
          <div className="text-center">
            <p className="text-3xl font-bold text-white">{dbStats?.todayStats.newUsers || 0}</p>
            <p className="text-purple-300 text-sm">新規ユーザー</p>
          </div>
          <div className="text-center">
            <p className="text-3xl font-bold text-white">{dbStats?.todayStats.newMeals || 0}</p>
            <p className="text-purple-300 text-sm">新規食事</p>
          </div>
          <div className="text-center">
            <p className="text-3xl font-bold text-white">{dbStats?.todayStats.aiSessions || 0}</p>
            <p className="text-purple-300 text-sm">AI相談</p>
          </div>
        </div>
      </div>

      {/* AI Usage */}
      <div className="bg-white/10 backdrop-blur rounded-2xl p-6">
        <h2 className="text-lg font-bold text-white mb-4">AI利用状況</h2>
        <div className="grid grid-cols-3 gap-6">
          <div>
            <p className="text-2xl font-bold text-white">{dbStats?.aiUsage.totalMessages?.toLocaleString() || 0}</p>
            <p className="text-purple-300 text-sm">総メッセージ数</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-white">{dbStats?.aiUsage.totalTokens?.toLocaleString() || 0}</p>
            <p className="text-purple-300 text-sm">総トークン数</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-white">${dbStats?.aiUsage.estimatedCost?.toFixed(2) || "0.00"}</p>
            <p className="text-purple-300 text-sm">推定コスト</p>
          </div>
        </div>
      </div>

      {/* Table Counts */}
      {dbStats?.tableCounts && (
        <div className="bg-white/10 backdrop-blur rounded-2xl p-6">
          <h2 className="text-lg font-bold text-white mb-4">データベース概要</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Object.entries(dbStats.tableCounts).map(([table, count]) => (
              <div key={table} className="bg-white/5 rounded-xl p-4">
                <p className="text-white font-medium">{table}</p>
                <p className="text-2xl font-bold text-purple-300">{count.toLocaleString()}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

