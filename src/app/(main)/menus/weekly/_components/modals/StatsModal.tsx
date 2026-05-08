"use client";

import React from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import { BarChart3, X, ChefHat, Flame, Sparkles, Heart, RefreshCw } from "lucide-react";

const NutritionRadarChart = dynamic(
  () => import("@/components/NutritionRadarChart").then(m => ({ default: m.NutritionRadarChart })),
  { ssr: false }
);

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#E5A84B',
  purple: '#7C6BA0',
  purpleLight: '#F5F3F8',
  blue: '#5B8BC7',
  blueLight: '#EEF4FB',
  danger: '#D64545',
  border: '#E8E8E8',
};

interface WeekDate {
  date: Date;
  dateStr: string;
  dayOfWeek: string;
}

interface Stats {
  cookRate: number;
  avgCal: number;
  cookCount: number;
  buyCount: number;
  outCount: number;
}

interface WeekNutrition {
  daysWithMeals: number;
  averages: {
    caloriesKcal: number;
    proteinG: number;
    fatG: number;
    carbsG: number;
    fiberG: number;
    sodiumG: number;
  };
}

interface Nutrition {
  [key: string]: number;
}

interface StatsModalProps {
  stats: Stats;
  weekDates: WeekDate[];
  weeklySummaryTab: 'today' | 'week';
  radarChartNutrients: string[];
  todayNutrition: Nutrition;
  todayMealCount: number;
  weekNutrition: WeekNutrition;
  isLoadingFeedback: boolean;
  isLoadingHint: boolean;
  praiseComment: string | null;
  nutritionFeedback: string | null;
  nutritionTip: string | null;
  aiHint: string | null;
  onClose: () => void;
  onChangeTab: (tab: 'today' | 'week') => void;
  onOpenNutritionDetail: () => void;
}

