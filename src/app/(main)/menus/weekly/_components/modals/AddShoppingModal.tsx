"use client";

import React, { useId, useRef } from "react";
import { motion } from "framer-motion";
import FocusTrap from "focus-trap-react";
import { X } from "lucide-react";
import { useFormDraftStore } from "../../_state";
import { useDialogA11y } from "@/components/common/useDialogA11y";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  textLight: '#6B6B6B',
  accent: '#E07A5F',
  border: '#E8E8E8',
};

interface AddShoppingModalProps {
  onAdd: () => void;
  onClose: () => void;
}

export function AddShoppingModal({
  onAdd,
  onClose,
}: AddShoppingModalProps) {
  const newShoppingName = useFormDraftStore((s) => s.newShoppingName);
  const newShoppingAmount = useFormDraftStore((s) => s.newShoppingAmount);
  const newShoppingCategory = useFormDraftStore((s) => s.newShoppingCategory);
  const setNewShoppingName = useFormDraftStore((s) => s.setNewShoppingName);
  const setNewShoppingAmount = useFormDraftStore((s) => s.setNewShoppingAmount);
  const setNewShoppingCategory = useFormDraftStore((s) => s.setNewShoppingCategory);

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
        <span id={titleId} style={{ fontSize: 15, fontWeight: 600 }}>買い物リストに追加</span>
        <button onClick={onClose} aria-label="閉じる" className="min-w-[44px] min-h-[44px] -m-2 flex items-center justify-center">
          <span className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
            <X size={14} color={colors.textLight} />
          </span>
        </button>
      </div>
      <div className="space-y-3">
        <input
          type="text"
          value={newShoppingName}
          onChange={(e) => setNewShoppingName(e.target.value)}
          placeholder="品名（例: もやし）"
          className="w-full p-3 rounded-xl text-[14px] outline-none"
          style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
        />
        <input
          type="text"
          value={newShoppingAmount}
          onChange={(e) => setNewShoppingAmount(e.target.value)}
          placeholder="量（例: 2袋）"
          className="w-full p-3 rounded-xl text-[14px] outline-none"
          style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
        />
        <select
          value={newShoppingCategory}
          onChange={(e) => setNewShoppingCategory(e.target.value)}
          className="w-full p-3 rounded-xl text-[14px] outline-none"
          style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
        >
          <option value="野菜">野菜</option>
          <option value="肉">肉</option>
          <option value="魚">魚</option>
          <option value="乳製品">乳製品</option>
          <option value="調味料">調味料</option>
          <option value="乾物">乾物</option>
          <option value="食材">その他</option>
        </select>
        <button
          onClick={onAdd}
          disabled={!newShoppingName}
          className="w-full p-3 rounded-xl font-semibold text-[14px] disabled:opacity-50"
          style={{ background: colors.accent, color: '#fff' }}
        >
          追加する
        </button>
      </div>
    </motion.div>
    </FocusTrap>
  );
}
