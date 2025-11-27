"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Sparkles, AlertTriangle, TrendingUp, TrendingDown,
  Heart, Moon, Scale, Activity, CheckCircle2, X, ChevronRight,
  Lightbulb, Bell, BellOff
} from 'lucide-react';

const colors = {
  bg: '#FAF9F7',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textLight: '#4A4A4A',
  textMuted: '#9A9A9A',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  success: '#4CAF50',
  successLight: '#E8F5E9',
  warning: '#FF9800',
  warningLight: '#FFF3E0',
  error: '#F44336',
  errorLight: '#FFEBEE',
  purple: '#7C4DFF',
  purpleLight: '#EDE7F6',
  blue: '#2196F3',
  blueLight: '#E3F2FD',
  border: '#EEEEEE',
};

interface Insight {
  id: string;
  analysis_date: string;
  period_type: string;
  insight_type: string;
  title: string;
  summary: string;
  details?: Record<string, any>;
  recommendations?: string[];
  priority: string;
  is_alert: boolean;
  is_read: boolean;
  created_at: string;
}

const INSIGHT_ICONS: Record<string, typeof Scale> = {
  weight_trend: Scale,
  blood_pressure: Heart,
  sleep_analysis: Moon,
  activity_analysis: Activity,
  correlation_analysis: Sparkles,
  ai_comprehensive: Lightbulb,
};

const PRIORITY_COLORS: Record<string, { bg: string; text: string }> = {
  low: { bg: colors.blueLight, text: colors.blue },
  medium: { bg: colors.warningLight, text: colors.warning },
  high: { bg: colors.errorLight, text: colors.error },
  critical: { bg: colors.error, text: '#FFFFFF' },
};

