"use client";

import React from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { useFormDraftStore } from "../../_state";
import { PantryItemForm, type PantryItemFormValues } from "@/components/pantry/PantryItemForm";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  border: '#E8E8E8',
};

interface AddFridgeModalProps {
  onAdd: () => void;
  onClose: () => void;
  /** 保存中の場合は送信ボタンを disabled にする（UX2-18: 編集フォーム共通化に伴い追加） */
  submitting?: boolean;
}

export function AddFridgeModal({
  onAdd,
  onClose,
  submitting = false,
}: AddFridgeModalProps) {
  const newFridgeName = useFormDraftStore((s) => s.newFridgeName);
  const newFridgeAmount = useFormDraftStore((s) => s.newFridgeAmount);
  const newFridgeExpiry = useFormDraftStore((s) => s.newFridgeExpiry);
  const editingFridgeItemId = useFormDraftStore((s) => s.editingFridgeItemId);
  const setNewFridgeName = useFormDraftStore((s) => s.setNewFridgeName);
  const setNewFridgeAmount = useFormDraftStore((s) => s.setNewFridgeAmount);
  const setNewFridgeExpiry = useFormDraftStore((s) => s.setNewFridgeExpiry);

  const values: PantryItemFormValues = {
    name: newFridgeName,
    amount: newFridgeAmount,
    expirationDate: newFridgeExpiry,
  };

  const handleChange = (next: PantryItemFormValues) => {
    if (next.name !== newFridgeName) setNewFridgeName(next.name);
    if (next.amount !== newFridgeAmount) setNewFridgeAmount(next.amount);
    if (next.expirationDate !== newFridgeExpiry) setNewFridgeExpiry(next.expirationDate);
  };

  return (
    <motion.div
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-4 pb-4 lg:pb-6 rounded-t-3xl"
      style={{ background: colors.card }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex justify-between items-center mb-4">
        <span style={{ fontSize: 15, fontWeight: 600 }}>
          {editingFridgeItemId ? '食材を編集' : '食材を追加'}
        </span>
        <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
          <X size={14} color={colors.textLight} />
        </button>
      </div>
      {/* UX2-18: 追加・編集フォームを共通コンポーネント化 */}
      <PantryItemForm
        values={values}
        onChange={handleChange}
        onSubmit={onAdd}
        isEditing={Boolean(editingFridgeItemId)}
        submitting={submitting}
      />
    </motion.div>
  );
}
