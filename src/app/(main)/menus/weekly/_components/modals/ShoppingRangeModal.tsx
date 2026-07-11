"use client";

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronDown, ChevronRight, ChevronLeft, Check, Sparkles } from "lucide-react";
import type { ServingsConfig } from "@/types/domain";
import { formatLocalDate, formatDateJa } from "@homegohan/shared";
import { useShoppingStore, useServingsConfigStore } from "../../_state";

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
  border: '#E8E8E8',
};

interface ShoppingRangeModalProps {
  isTodayExpanded: boolean;
  /** カレンダーで現在表示中の週の開始日（UX2-09: 「表示中の週」選択肢用） */
  currentWeekStart: Date;
  onClose: () => void;
  onToggleTodayExpanded: (expanded: boolean) => void;
  onGenerate: (servingsConfig: ServingsConfig | null) => Promise<void>;
}

// UX2-09: 「日付範囲」文字列を作る（単日なら1つ、範囲なら「〜」で連結）
const formatDateRangeLabel = (startStr: string, endStr: string): string =>
  startStr === endStr ? formatDateJa(startStr) : `${formatDateJa(startStr)}〜${formatDateJa(endStr)}`;

export function ShoppingRangeModal({
  isTodayExpanded,
  currentWeekStart,
  onClose,
  onToggleTodayExpanded,
  onGenerate,
}: ShoppingRangeModalProps) {
  const shoppingRange = useShoppingStore((s) => s.shoppingRange);
  const shoppingRangeStep = useShoppingStore((s) => s.shoppingRangeStep);
  const setShoppingRange = useShoppingStore((s) => s.setShoppingRange);
  const setShoppingRangeStep = useShoppingStore((s) => s.setShoppingRangeStep);
  const servingsConfig = useServingsConfigStore((s) => s.servingsConfig);
  const setServingsConfig = useServingsConfigStore((s) => s.setServingsConfig);

  // UX2-09: 各選択肢に具体的な日付範囲を併記する
  const now = new Date();
  const todayStr = formatLocalDate(now);
  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = formatLocalDate(tomorrowDate);
  const dayAfterDate = new Date(now);
  dayAfterDate.setDate(dayAfterDate.getDate() + 2);
  const dayAfterStr = formatLocalDate(dayAfterDate);
  const daysEndDate = new Date(now);
  daysEndDate.setDate(daysEndDate.getDate() + shoppingRange.daysCount - 1);
  const daysEndStr = formatLocalDate(daysEndDate);
  const weekEndDate = new Date(now);
  weekEndDate.setDate(weekEndDate.getDate() + 6);
  const weekEndStr = formatLocalDate(weekEndDate);
  const currentWeekStartStr = formatLocalDate(currentWeekStart);
  const currentWeekEndDate = new Date(currentWeekStart);
  currentWeekEndDate.setDate(currentWeekEndDate.getDate() + 6);
  const currentWeekEndStr = formatLocalDate(currentWeekEndDate);

  return (
    <motion.div
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-4 pb-4 lg:pb-6 rounded-t-3xl max-h-[75vh] overflow-y-auto"
      style={{ background: colors.card }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Step 1: 範囲選択 */}
      {shoppingRangeStep === 'range' && (
        <>
          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center gap-2">
              <span style={{ fontSize: 15, fontWeight: 600 }}>買い物の範囲を選択</span>
              <span style={{ fontSize: 11, color: colors.textMuted, background: colors.bg, padding: '2px 6px', borderRadius: 6 }}>ステップ 1/2</span>
            </div>
            <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
              <X size={14} color={colors.textLight} />
            </button>
          </div>

          <div className="space-y-2">
            {/* 今日の分 */}
            <div>
              <button
                onClick={() => {
                  if (shoppingRange.type === 'today') {
                    onToggleTodayExpanded(!isTodayExpanded);
                  } else {
                    setShoppingRange({ ...shoppingRange, type: 'today' });
                    onToggleTodayExpanded(true);
                  }
                }}
                className="w-full p-3 rounded-xl flex items-center justify-between transition-colors"
                style={{
                  background: shoppingRange.type === 'today' ? colors.accent : colors.bg,
                  border: `1px solid ${shoppingRange.type === 'today' ? colors.accent : colors.border}`
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 500, color: shoppingRange.type === 'today' ? '#fff' : colors.text }}>
                  今日の分
                  <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 6, opacity: 0.8 }}>（{formatDateJa(todayStr)}）</span>
                </span>
                {shoppingRange.type === 'today' && (
                  <ChevronDown
                    size={16}
                    color="#fff"
                    style={{ transform: isTodayExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
                  />
                )}
              </button>

              {/* 今日の食事タイプ選択 */}
              <AnimatePresence>
                {shoppingRange.type === 'today' && isTodayExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="pl-4 pt-2 space-y-1">
                      {(['breakfast', 'lunch', 'dinner'] as const).map((mealType) => {
                        const isSelected = shoppingRange.todayMeals.includes(mealType);
                        const label = mealType === 'breakfast' ? '朝食' : mealType === 'lunch' ? '昼食' : '夕食';
                        return (
                          <button
                            key={mealType}
                            onClick={() => {
                              const newMeals = isSelected
                                ? shoppingRange.todayMeals.filter(m => m !== mealType)
                                : [...shoppingRange.todayMeals, mealType];
                              setShoppingRange({ ...shoppingRange, todayMeals: newMeals });
                            }}
                            className="w-full p-2.5 rounded-lg flex items-center gap-2"
                            style={{ background: isSelected ? `${colors.accent}15` : 'transparent' }}
                          >
                            <div
                              className="w-5 h-5 rounded flex items-center justify-center"
                              style={{
                                background: isSelected ? colors.accent : 'transparent',
                                border: `2px solid ${isSelected ? colors.accent : colors.border}`
                              }}
                            >
                              {isSelected && <Check size={12} color="#fff" />}
                            </div>
                            <span style={{ fontSize: 13, color: colors.text }}>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* 明日の分 */}
            <button
              onClick={() => setShoppingRange({ ...shoppingRange, type: 'tomorrow' })}
              className="w-full p-3 rounded-xl flex items-center justify-between transition-colors"
              style={{
                background: shoppingRange.type === 'tomorrow' ? colors.accent : colors.bg,
                border: `1px solid ${shoppingRange.type === 'tomorrow' ? colors.accent : colors.border}`
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 500, color: shoppingRange.type === 'tomorrow' ? '#fff' : colors.text }}>
                明日の分
                <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 6, opacity: 0.8 }}>（{formatDateJa(tomorrowStr)}）</span>
              </span>
            </button>

            {/* 明後日の分 */}
            <button
              onClick={() => setShoppingRange({ ...shoppingRange, type: 'dayAfterTomorrow' })}
              className="w-full p-3 rounded-xl flex items-center justify-between transition-colors"
              style={{
                background: shoppingRange.type === 'dayAfterTomorrow' ? colors.accent : colors.bg,
                border: `1px solid ${shoppingRange.type === 'dayAfterTomorrow' ? colors.accent : colors.border}`
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 500, color: shoppingRange.type === 'dayAfterTomorrow' ? '#fff' : colors.text }}>
                明後日の分
                <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 6, opacity: 0.8 }}>（{formatDateJa(dayAfterStr)}）</span>
              </span>
            </button>

            {/* 表示中の週（UX2-09: 今日起点ではなく、カレンダーで開いている週） */}
            <button
              onClick={() => setShoppingRange({ ...shoppingRange, type: 'currentWeek' })}
              className="w-full p-3 rounded-xl flex items-center justify-between transition-colors"
              style={{
                background: shoppingRange.type === 'currentWeek' ? colors.accent : colors.bg,
                border: `1px solid ${shoppingRange.type === 'currentWeek' ? colors.accent : colors.border}`
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 500, color: shoppingRange.type === 'currentWeek' ? '#fff' : colors.text }}>
                表示中の週
                <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 6, opacity: 0.8 }}>（{formatDateRangeLabel(currentWeekStartStr, currentWeekEndStr)}）</span>
              </span>
            </button>

            {/* ○○日分 */}
            <div>
              <button
                onClick={() => setShoppingRange({ ...shoppingRange, type: 'days' })}
                className="w-full p-3 rounded-xl flex items-center justify-between transition-colors"
                style={{
                  background: shoppingRange.type === 'days' ? colors.accent : colors.bg,
                  border: `1px solid ${shoppingRange.type === 'days' ? colors.accent : colors.border}`
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 500, color: shoppingRange.type === 'days' ? '#fff' : colors.text }}>
                  {shoppingRange.daysCount}日分
                  <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 6, opacity: 0.8 }}>（{formatDateRangeLabel(todayStr, daysEndStr)}）</span>
                </span>
              </button>

              {shoppingRange.type === 'days' && (
                <div className="pl-4 pt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={14}
                    value={shoppingRange.daysCount}
                    onChange={(e) => setShoppingRange({ ...shoppingRange, daysCount: parseInt(e.target.value) || 1 })}
                    className="w-20 p-2 rounded-lg text-center text-[14px] outline-none"
                    style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                  />
                  <span style={{ fontSize: 13, color: colors.textMuted }}>日分（今日から）</span>
                </div>
              )}
            </div>

            {/* 1週間分 */}
            <button
              onClick={() => setShoppingRange({ ...shoppingRange, type: 'week' })}
              className="w-full p-3 rounded-xl flex items-center justify-between transition-colors"
              style={{
                background: shoppingRange.type === 'week' ? colors.accent : colors.bg,
                border: `1px solid ${shoppingRange.type === 'week' ? colors.accent : colors.border}`
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 500, color: shoppingRange.type === 'week' ? '#fff' : colors.text }}>
                1週間分（今日から）
                <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 6, opacity: 0.8 }}>{formatDateRangeLabel(todayStr, weekEndStr)}</span>
              </span>
            </button>
          </div>

          {/* 次へボタン */}
          <button
            onClick={() => setShoppingRangeStep('servings')}
            disabled={shoppingRange.type === 'today' && shoppingRange.todayMeals.length === 0}
            className="w-full mt-4 p-3.5 rounded-xl font-semibold text-[14px] disabled:opacity-50 flex items-center justify-center gap-2"
            style={{ background: colors.accent, color: '#fff' }}
          >
            次へ（人数確認）
            <ChevronRight size={18} />
          </button>
        </>
      )}

      {/* Step 2: 人数確認・編集 */}
      {shoppingRangeStep === 'servings' && (
        <>
          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShoppingRangeStep('range')}
                className="w-7 h-7 rounded-full flex items-center justify-center"
                style={{ background: colors.bg }}
              >
                <ChevronLeft size={14} color={colors.textLight} />
              </button>
              <span style={{ fontSize: 15, fontWeight: 600 }}>人数を確認</span>
              <span style={{ fontSize: 11, color: colors.textMuted, background: colors.bg, padding: '2px 6px', borderRadius: 6 }}>ステップ 2/2</span>
            </div>
            <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
              <X size={14} color={colors.textLight} />
            </button>
          </div>

          <p style={{ fontSize: 13, color: colors.textLight, marginBottom: 12 }}>
            各セルをクリックして人数を変更できます（0=作らない）
          </p>

          {/* Grid Header */}
          <div className="grid grid-cols-4 gap-2 mb-2">
            <div />
            {(['朝', '昼', '夜'] as const).map((label, i) => (
              <div key={i} className="text-center font-bold" style={{ fontSize: 13, color: colors.text }}>{label}</div>
            ))}
          </div>

          {/* Grid Rows */}
          {(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const).map((day) => {
            const labels: Record<string, string> = { monday: '月', tuesday: '火', wednesday: '水', thursday: '木', friday: '金', saturday: '土', sunday: '日' };
            const isWeekend = day === 'saturday' || day === 'sunday';
            const defaultServings = servingsConfig?.default ?? 2;

            return (
              <div key={day} className="grid grid-cols-4 gap-2 mb-2">
                <div className="flex items-center justify-center font-bold" style={{ fontSize: 13, color: isWeekend ? colors.accent : colors.text }}>
                  {labels[day]}
                </div>
                {(['breakfast', 'lunch', 'dinner'] as const).map((meal) => {
                  const value = servingsConfig?.byDayMeal?.[day]?.[meal] ?? defaultServings;

                  const updateValue = (newValue: number) => {
                    const updated: ServingsConfig = {
                      default: servingsConfig?.default ?? 2,
                      byDayMeal: { ...servingsConfig?.byDayMeal }
                    };
                    if (!updated.byDayMeal[day]) updated.byDayMeal[day] = {};
                    updated.byDayMeal[day][meal] = Math.max(0, Math.min(10, newValue));
                    setServingsConfig(updated);
                  };

                  return (
                    <div
                      key={meal}
                      className="flex items-center justify-between rounded-lg px-1"
                      style={{
                        background: value === 0 ? colors.bg : colors.successLight,
                        border: `1px solid ${value === 0 ? colors.border : colors.success}`
                      }}
                    >
                      <button
                        onClick={() => updateValue(value - 1)}
                        className="w-6 h-8 flex items-center justify-center text-lg font-bold"
                        style={{ color: value === 0 ? colors.textMuted : colors.success }}
                      >
                        −
                      </button>
                      <span
                        className="font-bold text-center min-w-[16px]"
                        style={{
                          fontSize: 14,
                          color: value === 0 ? colors.textMuted : colors.success
                        }}
                      >
                        {value === 0 ? '-' : value}
                      </span>
                      <button
                        onClick={() => updateValue(value + 1)}
                        className="w-6 h-8 flex items-center justify-center text-lg font-bold"
                        style={{ color: value === 0 ? colors.textMuted : colors.success }}
                      >
                        +
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Legend */}
          <div className="flex justify-center gap-4 mt-3 mb-3">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded" style={{ background: colors.successLight, border: `1px solid ${colors.success}` }} />
              <span style={{ fontSize: 11, color: colors.textLight }}>作る</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded" style={{ background: colors.bg, border: `1px solid ${colors.border}` }} />
              <span style={{ fontSize: 11, color: colors.textLight }}>作らない</span>
            </div>
          </div>

          {/* 生成開始ボタン */}
          <button
            onClick={() => onGenerate(servingsConfig)}
            data-testid="generate-shopping-list-button"
            className="w-full mt-2 p-3.5 rounded-xl font-semibold text-[14px] flex items-center justify-center gap-2"
            style={{ background: colors.accent, color: '#fff' }}
          >
            <Sparkles size={18} />
            この設定で買い物リストを生成
          </button>
        </>
      )}
    </motion.div>
  );
}
