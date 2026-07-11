"use client";

import React, { useId } from "react";
import dynamic from "next/dynamic";
import { BarChart3, X, Heart, Sparkles, RefreshCw } from "lucide-react";
import { NUTRIENT_BY_CATEGORY, CATEGORY_LABELS, calculateDriPercentage, getNutrientDefinition, formatDateJa } from "@homegohan/shared";
import { BottomSheet } from "@/components/common/BottomSheet";

const NutritionRadarChart = dynamic(
  () => import("@/components/NutritionRadarChart").then(m => ({ default: m.NutritionRadarChart })),
  { ssr: false }
);

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#767676', // #1052 (コントラスト): #A0A0A0 (白地で約2.7:1) から WCAG AA相当の #767676 (約4.5:1) へ
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#E5A84B',
  blue: '#5B8BC7',
  blueLight: '#EEF4FB',
  border: '#E8E8E8',
};

interface WeekDate {
  date: Date;
  dateStr: string;
  dayOfWeek: string;
}

interface Nutrition {
  [key: string]: number;
}

interface NutritionDetailModalProps {
  showNutritionDetailModal: boolean;
  selectedDayIndex: number;
  weekDates: WeekDate[];
  dayNutrition: Nutrition;
  mealCount: number;
  radarChartNutrients: string[];
  isEditingRadarNutrients: boolean;
  tempRadarNutrients: string[];
  isSavingRadarNutrients: boolean;
  isLoadingFeedback: boolean;
  praiseComment: string | null;
  nutritionFeedback: string | null;
  nutritionTip: string | null;
  onClose: () => void;
  onOpenImprove: () => void;
  onRefetchFeedback: (dateStr: string) => void;
  onStartEditRadar: () => void;
  onCancelEditRadar: () => void;
  onToggleRadarNutrient: (key: string) => void;
  onSaveRadarNutrients: () => void;
}

