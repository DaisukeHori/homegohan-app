"use client";

import React, { useId, useRef } from "react";
import { motion } from "framer-motion";
import FocusTrap from "focus-trap-react";
import { Sparkles, X, Check, Send } from "lucide-react";
import { AI_CONDITIONS } from "@homegohan/shared";
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

interface AiAssistantModalProps {
  isGenerating: boolean;
  emptySlotCount: number;
  onClose: () => void;
  onGenerateWeekly: () => void;
}

export function AiAssistantModal({
  isGenerating,
  emptySlotCount,
  onClose,
  onGenerateWeekly,
}: AiAssistantModalProps) {
  const selectedConditions = useFormDraftStore((s) => s.selectedConditions);
  const aiChatInput = useFormDraftStore((s) => s.aiChatInput);
  const setSelectedConditions = useFormDraftStore((s) => s.setSelectedConditions);
  const setAiChatInput = useFormDraftStore((s) => s.setAiChatInput);

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
          <span id={titleId} style={{ fontSize: 15, fontWeight: 600 }}>AIアシスタント</span>
        </div>
        <button onClick={onClose} aria-label="閉じる" className="min-w-[44px] min-h-[44px] -m-2 flex items-center justify-center">
          <span className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
            <X size={14} color={colors.textLight} />
          </span>
        </button>
      </div>
      <div className="flex-1 p-4 overflow-auto">
        <button
          onClick={onGenerateWeekly}
          disabled={isGenerating}
          className="w-full p-4 mb-3 rounded-[14px] text-left transition-opacity"
          style={{ background: colors.accent, opacity: isGenerating ? 0.6 : 1 }}
        >
          <div className="flex items-center gap-2 mb-1">
            {isGenerating ? (
              <div className="w-[18px] h-[18px] border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <Sparkles size={18} color="#fff" />
            )}
            <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>
              {isGenerating
                ? '生成中...'
                : emptySlotCount > 0
                  ? '空欄をすべて埋める'
                  : 'AI献立アシスタント'}
            </span>
          </div>
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', margin: 0 }}>
            {isGenerating
              ? 'AIが献立を作成しています...'
              : emptySlotCount > 0
                ? `${emptySlotCount}件の空欄にAIが献立を提案します`
                : `期間を指定してAIに献立を作成してもらえます`}
          </p>
        </button>
        <p style={{ fontSize: 11, color: colors.textMuted, margin: '12px 0 8px' }}>条件を指定（複数選択可）</p>
        {AI_CONDITIONS.map((text, i) => {
          const isSelected = selectedConditions.includes(text);
          return (
            <button
              key={i}
              data-testid={`ai-condition-${text}`}
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
      </div>
      <div className="px-4 py-3 flex gap-2 flex-shrink-0 pb-4 lg:pb-6" style={{ borderTop: `1px solid ${colors.border}`, background: colors.card }}>
        <input
          type="text"
          value={aiChatInput}
          onChange={(e) => setAiChatInput(e.target.value)}
          placeholder="例: 木金は簡単に..."
          aria-label="AIへのリクエスト"
          className="flex-1 px-3.5 py-2.5 rounded-full text-[13px] outline-none"
          style={{ background: colors.bg }}
        />
        <button
          onClick={onGenerateWeekly}
          disabled={isGenerating}
          aria-label="AIに献立を生成させる"
          className="w-11 h-11 rounded-full flex items-center justify-center cursor-pointer hover:opacity-90 transition-opacity"
          style={{ background: colors.accent }}
        >
          <Send size={16} color="#fff" />
        </button>
      </div>
    </motion.div>
    </FocusTrap>
  );
}
