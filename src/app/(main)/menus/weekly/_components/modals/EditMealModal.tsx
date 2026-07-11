"use client";

import React, { useId, useRef } from "react";
import { motion } from "framer-motion";
import FocusTrap from "focus-trap-react";
import { X } from "lucide-react";
import type { MealMode } from "@/types/domain";
import { useFormDraftStore } from "../../_state";
import { useDialogA11y } from "@/components/common/useDialogA11y";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#767676', // #1052 (コントラスト): #A0A0A0 (白地で約2.7:1) から WCAG AA相当の #767676 (約4.5:1) へ
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
  modeConfig: Record<string, ModeConfig>;
  onClose: () => void;
  onSave: () => void;
}

export function EditMealModal({
  modeConfig,
  onClose,
  onSave,
}: EditMealModalProps) {
  const editMealName = useFormDraftStore((s) => s.editMealName);
  const editMealMode = useFormDraftStore((s) => s.editMealMode);
  const setEditMealName = useFormDraftStore((s) => s.setEditMealName);
  const setEditMealMode = useFormDraftStore((s) => s.setEditMealMode);

  // #1052 (体系的 a11y)
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogA11y({ onClose });

  return (
    <FocusTrap
      focusTrapOptions={{
        allowOutsideClick: true,
        escapeDeactivates: false,
        fallbackFocus: () => panelRef.current ?? document.body,
      }}
    >
    <motion.div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-4 pb-4 lg:pb-6 rounded-t-3xl"
      style={{ background: colors.card }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex justify-between items-center mb-4">
        <span id={titleId} style={{ fontSize: 15, fontWeight: 600 }}>食事を変更</span>
        <button onClick={onClose} aria-label="閉じる" className="min-w-[44px] min-h-[44px] -m-2 flex items-center justify-center">
          <span className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
            <X size={14} color={colors.textLight} />
          </span>
        </button>
      </div>
      <div className="space-y-3">
        <div>
          <label style={{ fontSize: 12, color: colors.textMuted, display: 'block', marginBottom: 4 }}>料理名</label>
          <input
            type="text"
            value={editMealName}
            onChange={(e) => setEditMealName(e.target.value)}
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
                  onClick={() => setEditMealMode(key)}
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
    </FocusTrap>
  );
}