export function NutritionDetailModal({
  showNutritionDetailModal,
  selectedDayIndex,
  weekDates,
  dayNutrition,
  mealCount,
  radarChartNutrients,
  isEditingRadarNutrients,
  tempRadarNutrients,
  isSavingRadarNutrients,
  isLoadingFeedback,
  praiseComment,
  nutritionFeedback,
  nutritionTip,
  onClose,
  onOpenImprove,
  onRefetchFeedback,
  onStartEditRadar,
  onCancelEditRadar,
  onToggleRadarNutrient,
  onSaveRadarNutrients,
}: NutritionDetailModalProps) {
  const selectedDay = weekDates[selectedDayIndex];

  // #1052 (体系的 a11y): 独自の backdrop/panel を持つ「自己完結型」モーダルだったため、
  // 共通 BottomSheet（role="dialog"/aria-modal/フォーカストラップ/Escape/背景スクロールロック）
  // への載せ替えが最も安全（他モーダルのような shared backdrop への相乗りが無い）。
  const titleId = useId();

  return (
    <BottomSheet
      isOpen={showNutritionDetailModal}
      onClose={onClose}
      ariaLabelledBy={titleId}
      overlayClassName="z-50"
      panelClassName="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-hidden shadow-xl"
      testId="nutrition-detail-modal"
    >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: colors.border }}>
              <div className="flex items-center gap-2">
                <BarChart3 size={20} style={{ color: colors.accent }} />
                <h2 id={titleId} className="text-lg font-bold" style={{ color: colors.text }}>
                  {selectedDay?.dateStr && formatDateJa(selectedDay.dateStr)} の栄養分析
                </h2>
              </div>
              <button
                onClick={onClose}
                aria-label="閉じる"
                className="p-3 rounded-full hover:bg-gray-100 transition-colors"
              >
                <X size={20} style={{ color: colors.textLight }} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 140px)' }}>
              {/* レーダーチャート */}
              <div className="flex justify-center mb-4">
                <NutritionRadarChart
                  nutrition={dayNutrition}
                  selectedNutrients={radarChartNutrients}
                  size={220}
                  showLabels={true}
                />
              </div>

              {/* AI栄養士のコメント */}
              <div className="mb-4 space-y-3">
                {/* 褒めコメント */}
                <div className="p-3 rounded-xl" style={{ background: colors.successLight }}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Heart size={14} color={colors.success} fill={colors.success} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: colors.success }}>褒めポイント</span>
                    </div>
                    {(praiseComment || nutritionFeedback) && !isLoadingFeedback && (
                      <button
                        onClick={() => {
                          const currentDateStr = weekDates[selectedDayIndex]?.dateStr;
                          if (currentDateStr) {
                            onRefetchFeedback(currentDateStr);
                          }
                        }}
                        className="text-[10px] px-2 py-0.5 rounded"
                        style={{ background: colors.bg, color: colors.textMuted }}
                      >
                        再分析
                      </button>
                    )}
                  </div>
                  {isLoadingFeedback ? (
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: colors.success, borderTopColor: 'transparent' }} />
                      <span style={{ fontSize: 11, color: colors.textLight }}>あなたの献立を分析中...</span>
                    </div>
                  ) : praiseComment ? (
                    <p style={{ fontSize: 13, color: colors.text, lineHeight: 1.6 }}>{praiseComment}</p>
                  ) : (
                    <p style={{ fontSize: 11, color: colors.textMuted }}>分析データがありません</p>
                  )}
                </div>

                {/* 改善アドバイス */}
                {(nutritionFeedback || isLoadingFeedback) && (
                  <div className="p-3 rounded-xl" style={{ background: colors.accentLight }}>
                    <div className="flex items-center gap-2 mb-2">
                      <Sparkles size={14} color={colors.accent} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: colors.accent }}>改善アドバイス</span>
                    </div>
                    {isLoadingFeedback ? (
                      <span style={{ fontSize: 11, color: colors.textMuted }}>...</span>
                    ) : (
                      <p style={{ fontSize: 12, color: colors.text, lineHeight: 1.6 }}>{nutritionFeedback}</p>
                    )}
                  </div>
                )}

                {/* 栄養豆知識 */}
                {nutritionTip && (
                  <div className="p-3 rounded-lg flex items-start gap-2" style={{ background: colors.blueLight }}>
                    <span style={{ fontSize: 12 }}>💡</span>
                    <p style={{ fontSize: 11, color: colors.blue, lineHeight: 1.5 }}>{nutritionTip}</p>
                  </div>
                )}
              </div>

              {/* 献立改善ボタン */}
              {/* UX2-03: 従来は `nutritionFeedback && !isLoadingFeedback` の否定 = 「フィードバックが
                  無ければ常にスピナー」という判定だったため、isLoadingFeedback が false になっても
                  nutritionFeedback が空（想定外レスポンス等）だと「分析を準備中...」が実質的に
                  永久に表示され続けた。isLoadingFeedback を最優先で判定し、ローディング終了後は
                  取得成功/失敗を明確に分岐させ、失敗時は再試行ボタンを表示する。 */}
              {isLoadingFeedback ? (
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: colors.accent, borderTopColor: 'transparent' }} />
                  <span style={{ fontSize: 11, color: colors.textLight }}>分析を準備中...</span>
                </div>
              ) : nutritionFeedback ? (
                <div className="mb-4">
                  <button
                    onClick={onOpenImprove}
                    className="w-full p-2.5 rounded-lg font-medium flex items-center justify-center gap-2 transition-all hover:opacity-90"
                    style={{ background: colors.accent, color: '#fff', fontSize: 12 }}
                  >
                    <RefreshCw size={14} />
                    この提案で献立を改善
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2 mb-4 p-2.5 rounded-lg" style={{ background: colors.bg }}>
                  <span style={{ fontSize: 11, color: colors.textMuted }}>栄養分析を取得できませんでした</span>
                  <button
                    data-testid="nutrition-feedback-retry"
                    onClick={() => {
                      const currentDateStr = weekDates[selectedDayIndex]?.dateStr;
                      if (currentDateStr) {
                        onRefetchFeedback(currentDateStr);
                      }
                    }}
                    className="text-[11px] px-2.5 py-1.5 rounded-lg flex items-center gap-1 flex-shrink-0"
                    style={{ background: colors.accent, color: '#fff' }}
                  >
                    <RefreshCw size={11} />
                    再試行
                  </button>
                </div>
              )}

              {/* 全栄養素一覧 */}
              <div className="mb-4">
                <p style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
                  📊 全栄養素（{mealCount}食分）
                </p>
                {Object.entries(NUTRIENT_BY_CATEGORY).map(([category, nutrients]) => (
                  <div key={category} className="mb-3">
                    <p className="text-[10px] font-bold mb-1.5" style={{ color: colors.textMuted }}>
                      {CATEGORY_LABELS[category]}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {nutrients.map(def => {
                        const value = (dayNutrition as Record<string, number>)[def.key] ?? 0;
                        const percentage = calculateDriPercentage(def.key, value);
                        const isGood = percentage >= 80 && percentage <= 120;
                        const isLow = percentage < 50;
                        const isHigh = percentage > 150;
                        return (
                          <div key={def.key} className="flex items-center gap-2 p-1.5 rounded" style={{ background: colors.bg }}>
                            <div className="flex-1 min-w-0">
                              <div className="flex justify-between items-center">
                                <span className="text-[10px] truncate" style={{ color: colors.textLight }}>
                                  {def.label}
                                </span>
                                <span className="text-[9px]" style={{ color: colors.textMuted }}>
                                  {value.toFixed(def.decimals)}{def.unit}
                                </span>
                              </div>
                              <div className="flex items-center gap-1 mt-0.5">
                                <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: colors.border }}>
                                  <div
                                    className="h-full rounded-full"
                                    style={{
                                      width: `${Math.min(percentage, 100)}%`,
                                      background: isGood ? colors.success : isLow ? colors.warning : isHigh ? colors.accent : colors.textMuted,
                                    }}
                                  />
                                </div>
                                <span
                                  className="text-[8px] w-7 text-right font-medium"
                                  style={{ color: isGood ? colors.success : isLow ? colors.warning : isHigh ? colors.accent : colors.textMuted }}
                                >
                                  {percentage}%
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* レーダーチャート表示栄養素の変更 */}
              <div className="pt-3" style={{ borderTop: `1px solid ${colors.border}` }}>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[11px]" style={{ color: colors.textMuted }}>
                    レーダーチャートに表示する栄養素（{isEditingRadarNutrients ? tempRadarNutrients.length : radarChartNutrients.length}角形）
                  </p>
                  {!isEditingRadarNutrients && (
                    <button
                      onClick={onStartEditRadar}
                      className="text-[10px] px-2 py-1 rounded"
                      style={{ background: colors.bg, color: colors.accent }}
                    >
                      変更
                    </button>
                  )}
                </div>

                {isEditingRadarNutrients ? (
                  <div>
                    <p className="text-[9px] mb-2" style={{ color: colors.textMuted }}>
                      3〜8個を選択してください（選択順で表示）
                    </p>
                    {Object.entries(NUTRIENT_BY_CATEGORY).map(([category, nutrients]) => (
                      <div key={category} className="mb-2">
                        <p className="text-[9px] font-bold mb-1" style={{ color: colors.textMuted }}>
                          {CATEGORY_LABELS[category]}
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {nutrients.map(def => {
                            const isSelected = tempRadarNutrients.includes(def.key);
                            const index = tempRadarNutrients.indexOf(def.key);
                            return (
                              <button
                                key={def.key}
                                onClick={() => onToggleRadarNutrient(def.key)}
                                className="px-2 py-0.5 rounded-full text-[9px] transition-all flex items-center gap-1"
                                style={{
                                  background: isSelected ? colors.accent : colors.bg,
                                  color: isSelected ? '#fff' : colors.textLight,
                                  opacity: !isSelected && tempRadarNutrients.length >= 8 ? 0.5 : 1,
                                }}
                              >
                                {isSelected && <span className="text-[8px]">{index + 1}</span>}
                                {def.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    <div className="flex gap-2 mt-3">
                      <button
                        onClick={onCancelEditRadar}
                        className="flex-1 py-2 rounded-lg text-xs"
                        style={{ background: colors.bg, color: colors.textLight }}
                      >
                        キャンセル
                      </button>
                      <button
                        onClick={onSaveRadarNutrients}
                        disabled={tempRadarNutrients.length < 3 || isSavingRadarNutrients}
                        className="flex-1 py-2 rounded-lg text-xs text-white disabled:opacity-50"
                        style={{ background: colors.accent }}
                      >
                        {isSavingRadarNutrients ? '保存中...' : `保存（${tempRadarNutrients.length}角形）`}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {radarChartNutrients.map((key, idx) => {
                      const def = getNutrientDefinition(key);
                      return (
                        <span
                          key={key}
                          className="px-2 py-0.5 rounded-full text-[10px] flex items-center gap-1"
                          style={{ background: colors.accentLight, color: colors.accent }}
                        >
                          <span className="text-[8px] opacity-70">{idx + 1}</span>
                          {def?.label}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
    </BottomSheet>
  );
}
