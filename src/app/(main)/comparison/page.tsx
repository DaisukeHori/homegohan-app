"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import type { ComparisonResponse, MetricRankingSummary, ComparisonHighlight } from "@/types/comparison";

// メトリクスアイコンマッピング
const METRIC_ICONS: Record<string, string> = {
  'record_streak': '🔥',
  'weekly_record_rate': '📅',
  'monthly_record_rate': '📆',
  'breakfast_rate': '🌅',
  'breakfast_streak': '☀️',
  'nutrition_score': '⚖️',
  'veg_score_avg': '🥦',
  'protein_score': '💪',
  'menu_execution_rate': '📋',
  'weekly_menu_count': '📝',
  'total_meals': '🍽️',
};

// メトリクスカテゴリカラー
const CATEGORY_COLORS: Record<string, string> = {
  'continuity': 'from-orange-400 to-red-500',
  'breakfast': 'from-yellow-400 to-orange-500',
  'nutrition': 'from-green-400 to-emerald-500',
  'menu': 'from-blue-400 to-indigo-500',
  'total': 'from-purple-400 to-pink-500',
};

export default function ComparisonPage() {
  const [data, setData] = useState<ComparisonResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [periodType, setPeriodType] = useState<'weekly' | 'monthly'>('weekly');
  const [selectedMetric, setSelectedMetric] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/comparison/rankings?periodType=${periodType}`);
        if (!res.ok) throw new Error('Failed');
        const result = await res.json();
        setData(result);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [periodType]);

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* ヘッダー */}
      <div className="bg-white p-6 pb-8 rounded-b-[40px] shadow-sm mb-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">みんなと比較</h1>
        <p className="text-gray-500 text-sm">
          同じ属性の人たちと比べてみましょう
        </p>
        
        {/* 期間切り替えとバッジリンク */}
        <div className="mt-6 flex items-center justify-between">
          <div className="flex gap-2">
            {(['weekly', 'monthly'] as const).map((period) => (
              <button
                key={period}
                onClick={() => setPeriodType(period)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                  periodType === period
                    ? 'bg-accent text-white shadow-md'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {period === 'weekly' ? '週間' : '月間'}
              </button>
            ))}
          </div>
          <Link
            href="/badges"
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-yellow-400 to-orange-400 text-white rounded-full text-sm font-medium shadow-md hover:shadow-lg transition-shadow"
          >
            <span>🏆</span>
            <span>バッジ一覧</span>
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-12">
          <div className="animate-spin w-8 h-8 border-4 border-accent border-t-transparent rounded-full mx-auto mb-4" />
          読み込み中...
        </div>
      ) : data ? (
        <>
          {/* ハイライトセクション */}
          {data.highlights.length > 0 && (
            <div className="px-4 mb-6">
              <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3 px-2">
                🎉 ハイライト
              </h2>
              <div className="space-y-2">
                {data.highlights.map((highlight, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.1 }}
                    className="bg-gradient-to-r from-orange-50 to-yellow-50 border border-orange-100 rounded-2xl p-4 shadow-sm"
                  >
                    <p className="text-gray-900 font-medium">{highlight.message}</p>
                  </motion.div>
                ))}
              </div>
            </div>
          )}

          {/* ランキングなしの場合 */}
          {data.rankings.length === 0 && (
            <div className="px-4">
              <div className="bg-white rounded-3xl p-8 text-center shadow-sm">
                <div className="text-6xl mb-4">📊</div>
                <h3 className="text-lg font-bold text-gray-900 mb-2">まだデータがありません</h3>
                <p className="text-gray-500 text-sm">
                  食事を記録すると、同じ属性の人たちとの比較ができるようになります。
                </p>
              </div>
            </div>
          )}

          {/* メトリクス別ランキング */}
          {data.rankings.length > 0 && (
            <div className="px-4">
              <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3 px-2">
                📈 あなたのランキング
              </h2>
              <div className="space-y-4">
                {data.rankings.map((metricRanking, i) => (
                  <MetricRankingCard
                    key={metricRanking.metric.code}
                    metricRanking={metricRanking}
                    index={i}
                    isExpanded={selectedMetric === metricRanking.metric.code}
                    onToggle={() => setSelectedMetric(
                      selectedMetric === metricRanking.metric.code ? null : metricRanking.metric.code
                    )}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="px-4">
          <div className="bg-white rounded-3xl p-8 text-center shadow-sm">
            <div className="text-6xl mb-4">❌</div>
            <h3 className="text-lg font-bold text-gray-900 mb-2">データの取得に失敗しました</h3>
            <p className="text-gray-500 text-sm">
              しばらくしてからもう一度お試しください。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// メトリクスランキングカード
function MetricRankingCard({
  metricRanking,
  index,
  isExpanded,
  onToggle,
}: {
  metricRanking: MetricRankingSummary;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { metric, segments } = metricRanking;
  const icon = METRIC_ICONS[metric.code] || '📊';
  const gradientClass = CATEGORY_COLORS[metric.category] || 'from-gray-400 to-gray-500';
  
  // 最も良いランキングを取得
  const bestSegment = segments.reduce((best, current) => 
    current.percentile > (best?.percentile ?? 0) ? current : best
  , segments[0]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      className="bg-white rounded-3xl shadow-sm overflow-hidden"
    >
      {/* ヘッダー（クリック可能） */}
      <button
        onClick={onToggle}
        className="w-full p-4 flex items-center gap-4 text-left hover:bg-gray-50 transition-colors"
      >
        {/* アイコン */}
        <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${gradientClass} flex items-center justify-center text-2xl shadow-md`}>
          {icon}
        </div>
        
        {/* メトリクス情報 */}
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-gray-900 truncate">{metric.name}</h3>
          <p className="text-sm text-gray-500">
            {bestSegment ? `${bestSegment.segment.name}で${bestSegment.rank}位` : '---'}
          </p>
        </div>
        
        {/* 値とプライズ */}
        <div className="text-right">
          {bestSegment?.prize && (
            <span className="text-2xl">{bestSegment.prize.icon}</span>
          )}
          <p className="text-lg font-bold text-gray-900">
            {bestSegment?.value ?? '---'}
            <span className="text-sm text-gray-400 ml-1">{metric.unit}</span>
          </p>
        </div>
        
        {/* 展開アイコン */}
        <motion.div
          animate={{ rotate: isExpanded ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="text-gray-400"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </motion.div>
      </button>

      {/* 詳細（展開時） */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-3">
              {segments.map((seg, i) => (
                <SegmentRankingRow key={seg.segment.code} segment={seg} metric={metric} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// セグメント別ランキング行
function SegmentRankingRow({
  segment,
  metric,
}: {
  segment: MetricRankingSummary['segments'][0];
  metric: MetricRankingSummary['metric'];
}) {
  const percentileColor = 
    segment.percentile >= 90 ? 'bg-yellow-400' :
    segment.percentile >= 75 ? 'bg-green-400' :
    segment.percentile >= 50 ? 'bg-blue-400' :
    'bg-gray-300';

  return (
    <div className="bg-gray-50 rounded-2xl p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-700">{segment.segment.name}</span>
        <div className="flex items-center gap-2">
          {segment.prize && (
            <span className="text-lg">{segment.prize.icon}</span>
          )}
          <span className="text-sm font-bold text-gray-900">
            {segment.rank}位 / {segment.totalUsers}人
          </span>
        </div>
      </div>
      
      {/* プログレスバー */}
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden mb-2">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${segment.percentile}%` }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className={`h-full ${percentileColor} rounded-full`}
        />
      </div>
      
      <div className="flex justify-between text-xs text-gray-500">
        <span>上位 {Math.round(100 - segment.percentile)}%</span>
        {segment.avgValue !== null && (
          <span>
            平均: {segment.avgValue}{metric.unit}
            {segment.vsAvgRate !== null && (
              <span className={segment.vsAvgRate >= 0 ? 'text-green-600 ml-1' : 'text-red-600 ml-1'}>
                ({segment.vsAvgRate >= 0 ? '+' : ''}{Math.round(segment.vsAvgRate)}%)
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

