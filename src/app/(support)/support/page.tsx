"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";

interface SupportStats {
  overview: {
    pendingInquiries: number;
    inProgressInquiries: number;
    resolvedToday: number;
    totalInquiries: number;
    myResolvedThisWeek: number;
  };
  inquiriesByType: Record<string, number>;
  recentInquiries: {
    id: string;
    inquiryType: string;
    subject: string;
    status: string;
    createdAt: string;
    userName: string;
  }[];
}

const TYPE_LABELS: Record<string, string> = {
  general: "一般",
  support: "サポート",
  bug: "バグ報告",
  feature: "機能要望",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  in_progress: "bg-blue-100 text-blue-700",
  resolved: "bg-green-100 text-green-700",
  closed: "bg-gray-100 text-gray-600",
};

export default function SupportDashboard() {
  const [stats, setStats] = useState<SupportStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch("/api/support/stats");
        if (res.ok) {
          const data = await res.json();
          setStats(data);
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
        <div className="w-10 h-10 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">サポートダッシュボード</h1>
        <p className="text-gray-500 mt-1">問い合わせ対応状況の概要</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">未対応</p>
              <p className="text-3xl font-bold text-yellow-600">{stats?.overview.pendingInquiries || 0}</p>
            </div>
            <div className="w-12 h-12 bg-yellow-100 rounded-xl flex items-center justify-center text-2xl">
              ⏳
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">対応中</p>
              <p className="text-3xl font-bold text-blue-600">{stats?.overview.inProgressInquiries || 0}</p>
            </div>
            <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center text-2xl">
              💬
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">本日解決</p>
              <p className="text-3xl font-bold text-green-600">{stats?.overview.resolvedToday || 0}</p>
            </div>
            <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center text-2xl">
              ✅
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">今週の対応数</p>
              <p className="text-3xl font-bold text-teal-600">{stats?.overview.myResolvedThisWeek || 0}</p>
            </div>
            <div className="w-12 h-12 bg-teal-100 rounded-xl flex items-center justify-center text-2xl">
              🏆
            </div>
          </div>
        </motion.div>
      </div>

      {/* Type Distribution */}
      {stats?.inquiriesByType && Object.keys(stats.inquiriesByType).length > 0 && (
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
          <h2 className="text-lg font-bold text-gray-800 mb-4">未対応の種別内訳</h2>
          <div className="flex flex-wrap gap-4">
            {Object.entries(stats.inquiriesByType).map(([type, count]) => (
              <div key={type} className="bg-gray-50 rounded-xl px-4 py-2">
                <span className="text-gray-600">{TYPE_LABELS[type] || type}</span>
                <span className="ml-2 font-bold text-gray-800">{count}件</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Inquiries */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100">
        <div className="p-6 border-b border-gray-100 flex justify-between items-center">
          <h2 className="text-lg font-bold text-gray-800">最近の問い合わせ</h2>
          <Link href="/support/inquiries" className="text-teal-600 hover:text-teal-700 font-medium text-sm">
            すべて見る →
          </Link>
        </div>
        <div className="divide-y divide-gray-50">
          {(stats?.recentInquiries || []).map((inquiry) => (
            <Link
              key={inquiry.id}
              href={`/support/inquiries?id=${inquiry.id}`}
              className="flex items-center justify-between p-4 hover:bg-gray-50 transition-colors"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[inquiry.status]}`}>
                    {inquiry.status === 'pending' ? '未対応' : inquiry.status === 'in_progress' ? '対応中' : inquiry.status === 'resolved' ? '解決済' : '完了'}
                  </span>
                  <span className="text-xs text-gray-400">
                    {TYPE_LABELS[inquiry.inquiryType] || inquiry.inquiryType}
                  </span>
                </div>
                <p className="font-medium text-gray-800 mt-1 line-clamp-1">{inquiry.subject}</p>
                <p className="text-sm text-gray-500 mt-0.5">{inquiry.userName}</p>
              </div>
              <div className="text-xs text-gray-400">
                {new Date(inquiry.createdAt).toLocaleDateString('ja-JP')}
              </div>
            </Link>
          ))}
          {(stats?.recentInquiries || []).length === 0 && (
            <div className="p-8 text-center text-gray-400">
              問い合わせはありません
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

