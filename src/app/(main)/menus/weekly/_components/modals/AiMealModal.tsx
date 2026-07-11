"use client";

import React, { useId, useRef } from "react";
import { motion } from "framer-motion";
import FocusTrap from "focus-trap-react";
import { Sparkles, X, Check } from "lucide-react";
import { AI_CONDITIONS, MEAL_LABELS, formatDateJa } from "@homegohan/shared";
import { useFormDraftStore } from "../../_state";
import { useDialogA11y } from "@/components/common/useDialogA11y";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#767676', // #1052 (コントラスト): #A0A0A0 (白地で約2.7:1) から WCAG AA相当の #767676 (約4.5:1) へ
  accent: '#E07A5F',
  accentLight: 'rgba(224,122,95,0.1)',
  border: '#E8E8E8',
};

interface WeekDate {
  date: Date;
  dateStr: string;
  dayOfWeek: string;
}

interface AiMealModalProps {
  weekDates: WeekDate[];
  onClose: () => void;
  onGenerateSingleMeal: () => void;
}

export function AiMealModal({
  weekDates,
  onClose,
  onGenerateSingleMeal,
}: AiMealModalProps) {
  const addMealKey = useFormDraftStore((s) => s.addMealKey);
  const addMealDayIndex = useFormDraftStore((s) => s.addMealDayIndex);
  const selectedConditions = useFormDraftStore((s) => s.selectedConditions);
  const aiChatInput = useFormDraftStore((s) => s.aiChatInput);
  const setSelectedConditions = useFormDraftStore((s) => s.setSelectedConditions);
  const setAiChatInput = useFormDraftStore((s) => s.setAiChatInput);

  const dayInfo = weekDates[addMealDayIndex];
  const mealLabel = addMealKey ? MEAL_LABELS[addMealKey as keyof typeof MEAL_LABELS] : '';

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
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
      style={{ background: colors.card, maxHeight: '70vh' }}
    >
      <div className="flex justify-between items-center px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex items-center gap-2">
          <Sparkles size={18} color={colors.accent} />
          <span id={titleId} style={{ fontSize: 15, fontWeight: 600 }}>
            {dayInfo && `${formatDateJa(dayInfo.dateStr)}（${dayInfo.dayOfWeek}）`}の{mealLabel}
          </span>
        </div>
        <button onClick={onClose} aria-label="閉じる" className="min-w-[44px] min-h-[44px] -m-2 flex items-center justify-center">
          <span className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
            <X size={14} color={colors.textLight} />
          </span>
        </button>
      </div>
      <div className="flex-1 p-4 overflow-auto">
        <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 12 }}>条件を指定（複数選択可）</p>
        {AI_CONDITIONS.map((text, i) => {
          const isSelected = selectedConditions.includes(text);
          return (
            <button
              key={i}
              data-testid={`weekly-condition-${text}`}
              onClick={() => setSelectedConditions(
                isSelected ? selectedConditions.filter(c => c !== text) : [...selectedConditions, text]
              )}
              className="w-full p-3 mb-1.5 rounded-[10px] text-left text-[13px] flex items-center justify-between transition-all"
              style={{
                background: isSelected ? colors.accentLight : colors.bg,
                color: isSelected ? colors.accent : colors.text,
                border: isSelected ? `2px solid ${colors.accent}` : '2px solid transparent'
              }}
            >
              <span>{text}</span>
              {isSelected && <Check size={16} color={colors.accent} />}
            </button>
          );
        })}
        <div className="mt-4">
          <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 8 }}>リクエスト（任意）</p>
          <textarea
            value={aiChatInput}
            onChange={(e) => setAiChatInput(e.target.value)}
            placeholder="例: 昨日カレーだったので違うものがいい、野菜多めで..."
            className="w-full p-3 rounded-[10px] text-[13px] outline-none resize-none"
            style={{ background: colors.bg, minHeight: 80 }}
          />
        </div>
      </div>
      <div className="px-4 py-4 pb-4 lg:pb-6 flex-shrink-0" style={{ borderTop: `1px solid ${colors.border}`, background: colors.card }}>
        <button
          onClick={onGenerateSingleMeal}
          className="w-full py-3.5 rounded-xl flex items-center justify-center gap-2"
          style={{ background: colors.accent }}
        >
          <Sparkles size={16} color="#fff" />
          <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>この1食をAIに提案してもらう</span>
        </button>
      </div>
    </motion.div>
    </FocusTrap>
  );
}
