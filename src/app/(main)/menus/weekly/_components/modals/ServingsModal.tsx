"use client";

import React from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import type { ServingsConfig } from "@/types/domain";
import { useServingsConfigStore } from "../../_state";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  border: '#E8E8E8',
};

type DayOfWeekKey = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
type MealTimeKey = 'breakfast' | 'lunch' | 'dinner';

interface ServingsModalProps {
  onClose: () => void;
  onSave: () => void;
}

export function ServingsModal({
  onClose,
  onSave,
}: ServingsModalProps) {
  const servingsConfig = useServingsConfigStore((s) => s.servingsConfig);
  const setServingsConfig = useServingsConfigStore((s) => s.setServingsConfig);

  const days: DayOfWeekKey[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const dayLabels: Record<DayOfWeekKey, string> = {
    monday: '月', tuesday: '火', wednesday: '水', thursday: '木',
    friday: '金', saturday: '土', sunday: '日'
  };

  const updateValue = (day: DayOfWeekKey, meal: MealTimeKey, newValue: number) => {
    const updated: ServingsConfig = {
      default: servingsConfig?.default ?? 2,
      byDayMeal: { ...servingsConfig?.byDayMeal }
    };
    if (!updated.byDayMeal[day]) updated.byDayMeal[day] = {};
    updated.byDayMeal[day]![meal] = Math.max(0, Math.min(10, newValue));
    setServingsConfig(updated);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[300] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
        className="w-[95%] max-w-md rounded-2xl p-5"
        style={{ background: colors.card }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h3 style={{ fontSize: 18, fontWeight: 700 }}>曜日別人数設定</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
            <X size={16} color={colors.textLight} />
          </button>
        </div>

        <p style={{ fontSize: 13, color: colors.textLight, marginBottom: 16 }}>
          各セルをクリックして人数を変更（0=作らない/外食）
        </p>

        {/* Grid Header */}
        <div className="grid grid-cols-4 gap-2 mb-2">
          <div />
          {(['朝', '昼', '夜'] as const).map((label, i) => (
            <div key={i} className="text-center font-bold" style={{ fontSize: 13, color: colors.text }}>{label}</div>
          ))}
        </div>

        {/* Grid Rows */}
        {days.map((day) => {
          const isWeekend = day === 'saturday' || day === 'sunday';
          const defaultServings = servingsConfig?.default ?? 2;

          return (
            <div key={day} className="grid grid-cols-4 gap-2 mb-2">
              <div className="flex items-center justify-center font-bold" style={{ fontSize: 13, color: isWeekend ? colors.accent : colors.text }}>
                {dayLabels[day]}
              </div>
              {(['breakfast', 'lunch', 'dinner'] as MealTimeKey[]).map((meal) => {
                const value = servingsConfig?.byDayMeal?.[day]?.[meal] ?? defaultServings;

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
                      onClick={() => updateValue(day, meal, value - 1)}
                      className="w-7 h-9 flex items-center justify-center text-lg font-bold"
                      style={{ color: value === 0 ? colors.textMuted : colors.success }}
                    >
                      −
                    </button>
                    <span
                      className="font-bold text-center min-w-[18px]"
                      style={{
                        fontSize: 15,
                        color: value === 0 ? colors.textMuted : colors.success
                      }}
                    >
                      {value === 0 ? '-' : value}
                    </span>
                    <button
                      onClick={() => updateValue(day, meal, value + 1)}
                      className="w-7 h-9 flex items-center justify-center text-lg font-bold"
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
        <div className="flex justify-center gap-4 mt-4 mb-4">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded" style={{ background: colors.successLight, border: `1px solid ${colors.success}` }} />
            <span style={{ fontSize: 11, color: colors.textLight }}>作る</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded" style={{ background: colors.bg, border: `1px solid ${colors.border}` }} />
            <span style={{ fontSize: 11, color: colors.textLight }}>作らない</span>
          </div>
        </div>

        {/* Save Button */}
        <button
          onClick={onSave}
          className="w-full p-3.5 rounded-xl font-semibold"
          style={{ background: colors.accent, color: '#fff' }}
        >
          保存する
        </button>
      </motion.div>
    </motion.div>
  );
}
