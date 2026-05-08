"use client";

import React from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { useFormDraftStore } from "../../_state";

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

  return (
    <motion.div
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-4 pb-4 lg:pb-6 rounded-t-3xl"
      style={{ background: colors.card }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex justify-between items-center mb-4">
        <span style={{ fontSize: 15, fontWeight: 600 }}>買い物リストに追加</span>
        <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
          <X size={14} color={colors.textLight} />
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
  );
}