export default function HealthInsightsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [alertCount, setAlertCount] = useState(0);
  const [filter, setFilter] = useState<'all' | 'unread' | 'alerts'>('all');
  const [selectedInsight, setSelectedInsight] = useState<Insight | null>(null);

  useEffect(() => {
    fetchInsights();
  }, [filter]);

  const fetchInsights = async () => {
    setLoading(true);
    try {
      let url = '/api/health/insights?limit=50';
      if (filter === 'unread') url += '&unread=true';
      if (filter === 'alerts') url += '&alerts=true';

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setInsights(data.insights || []);
        setUnreadCount(data.unreadCount || 0);
        setAlertCount(data.alertCount || 0);
      }
    } catch (error) {
      console.error('Failed to fetch insights:', error);
    }
    setLoading(false);
  };

  const markAsRead = async (id: string) => {
    try {
      await fetch(`/api/health/insights/${id}/read`, {
        method: 'POST',
      });
      setInsights(prev => prev.map(i => 
        i.id === id ? { ...i, is_read: true } : i
      ));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (error) {
      console.error('Failed to mark as read:', error);
    }
  };

  const handleSelectInsight = (insight: Insight) => {
    setSelectedInsight(insight);
    if (!insight.is_read) {
      markAsRead(insight.id);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' });
  };

  return (
    <div className="min-h-screen pb-24" style={{ backgroundColor: colors.bg }}>
      {/* ヘッダー */}
      <div className="sticky top-0 z-10 px-4 py-4" style={{ backgroundColor: colors.bg }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center">
            <button onClick={() => router.back()} className="p-2 -ml-2">
              <ArrowLeft size={24} style={{ color: colors.text }} />
            </button>
            <h1 className="font-bold ml-2" style={{ color: colors.text }}>AI分析</h1>
          </div>
          {unreadCount > 0 && (
            <span 
              className="px-2 py-1 rounded-full text-xs font-medium"
              style={{ backgroundColor: colors.accent, color: 'white' }}
            >
              {unreadCount}件の新着
            </span>
          )}
        </div>

        {/* フィルター */}
        <div className="flex gap-2">
          {[
            { key: 'all', label: 'すべて' },
            { key: 'unread', label: '未読' },
            { key: 'alerts', label: 'アラート', count: alertCount },
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key as any)}
              className="px-4 py-2 rounded-full text-sm font-medium flex items-center gap-1"
              style={{
                backgroundColor: filter === f.key ? colors.accent : colors.card,
                color: filter === f.key ? 'white' : colors.textLight,
              }}
            >
              {f.label}
              {f.count !== undefined && f.count > 0 && (
                <span 
                  className="px-1.5 py-0.5 rounded-full text-xs"
                  style={{ 
                    backgroundColor: filter === f.key ? 'rgba(255,255,255,0.3)' : colors.errorLight,
                    color: filter === f.key ? 'white' : colors.error,
                  }}
                >
                  {f.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full" />
        </div>
      ) : insights.length === 0 ? (
        <div className="px-4">
          <div 
            className="p-6 rounded-2xl text-center"
            style={{ backgroundColor: colors.card }}
          >
            <Sparkles size={48} className="mx-auto mb-3" style={{ color: colors.textMuted }} />
            <p className="font-medium mb-1" style={{ color: colors.text }}>
              分析結果がありません
            </p>
            <p className="text-sm" style={{ color: colors.textMuted }}>
              健康記録を続けると、AIが分析してアドバイスします
            </p>
          </div>
        </div>
      ) : (
        <div className="px-4 space-y-3">
          {insights.map((insight) => {
            const Icon = INSIGHT_ICONS[insight.insight_type] || Sparkles;
            const priorityStyle = PRIORITY_COLORS[insight.priority] || PRIORITY_COLORS.low;

            return (
              <motion.button
                key={insight.id}
                whileTap={{ scale: 0.98 }}
                onClick={() => handleSelectInsight(insight)}
                className="w-full p-4 rounded-xl text-left"
                style={{ 
                  backgroundColor: colors.card,
                  opacity: insight.is_read ? 0.8 : 1,
                }}
              >
                <div className="flex items-start gap-3">
                  <div 
                    className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: priorityStyle.bg }}
                  >
                    {insight.is_alert ? (
                      <AlertTriangle size={20} style={{ color: priorityStyle.text }} />
                    ) : (
                      <Icon size={20} style={{ color: priorityStyle.text }} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p 
                        className="font-semibold truncate"
                        style={{ color: colors.text }}
                      >
                        {insight.title}
                      </p>
                      {!insight.is_read && (
                        <span 
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: colors.accent }}
                        />
                      )}
                    </div>
                    <p 
                      className="text-sm line-clamp-2"
                      style={{ color: colors.textMuted }}
                    >
                      {insight.summary}
                    </p>
                    <p className="text-xs mt-2" style={{ color: colors.textMuted }}>
                      {formatDate(insight.analysis_date)}
                    </p>
                  </div>
                  <ChevronRight size={20} style={{ color: colors.textMuted }} className="flex-shrink-0" />
                </div>
              </motion.button>
            );
          })}
        </div>
      )}

      {/* 詳細モーダル */}
      <AnimatePresence>
        {selectedInsight && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-50 flex items-end"
            onClick={() => setSelectedInsight(null)}
          >
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25 }}
              className="w-full max-h-[80vh] overflow-y-auto rounded-t-3xl p-6 pb-10"
              style={{ backgroundColor: colors.card }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-12 h-1 bg-gray-300 rounded-full mx-auto mb-6" />
              
              <div className="flex items-start gap-3 mb-4">
                {selectedInsight.is_alert && (
                  <AlertTriangle size={24} style={{ color: colors.error }} />
                )}
                <div>
                  <h2 className="text-xl font-bold" style={{ color: colors.text }}>
                    {selectedInsight.title}
                  </h2>
                  <p className="text-sm" style={{ color: colors.textMuted }}>
                    {formatDate(selectedInsight.analysis_date)} の分析
                  </p>
                </div>
              </div>

              <p className="mb-6" style={{ color: colors.textLight }}>
                {selectedInsight.summary}
              </p>

              {selectedInsight.recommendations && selectedInsight.recommendations.length > 0 && (
                <div className="mb-6">
                  <h3 className="font-semibold mb-3" style={{ color: colors.text }}>
                    💡 おすすめアクション
                  </h3>
                  <div className="space-y-2">
                    {selectedInsight.recommendations.map((rec, i) => (
                      <div 
                        key={i}
                        className="p-3 rounded-lg flex items-start gap-2"
                        style={{ backgroundColor: colors.bg }}
                      >
                        <CheckCircle2 size={18} style={{ color: colors.success }} className="flex-shrink-0 mt-0.5" />
                        <p className="text-sm" style={{ color: colors.textLight }}>
                          {rec}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <motion.button
                whileTap={{ scale: 0.98 }}
                onClick={() => setSelectedInsight(null)}
                className="w-full py-3 rounded-xl font-medium"
                style={{ backgroundColor: colors.bg, color: colors.textLight }}
              >
                閉じる
              </motion.button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

