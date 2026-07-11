"use client";

import React from "react";
import { motion } from "framer-motion";
import { X, ChevronRight } from "lucide-react";
import { MEAL_LABELS, formatDateJa } from "@homegohan/shared";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  warningLight: '#FEF9EE',
  purpleLight: '#F5F3F8',
  successLight: '#EDF5ED',
  blueLight: '#EEF4FB',
  border: '#E8E8E8',
};

type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'midnight_snack';

const ALL_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'];

interface WeekDate {
  date: Date;
  dateStr: string;
  dayOfWeek: string;
}

interface AddMealSlotModalProps {
  selectedDayIndex: number;
  weekDates: WeekDate[];
  onClose: () => void;
  onSelectMealType: (type: MealType, dayIndex: number) => void;
}

export function AddMealSlotModal({
  selectedDayIndex,
  weekDates,
  onClose,
  onSelectMealType,
}: AddMealSlotModalProps) {
  const dayInfo = weekDates[selectedDayIndex];

  return (
    <motion.div
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-3.5 pb-4 lg:pb-7 rounded-t-3xl"
      style={{ background: colors.card }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex justify-between items-center mb-3.5">
        <span style={{ fontSize: 15, fontWeight: 600 }}>食事を追加</span>
        <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
          <X size={14} color={colors.textLight} />
        </button>
      </div>
      <p style={{ fontSize: 12, color: colors.textMuted, marginBottom: 12 }}>
        {dayInfo && `${formatDateJa(dayInfo.dateStr)}（${dayInfo.dayOfWeek}）`}に追加する食事を選んでください
      </p>
      <div className="flex flex-col gap-2">
        {ALL_MEAL_TYPES.map(type => (
          <button
            key={type}
            onClick={() => onSelectMealType(type, selectedDayIndex)}
            className="w-full flex items-center justify-between p-4 rounded-xl transition-colors"
            style={{ background: colors.bg }}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{
                background: type === 'breakfast' ? colors.warningLight
                  : type === 'lunch' ? colors.accentLight
                  : type === 'dinner' ? colors.purpleLight
                  : type === 'snack' ? colors.successLight
                  : colors.blueLight
              }}>
                <span style={{ fontSize: 18 }}>
                  {type === 'breakfast' ? '🌅'
                    : type === 'lunch' ? '☀️'
                    : type === 'dinner' ? '🌙'
                    : type === 'snack' ? '🍪'
                    : '🌃'}
                </span>
              </div>
              <span style={{ fontSize: 15, fontWeight: 500, color: colors.text }}>{MEAL_LABELS[type]}</span>
            </div>
            <ChevronRight size={18} color={colors.textMuted} />
          </button>
        ))}
      </div>
    </motion.div>
  );
}