export function StatsModal({
  stats,
  weekDates,
  weeklySummaryTab,
  radarChartNutrients,
  todayNutrition,
  todayMealCount,
  weekNutrition,
  isLoadingFeedback,
  isLoadingHint,
  praiseComment,
  nutritionFeedback,
  nutritionTip,
  aiHint,
  onClose,
  onChangeTab,
  onOpenNutritionDetail,
}: StatsModalProps) {
  const today = new Date();
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];

  return (
    <motion.div
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
      style={{ background: colors.card, maxHeight: '85vh' }}
    >
      {/* ヘッダー */}
      <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex items-center gap-2">
          <BarChart3 size={18} color={colors.purple} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>栄養分析</span>
        </div>
        <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
          <X size={14} color={colors.textLight} />
        </button>
      </div>

      <div className="flex-1 overflow-auto pb-4 lg:pb-6">
        {/* 週間サマリーヘッダー */}
        <div className="px-4 pt-3 pb-2" style={{ background: `linear-gradient(135deg, ${colors.purpleLight} 0%, ${colors.accentLight} 100%)` }}>
          <div className="flex gap-2 mb-2">
            <div className="flex-1 rounded-xl p-2.5 text-center" style={{ background: 'rgba(255,255,255,0.8)' }}>
              <ChefHat size={18} color={colors.success} className="mx-auto mb-0.5" />
              <p style={{ fontSize: 20, fontWeight: 700, color: colors.success, margin: 0 }}>{stats.cookRate}%</p>
              <p style={{ fontSize: 9, color: colors.textLight, margin: 0 }}>自炊率</p>
            </div>
            <div className="flex-1 rounded-xl p-2.5 text-center" style={{ background: 'rgba(255,255,255,0.8)' }}>
              <Flame size={18} color={colors.accent} className="mx-auto mb-0.5" />
              <p style={{ fontSize: 20, fontWeight: 700, color: colors.accent, margin: 0 }}>{stats.avgCal}</p>
              <p style={{ fontSize: 9, color: colors.textLight, margin: 0 }}>平均kcal/日</p>
            </div>
            <div className="flex-1 rounded-xl p-2.5 text-center" style={{ background: 'rgba(255,255,255,0.8)' }}>
              <div className="flex justify-center gap-1 mb-0.5">
                <span style={{ fontSize: 9, color: colors.success }}>🍳{stats.cookCount}</span>
                <span style={{ fontSize: 9, color: colors.purple }}>🛒{stats.buyCount}</span>
                <span style={{ fontSize: 9, color: colors.warning }}>🍽{stats.outCount}</span>
              </div>
              <p style={{ fontSize: 14, fontWeight: 600, color: colors.text, margin: 0 }}>{stats.cookCount + stats.buyCount + stats.outCount}食</p>
              <p style={{ fontSize: 9, color: colors.textLight, margin: 0 }}>今週の献立</p>
            </div>
          </div>
        </div>

        {/* タブ */}
        <div className="flex px-4 py-2 gap-2" style={{ borderBottom: `1px solid ${colors.border}` }}>
          <button
            onClick={() => onChangeTab('today')}
            className="flex-1 py-2 rounded-lg text-sm font-medium transition-all"
            style={{
              background: weeklySummaryTab === 'today' ? colors.accent : 'transparent',
              color: weeklySummaryTab === 'today' ? '#fff' : colors.textLight,
            }}
          >
            📅 今日
          </button>
          <button
            onClick={() => onChangeTab('week')}
            className="flex-1 py-2 rounded-lg text-sm font-medium transition-all"
            style={{
              background: weeklySummaryTab === 'week' ? colors.accent : 'transparent',
              color: weeklySummaryTab === 'week' ? '#fff' : colors.textLight,
            }}
          >
            📊 今週
          </button>
        </div>

        {/* タブコンテンツ */}
        <div className="p-4">
          {weeklySummaryTab === 'today' ? (
            <>
              {/* 今日の日付 */}
              <div className="flex items-center justify-between mb-3">
                <p style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
                  {today.getMonth() + 1}月{today.getDate()}日（{dayNames[today.getDay()]}）の栄養
                </p>
                <span className="px-2 py-0.5 rounded-full text-[10px]" style={{ background: colors.accentLight, color: colors.accent }}>
                  {todayMealCount}食分
                </span>
              </div>

              {/* レーダーチャート */}
              <div className="flex justify-center mb-3">
                <NutritionRadarChart
                  nutrition={todayNutrition as any}
                  selectedNutrients={radarChartNutrients}
                  size={180}
                  showLabels={true}
                />
              </div>

              {/* AI栄養士コメント */}
              <div className="mb-3 space-y-2">
                {/* 褒めコメント */}
                <div className="p-3 rounded-xl" style={{ background: colors.successLight }}>
                  <div className="flex items-center gap-2 mb-1">
                    <Heart size={12} color={colors.success} fill={colors.success} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: colors.success }}>褒めポイント</span>
                  </div>
                  {isLoadingFeedback ? (
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: colors.success, borderTopColor: 'transparent' }} />
                      <span style={{ fontSize: 11, color: colors.textLight }}>あなたの献立を分析中...</span>
                    </div>
                  ) : praiseComment ? (
                    <p style={{ fontSize: 12, color: colors.text, lineHeight: 1.5 }}>{praiseComment}</p>
                  ) : (
                    <p style={{ fontSize: 11, color: colors.textMuted }}>分析データがありません</p>
                  )}
                </div>

                {/* アドバイス */}
                {(nutritionFeedback || isLoadingFeedback) && (
                  <div className="p-3 rounded-xl" style={{ background: colors.accentLight }}>
                    <div className="flex items-center gap-2 mb-1">
                      <Sparkles size={12} color={colors.accent} />
                      <span style={{ fontSize: 11, fontWeight: 600, color: colors.accent }}>改善アドバイス</span>
                    </div>
                    {isLoadingFeedback ? (
                      <span style={{ fontSize: 11, color: colors.textMuted }}>...</span>
                    ) : (
                      <p style={{ fontSize: 11, color: colors.text, lineHeight: 1.5 }}>{nutritionFeedback}</p>
                    )}
                  </div>
                )}

                {/* 栄養豆知識 */}
                {nutritionTip && (
                  <div className="p-2 rounded-lg flex items-start gap-2" style={{ background: colors.blueLight }}>
                    <span style={{ fontSize: 10 }}>💡</span>
                    <p style={{ fontSize: 10, color: colors.blue, lineHeight: 1.4 }}>{nutritionTip}</p>
                  </div>
                )}
              </div>

              {/* 献立改善ボタン */}
              {nutritionFeedback && (
                <button
                  onClick={onOpenNutritionDetail}
                  className="w-full p-2.5 rounded-lg font-medium flex items-center justify-center gap-2 transition-all hover:opacity-90"
                  style={{ background: colors.accent, color: '#fff', fontSize: 12 }}
                >
                  <RefreshCw size={14} />
                  詳細を見る / 献立を改善
                </button>
              )}
            </>
          ) : (
            <>
              {/* 週の期間 */}
              <div className="flex items-center justify-between mb-3">
                <p style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
                  {weekDates[0]?.date.getMonth() + 1}/{weekDates[0]?.date.getDate()} 〜 {weekDates[6]?.date.getMonth() + 1}/{weekDates[6]?.date.getDate()} の平均栄養
                </p>
                <span className="px-2 py-0.5 rounded-full text-[10px]" style={{ background: colors.purpleLight, color: colors.purple }}>
                  {weekNutrition.daysWithMeals}日分
                </span>
              </div>

              {/* 週間レーダーチャート */}
              <div className="flex justify-center mb-3">
                <NutritionRadarChart
                  nutrition={weekNutrition.averages as any}
                  selectedNutrients={radarChartNutrients}
                  size={180}
                  showLabels={true}
                />
              </div>

              {/* 週間AI栄養士コメント */}
              <div className="mb-3 p-3 rounded-xl" style={{ background: colors.purpleLight }}>
                <div className="flex items-center gap-2 mb-1">
                  <Sparkles size={12} color={colors.purple} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: colors.purple }}>週間AIヒント</span>
                </div>
                {isLoadingHint ? (
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                    <span style={{ fontSize: 11, color: colors.textMuted }}>ヒントを生成中...</span>
                  </div>
                ) : (
                  <p style={{ fontSize: 11, color: colors.text, lineHeight: 1.5 }}>
                    {aiHint || `今週の自炊率は${stats.cookRate}%です。週末にまとめて作り置きすると、平日の自炊率が上がりますよ！`}
                  </p>
                )}
              </div>

              {/* 主要栄養素の週間平均 */}
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'カロリー', value: `${Math.round(weekNutrition.averages.caloriesKcal)}`, unit: 'kcal', color: colors.accent },
                  { label: 'タンパク質', value: `${Math.round(weekNutrition.averages.proteinG)}`, unit: 'g', color: colors.success },
                  { label: '脂質', value: `${Math.round(weekNutrition.averages.fatG)}`, unit: 'g', color: colors.warning },
                  { label: '炭水化物', value: `${Math.round(weekNutrition.averages.carbsG)}`, unit: 'g', color: colors.blue },
                  { label: '食物繊維', value: `${Math.round(weekNutrition.averages.fiberG * 10) / 10}`, unit: 'g', color: colors.purple },
                  { label: '塩分', value: `${Math.round(weekNutrition.averages.sodiumG * 10) / 10}`, unit: 'g', color: colors.danger },
                ].map(item => (
                  <div key={item.label} className="p-2 rounded-lg text-center" style={{ background: colors.bg }}>
                    <p style={{ fontSize: 16, fontWeight: 600, color: item.color, margin: 0 }}>{item.value}</p>
                    <p style={{ fontSize: 9, color: colors.textLight, margin: 0 }}>{item.label}({item.unit}/日)</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}
