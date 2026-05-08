"use client";

import React from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import type { MealMode } from "@/types/domain";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  border: '#E8E8E8',
};

interface ModeConfig {
  icon: React.ElementType;
  label: string;
  color: string;
  bg: string;
}

interface EditMealModalProps {
  editMealName: string;
  editMealMode: MealMode;
  modeConfig: Record<string, ModeConfig>;
  onClose: () => void;
  onChangeName: (value: string) => void;
  onChangeMode: (mode: MealMode) => void;
  onSave: () => void;
}

export function EditMealModal({
  editMealName,
  editMealMode,
  modeConfig,
  onClose,
  onChangeName,
  onChangeMode,
  onSave,
}: EditMealModalProps) {
  return (
    <motion.div
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-4 pb-4 lg:pb-6 rounded-t-3xl"
      style={{ background: colors.card }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex justify-between items-center mb-4">
        <span style={{ fontSize: 15, fontWeight: 600 }}>食事を変更</span>
        <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
          <X size={14} color={colors.textLight} />
        </button>
      </div>
      <div className="space-y-3">
        <div>
          <label style={{ fontSize: 12, color: colors.textMuted, display: 'block', marginBottom: 4 }}>料理名</label>
          <input
            type="text"
            value={editMealName}
            onChange={(e) => onChangeName(e.target.value)}
            className="w-full p-3 rounded-xl text-[14px] outline-none"
            style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, color: colors.textMuted, display: 'block', marginBottom: 4 }}>タイプ</label>
          <div className="flex flex-wrap gap-2">
            {(Object.entries(modeConfig) as [MealMode, ModeConfig][]).map(([key, mode]) => {
              const ModeIcon = mode.icon;
              const isSelected = editMealMode === key;
              return (
                <button
                  key={key}
                  onClick={() => onChangeMode(key)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg"
                  style={{
                    background: isSelected ? mode.bg : colors.bg,
                    border: isSelected ? `2px solid ${mode.color}` : '2px solid transparent'
                  }}
                >
                  <ModeIcon size={14} color={isSelected ? mode.color : colors.textMuted} />
                  <span style={{ fontSize: 12, color: isSelected ? mode.color : colors.textMuted }}>{mode.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <button
          onClick={onSave}
          className="w-full p-3 rounded-xl font-semibold text-[14px]"
          style={{ background: colors.accent, color: '#fff' }}
        >
          保存する
        </button>
      </div>
    </motion.div>
  );
}
