"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import {
  DATASET_EMBEDDING_DIMENSIONS,
  DATASET_EMBEDDING_MODEL,
  DATASET_EMBEDDING_MODELS,
} from "@/shared/dataset-embedding.mjs";

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

const EMBEDDING_TABLES = [
  { name: "dataset_ingredients", label: "食材データセット", description: "食材名の埋め込みベクトル" },
  { name: "dataset_recipes", label: "レシピデータセット", description: "レシピ名の埋め込みベクトル" },
  { name: "dataset_menu_sets", label: "献立セットデータセット", description: "献立セット内容の埋め込みベクトル" },
];

const EMBEDDING_MODELS = DATASET_EMBEDDING_MODELS;
const DEFAULT_DIMENSIONS = DATASET_EMBEDDING_DIMENSIONS;

interface EmbeddingProgress {
  jobId?: string;
  status: "idle" | "running" | "completed" | "error";
  table?: string;
  model?: string;
  dimensions?: number;
  startTime?: number;
  currentOffset?: number;
  totalProcessed?: number;
  totalCount?: number;
  percentage?: number;
  elapsedMinutes?: string;
  error?: string;
  completedAt?: string;
  message?: string;
}

export default function SuperAdminDashboard() {
  const [dbStats, setDbStats] = useState<DbStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedModel, setSelectedModel] = useState(DATASET_EMBEDDING_MODEL);
  const [selectedDimensions, setSelectedDimensions] = useState(DEFAULT_DIMENSIONS);
  const [progress, setProgress] = useState<EmbeddingProgress>({ status: "idle" });
  const [progressInterval, setProgressInterval] = useState<NodeJS.Timeout | null>(null);

  // モデルが変更されたら、利用可能な次元を更新
  useEffect(() => {
    const model = EMBEDDING_MODELS.find(m => m.value === selectedModel);
    if (model && !model.dimensions.includes(selectedDimensions)) {
      setSelectedDimensions(model.dimensions[0]);
    }
  }, [selectedDimensions, selectedModel]);

  // 進捗を取得
  const fetchProgress = async () => {
    try {
      const res = await fetch("/api/super-admin/embeddings/progress");
      if (res.ok) {
        const data = await res.json();
        setProgress(data);
      }
    } catch (error) {
      console.error("Failed to fetch progress:", error);
    }
  };

  useEffect(() => {
    fetchStats();
    fetchProgress();
    
    // 進捗を5秒おきに更新
    const interval = setInterval(fetchProgress, 5000);
    setProgressInterval(interval);
    
    return () => {
      if (interval) clearInterval(interval);
    };
  }, []);

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

      {/* Embedding Regeneration */}
      <div className="bg-white/10 backdrop-blur rounded-2xl p-6">
        <h2 className="text-lg font-bold text-white mb-4">埋め込みベクトル再生成</h2>
        <p className="text-purple-300 text-sm mb-4">
          AI検索機能で使用する埋め込みベクトルを再生成します。エラーが発生しても自動的にリトライされます。
        </p>
        
        {/* モデルと次元の選択 */}
        <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-white text-sm font-medium mb-2">モデル</label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={progress.status === "running"}
              className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
            >
              {EMBEDDING_MODELS.map((model) => (
                <option key={model.value} value={model.value} className="bg-gray-800">
                  {model.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-white text-sm font-medium mb-2">次元数</label>
            <select
              value={selectedDimensions}
              onChange={(e) => setSelectedDimensions(Number(e.target.value))}
              disabled={progress.status === "running"}
              className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
            >
              {EMBEDDING_MODELS.find(m => m.value === selectedModel)?.dimensions.map((dim) => (
                <option key={dim} value={dim} className="bg-gray-800">
                  {dim}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 進捗表示 */}
        {progress.status === "running" && (
          <div className="mb-6 bg-white/5 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-white font-medium">処理中: {progress.table}</h3>
              <span className="text-purple-300 text-sm">
                {progress.model} ({progress.dimensions}次元)
              </span>
            </div>
            {progress.totalCount && progress.currentOffset !== undefined && (
              <>
                <div className="w-full bg-white/10 rounded-full h-3 mb-2">
                  <div
                    className="bg-gradient-to-r from-purple-600 to-indigo-600 h-3 rounded-full transition-all duration-300"
                    style={{ width: `${progress.percentage || 0}%` }}
                  />
                </div>
                <div className="flex justify-between text-sm text-purple-300">
                  <span>
                    {progress.currentOffset.toLocaleString()} / {progress.totalCount.toLocaleString()}件
                    ({progress.percentage?.toFixed(1)}%)
                  </span>
                  {progress.elapsedMinutes && (
                    <span>経過時間: {progress.elapsedMinutes}分</span>
                  )}
                </div>
                {progress.error && (
                  <p className="text-yellow-300 text-xs mt-2">⚠️ {progress.error}</p>
                )}
              </>
            )}
          </div>
        )}

        {progress.status === "completed" && (
          <div className="mb-6 bg-green-500/20 rounded-xl p-4">
            <p className="text-green-300 font-medium">✅ 処理が完了しました</p>
            {progress.totalProcessed && (
              <p className="text-green-200 text-sm mt-1">
                処理件数: {progress.totalProcessed.toLocaleString()}件
                {progress.elapsedMinutes && ` (所要時間: ${progress.elapsedMinutes}分)`}
              </p>
            )}
          </div>
        )}

        {progress.status === "error" && (
          <div className="mb-6 bg-red-500/20 rounded-xl p-4">
            <p className="text-red-300 font-medium">❌ エラーが発生しました</p>
            {progress.error && (
              <p className="text-red-200 text-xs mt-1">{progress.error}</p>
            )}
          </div>
        )}
        
        <div className="space-y-3">
          {EMBEDDING_TABLES.map((table) => (
            <div
              key={table.name}
              className="bg-white/5 rounded-xl p-4 flex items-center justify-between"
            >
              <div className="flex-1">
                <h3 className="text-white font-medium">{table.label}</h3>
                <p className="text-purple-300 text-sm">{table.description}</p>
              </div>
              <button
                onClick={async () => {
                  if (progress.status === "running") return;
                  
                  try {
                    const res = await fetch("/api/super-admin/embeddings/regenerate", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        table: table.name,
                        startOffset: 0,
                        model: selectedModel,
                        dimensions: selectedDimensions,
                      }),
                    });
                    
                    const data = await res.json();
                    
                    if (res.ok) {
                      // 進捗を即座に更新
                      setTimeout(fetchProgress, 1000);
                    } else {
                      alert(`エラー: ${data.error}`);
                    }
                  } catch (error: any) {
                    alert(`エラー: ${error.message}`);
                  }
                }}
                disabled={progress.status === "running"}
                className={`px-4 py-2 rounded-lg font-medium transition-all ${
                  progress.status === "running"
                    ? "bg-gray-600 text-gray-300 cursor-not-allowed"
                    : "bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:from-purple-700 hover:to-indigo-700"
                }`}
              >
                {progress.status === "running" && progress.table === table.name
                  ? "処理中..."
                  : "再生成開始"}
              </button>
            </div>
          ))}
        </div>
        
        <div className="mt-4 p-3 bg-yellow-500/20 rounded-lg">
          <p className="text-yellow-200 text-xs">
            ⚠️ 注意: 処理はバックグラウンドで実行されます。大量のデータがある場合、完了まで数時間かかる場合があります。
            エラーが発生しても5秒間隔で自動的にリトライされます。
          </p>
        </div>
      </div>
    </div>
  );
}
