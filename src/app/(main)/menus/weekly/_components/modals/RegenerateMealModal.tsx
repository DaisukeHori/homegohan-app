"use client";

import React from "react";
import { motion } from "framer-motion";
import { Sparkles, X, Check } from "lucide-react";
import { AI_CONDITIONS, MEAL_LABELS } from "@homegohan/shared";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: 'rgba(224,122,95,0.1)',
  border: '#E8E8E8',
};

type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'midnight_snack';

interface RegeneratingMeal {
  mealType: string;
  dishName: string;
}

interface RegenerateMealModalProps {
  regeneratingMeal: RegeneratingMeal;
  selectedConditions: string[];
  aiChatInput: string;
  isRegenerating: boolean;
  onClose: () => void;
  onChangeConditions: (conditions: string[]) => void;
  onChangeAiChatInput: (value: string) => void;
  onRegenerateMeal: () => void;
}

export function RegenerateMealModal({
  regeneratingMeal,
  selectedConditions,
  aiChatInput,
  isRegenerating,
  onClose,
  onChangeConditions,
  onChangeAiChatInput,
  onRegenerateMeal,
}: RegenerateMealModalProps) {
  return (
    <motion.div
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
      style={{ background: colors.card, maxHeight: '70vh' }}
    >
      <div className="flex justify-between items-center px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex items-center gap-2">
          <Sparkles size={18} color={colors.accent} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>
            {MEAL_LABELS[regeneratingMeal.mealType as MealType]}をAIで変更
          </span>
        </div>
        <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
          <X size={14} color={colors.textLight} />
        </button>
      </div>
      <div className="flex-1 p-4 overflow-auto">
        <div className="p-3 rounded-xl mb-4" style={{ background: colors.bg }}>
          <p style={{ fontSize: 12, color: colors.textMuted, margin: '0 0 4px' }}>現在の献立</p>
          <p style={{ fontSize: 14, fontWeight: 500, color: colors.text, margin: 0 }}>{regeneratingMeal.dishName}</p>
        </div>

        <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 12 }}>新しい条件を指定（複数選択可）</p>
        {AI_CONDITIONS.map((text, i) => {
          const isSelected = selectedConditions.includes(text);
          return (
            <button
              key={i}
              data-testid={`regen-condition-${text}`}
              onClick={() => onChangeConditions(
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
            onChange={(e) => onChangeAiChatInput(e.target.value)}
            placeholder="例: もっとヘルシーに、魚料理がいい..."
            className="w-full p-3 rounded-[10px] text-[13px] outline-none resize-none"
            style={{ background: colors.bg, minHeight: 80 }}
          />
        </div>
      </div>
      <div className="px-4 py-4 pb-4 lg:pb-6 flex-shrink-0" style={{ borderTop: `1px solid ${colors.border}`, background: colors.card }}>
        <button
          onClick={onRegenerateMeal}
          disabled={isRegenerating}
          className="w-full py-3.5 rounded-xl flex items-center justify-center gap-2"
          style={{ background: colors.accent, opacity: isRegenerating ? 0.7 : 1 }}
        >
          {isRegenerating ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>AIが新しい献立を考え中...</span>
            </>
          ) : (
            <>
              <Sparkles size={16} color="#fff" />
              <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>AIで別の献立に変更</span>
            </>
          )}
        </button>
      </div>
    </motion.div>
  );
}
