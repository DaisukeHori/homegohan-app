"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChefHat, FileText, Bot, RefreshCw } from 'lucide-react';

interface MealFlag {
  id: string;
  type: 'meal';
  targetId: string;
  userId: string;
  flagType: string;
  reason: string;
  status: string;
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

interface RecipeFlag {
  id: string;
  type: 'recipe';
  targetId: string;
  reporterId: string;
  flagType: string;
  reason: string;
  status: string;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

interface AiFlag {
  id: string;
  type: 'ai_content';
  userId: string;
  contentType: string;
  outputContent: string;
  flagReason: string;
  createdAt: string;
}

interface ModerationData {
  mealFlags: MealFlag[];
  recipeFlags: RecipeFlag[];
  aiFlags: AiFlag[];
  counts: {
    meal: number;
    recipe: number;
    ai: number;
  };
}

type TabType = 'meal' | 'recipe' | 'ai';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  resolved: 'bg-green-100 text-green-800',
  dismissed: 'bg-gray-100 text-gray-600',
};

export default function ModerationPage() {
  const [data, setData] = useState<ModerationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('meal');
  const [status, setStatus] = useState<string>('pending');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/moderation?status=${status}`);
      if (res.ok) {
        const json = await res.json();
        setData(json);
      } else {
        console.error('Failed to fetch moderation data:', res.statusText);
      }
    } catch (err) {
      console.error('Error fetching moderation data:', err);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const tabs = [
    { key: 'meal' as TabType, label: '食事フラグ', icon: ChefHat, count: data?.counts.meal ?? 0 },
    { key: 'recipe' as TabType, label: 'レシピフラグ', icon: FileText, count: data?.counts.recipe ?? 0 },
    { key: 'ai' as TabType, label: 'AIコンテンツ', icon: Bot, count: data?.counts.ai ?? 0 },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <AlertTriangle size={20} className="text-orange-500" />
          <h1 className="text-2xl font-bold text-gray-900">モデレーション</h1>
        </div>
        <div className="flex items-center gap-3">
          {/* Status filter */}
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
          >
            <option value="pending">未処理</option>
            <option value="resolved">解決済み</option>
            <option value="dismissed">却下済み</option>
          </select>
          <button
            onClick={fetchData}
            className="flex items-center gap-1 px-4 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 text-sm font-medium transition-colors"
          >
            <RefreshCw size={14} />
            更新
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-[#E07A5F] text-[#E07A5F]'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <Icon size={16} />
              {tab.label}
              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                activeTab === tab.key ? 'bg-[#E07A5F] text-white' : 'bg-gray-100 text-gray-600'
              }`}>
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">読み込み中...</div>
      ) : !data ? (
        <div className="text-center py-12 text-gray-400">データを取得できませんでした</div>
      ) : (
        <>
          {/* Meal Flags Tab */}
          {activeTab === 'meal' && (
            <div className="space-y-4">
              {data.mealFlags.length === 0 ? (
                <div className="text-center py-12 text-gray-400">食事フラグがありません</div>
              ) : (
                data.mealFlags.map((flag) => (
                  <div key={flag.id} className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm">
                    <div className="flex justify-between items-start">
                      <div className="space-y-1 flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs text-gray-400">meal:{flag.targetId?.slice(0, 8)}...</span>
                          <span className="px-2 py-0.5 bg-orange-100 text-orange-700 rounded text-xs font-bold">
                            {flag.flagType}
                          </span>
                          <span className={`px-2 py-0.5 rounded text-xs font-bold ${STATUS_COLORS[flag.status] ?? 'bg-gray-100 text-gray-600'}`}>
                            {flag.status}
                          </span>
                        </div>
                        <p className="text-sm text-gray-700">{flag.reason || '理由なし'}</p>
                        <p className="text-xs text-gray-400">
                          報告者: {flag.userId?.slice(0, 8)}... | {new Date(flag.createdAt).toLocaleString('ja-JP')}
                        </p>
                        {flag.resolutionNote && (
                          <p className="text-xs text-green-600 bg-green-50 px-2 py-1 rounded">
                            解決メモ: {flag.resolutionNote}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Recipe Flags Tab */}
          {activeTab === 'recipe' && (
            <div className="space-y-4">
              {data.recipeFlags.length === 0 ? (
                <div className="text-center py-12 text-gray-400">レシピフラグがありません</div>
              ) : (
                data.recipeFlags.map((flag) => (
                  <div key={flag.id} className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm">
                    <div className="flex justify-between items-start">
                      <div className="space-y-1 flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs text-gray-400">recipe:{flag.targetId?.slice(0, 8)}...</span>
                          <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded text-xs font-bold">
                            {flag.flagType}
                          </span>
                          <span className={`px-2 py-0.5 rounded text-xs font-bold ${STATUS_COLORS[flag.status] ?? 'bg-gray-100 text-gray-600'}`}>
                            {flag.status}
                          </span>
                        </div>
                        <p className="text-sm text-gray-700">{flag.reason || '理由なし'}</p>
                        <p className="text-xs text-gray-400">
                          報告者: {flag.reporterId?.slice(0, 8)}... | {new Date(flag.createdAt).toLocaleString('ja-JP')}
                        </p>
                        {flag.reviewedAt && (
                          <p className="text-xs text-blue-600">
                            レビュー済み: {new Date(flag.reviewedAt).toLocaleString('ja-JP')}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* AI Content Tab */}
          {activeTab === 'ai' && (
            <div className="space-y-4">
              {data.aiFlags.length === 0 ? (
                <div className="text-center py-12 text-gray-400">AIコンテンツフラグがありません</div>
              ) : (
                data.aiFlags.map((flag) => (
                  <div key={flag.id} className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs font-bold">
                          {flag.contentType}
                        </span>
                        <span className="font-mono text-xs text-gray-400">
                          user:{flag.userId?.slice(0, 8)}...
                        </span>
                        <span className="text-xs text-gray-400">
                          {new Date(flag.createdAt).toLocaleString('ja-JP')}
                        </span>
                      </div>
                      {flag.flagReason && (
                        <p className="text-sm font-medium text-red-600">
                          フラグ理由: {flag.flagReason}
                        </p>
                      )}
                      {flag.outputContent && (
                        <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-700 font-mono whitespace-pre-wrap text-xs">
                          {flag.outputContent}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
