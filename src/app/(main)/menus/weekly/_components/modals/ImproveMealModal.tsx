"use client";

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { RefreshCw, X, Sparkles, Check } from "lucide-react";
import type { PlannedMeal, DishDetail } from "@/types/domain";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  border: '#E8E8E8',
};

type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'midnight_snack';

interface MealPlanDay {
  id: string;
  dayDate: string;
  meals?: PlannedMeal[];
}

interface WeekDate {
  date: Date;
  dateStr: string;
  dayOfWeek: string;
}

interface ImproveMealModalProps {
  showImproveMealModal: boolean;
  isImprovingMeal: boolean;
  selectedDayIndex: number;
  weekDates: WeekDate[];
  improveMealTargets: MealType[];
  improveNextDay: boolean;
  nutritionFeedback: string | null;
  currentPlanDays: MealPlanDay[];
  onClose: () => void;
  onToggleMealTarget: (type: MealType) => void;
  onSelectAllDay: () => void;
  onSelectNextDay: () => void;
  onImprove: () => void;
}

export function ImproveMealModal({
  showImproveMealModal,
  isImprovingMeal,
  selectedDayIndex,
  weekDates,
  improveMealTargets,
  improveNextDay,
  nutritionFeedback,
  currentPlanDays,
  onClose,
  onToggleMealTarget,
  onSelectAllDay,
  onSelectNextDay,
  onImprove,
}: ImproveMealModalProps) {
  return (
    <AnimatePresence>
      {showImproveMealModal && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => !isImprovingMeal && onClose()}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="bg-white rounded-2xl w-full max-w-md shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: colors.border }}>
              <div className="flex items-center gap-2">
                <RefreshCw size={20} style={{ color: colors.accent }} />
                <h2 className="text-lg font-bold" style={{ color: colors.text }}>
                  献立を改善
                </h2>
              </div>
              {!isImprovingMeal && (
                <button
                  onClick={onClose}
                  className="p-2 rounded-full hover:bg-gray-100 transition-colors"
                >
                  <X size={20} style={{ color: colors.textLight }} />
                </button>
              )}
            </div>

            {/* Content */}
            <div className="p-4">
              {isImprovingMeal ? (
                <div className="py-8 text-center">
                  <div className="w-12 h-12 border-3 border-t-transparent rounded-full animate-spin mx-auto mb-4" style={{ borderColor: colors.accent, borderTopColor: 'transparent' }} />
                  <p style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>AI栄養士の提案で献立を改善中...</p>
                  <p style={{ fontSize: 12, color: colors.textLight, marginTop: 8 }}>しばらくお待ちください</p>
                </div>
              ) : (
                <>
                  {/* 対象日表示 */}
                  <div className="mb-4 p-3 rounded-lg" style={{ background: colors.bg }}>
                    <p style={{ fontSize: 12, color: colors.textLight }}>対象日</p>
                    <p style={{ fontSize: 16, fontWeight: 600, color: colors.text }}>
                      {weekDates[selectedDayIndex]?.date.getMonth() + 1}月{weekDates[selectedDayIndex]?.date.getDate()}日（{weekDates[selectedDayIndex]?.dayOfWeek}）
                      {weekDates[selectedDayIndex]?.dateStr === new Date().toISOString().split('T')[0] && (
                        <span className="ml-2 text-xs px-2 py-0.5 rounded-full" style={{ background: colors.accentLight, color: colors.accent }}>今日</span>
                      )}
                    </p>
                  </div>

                  {/* AI栄養士のコメント抜粋 */}
                  {nutritionFeedback && (
                    <div className="mb-4 p-3 rounded-lg" style={{ background: colors.accentLight }}>
                      <div className="flex items-center gap-1 mb-1">
                        <Sparkles size={12} color={colors.accent} />
                        <span style={{ fontSize: 10, fontWeight: 600, color: colors.accent }}>AI栄養士の提案</span>
                      </div>
                      <p style={{ fontSize: 11, color: colors.text, lineHeight: 1.5 }} className="line-clamp-3">
                        {nutritionFeedback}
                      </p>
                    </div>
                  )}

                  {/* 改善対象の選択 */}
                  <div className="mb-4">
                    <p style={{ fontSize: 12, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
                      どの食事を改善しますか？
                    </p>
                    {(() => {
                      const targetDateStr = weekDates[selectedDayIndex]?.dateStr;
                      const targetDay = currentPlanDays?.find((d: MealPlanDay) => d.dayDate === targetDateStr);
                      const todayStr = new Date().toISOString().split('T')[0];
                      const isPast = targetDateStr && targetDateStr < todayStr;

                      if (isPast) {
                        return (
                          <div className="p-3 rounded-lg text-center" style={{ background: colors.bg }}>
                            <p style={{ fontSize: 12, color: colors.textLight, marginBottom: 8 }}>
                              この日は過去のため、翌日の献立を改善します
                            </p>
                            <button
                              onClick={onSelectNextDay}
                              className="px-4 py-2 rounded-lg text-xs font-medium"
                              style={{ background: colors.accent, color: '#fff' }}
                            >
                              翌日の献立を改善
                            </button>
                          </div>
                        );
                      }

                      const mealOptions: { type: MealType; label: string; icon: string }[] = [
                        { type: 'breakfast', label: '朝食', icon: '🌅' },
                        { type: 'lunch', label: '昼食', icon: '☀️' },
                        { type: 'dinner', label: '夕食', icon: '🌙' },
                      ];

                      return (
                        <div className="space-y-2">
                          {mealOptions.map(opt => {
                            const isSelected = improveMealTargets.includes(opt.type);
                            const existingMeal = targetDay?.meals?.find((m: PlannedMeal) => m.mealType === opt.type);

                            return (
                              <button
                                key={opt.type}
                                onClick={() => onToggleMealTarget(opt.type)}
                                className={`w-full p-3 rounded-lg flex items-center gap-3 transition-all ${isSelected ? 'ring-2 ring-orange-400' : ''}`}
                                style={{
                                  background: isSelected ? colors.accentLight : colors.bg,
                                }}
                              >
                                <span className="text-xl">{opt.icon}</span>
                                <div className="flex-1 text-left">
                                  <p style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>{opt.label}</p>
                                  <p style={{ fontSize: 11, color: colors.textLight }}>
                                    {existingMeal?.dishes?.length
                                      ? `現在: ${existingMeal.dishes.map((d: DishDetail) => d.name).join('、')}`
                                      : '未設定'
                                    }
                                  </p>
                                </div>
                                <div
                                  className={`w-5 h-5 rounded-full flex items-center justify-center ${isSelected ? 'bg-white' : ''}`}
                                  style={{ border: isSelected ? 'none' : `2px solid ${colors.border}` }}
                                >
                                  {isSelected && <Check size={14} color={colors.accent} />}
                                </div>
                              </button>
                            );
                          })}

                          {/* 1日全体を選択 */}
                          <button
                            onClick={onSelectAllDay}
                            className="w-full p-2 rounded-lg text-xs text-center transition-all"
                            style={{
                              background: !improveNextDay && improveMealTargets.length === 3 ? colors.accentLight : 'transparent',
                              color: colors.accent
                            }}
                          >
                            {!improveNextDay && improveMealTargets.length === 3 ? '✓ この日1日を選択中' : 'この日1日全体を選択'}
                          </button>

                          {/* 翌日1日を改善 */}
                          {(() => {
                            const nextDayIndex = selectedDayIndex + 1;
                            const nextDay = weekDates[nextDayIndex];
                            if (!nextDay) return null;

                            return (
                              <button
                                onClick={onSelectNextDay}
                                className="w-full p-3 rounded-lg text-sm text-center transition-all flex items-center justify-center gap-2"
                                style={{
                                  background: improveNextDay ? colors.accentLight : colors.bg,
                                  color: improveNextDay ? colors.accent : colors.textLight,
                                  border: improveNextDay ? `2px solid ${colors.accent}` : 'none'
                                }}
                              >
                                <span>📅</span>
                                <span>
                                  {improveNextDay ? '✓ ' : ''}翌日（{nextDay.date.getMonth() + 1}/{nextDay.date.getDate()}）1日を改善
                                </span>
                              </button>
                            );
                          })()}
                        </div>
                      );
                    })()}
                  </div>

                  {/* 実行ボタン */}
                  <div className="flex gap-2">
                    <button
                      onClick={onClose}
                      className="flex-1 py-3 rounded-lg text-sm"
                      style={{ background: colors.bg, color: colors.textLight }}
                    >
                      キャンセル
                    </button>
                    <button
                      onClick={onImprove}
                      disabled={improveMealTargets.length === 0}
                      className="flex-1 py-3 rounded-lg text-sm font-medium text-white disabled:opacity-50 flex items-center justify-center gap-2"
                      style={{ background: colors.accent }}
                    >
                      <Sparkles size={14} />
                      {improveNextDay
                        ? `翌日${improveMealTargets.length}食分を改善`
                        : `${improveMealTargets.length}食分を改善`
                      }
                    </button>
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
