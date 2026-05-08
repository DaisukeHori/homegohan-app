"use client";

import React from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";

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
  newFridgeName: string;
  newFridgeAmount: string;
  newFridgeExpiry: string;
  onChangeName: (value: string) => void;
  onChangeAmount: (value: string) => void;
  onChangeExpiry: (value: string) => void;
  onAdd: () => void;
  onClose: () => void;
}

export function AddFridgeModal({
  newFridgeName,
  newFridgeAmount,
  newFridgeExpiry,
  onChangeName,
  onChangeAmount,
  onChangeExpiry,
  onAdd,
  onClose,
}: AddFridgeModalProps) {
  return (
    <motion.div
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-4 pb-4 lg:pb-6 rounded-t-3xl"
      style={{ background: colors.card }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex justify-between items-center mb-4">
        <span style={{ fontSize: 15, fontWeight: 600 }}>食材を追加</span>
        <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
          <X size={14} color={colors.textLight} />
        </button>
      </div>
      <div className="space-y-3">
        <input
          type="text"
          value={newFridgeName}
          onChange={(e) => onChangeName(e.target.value)}
          placeholder="食材名（例: 鶏もも肉）"
          className="w-full p-3 rounded-xl text-[14px] outline-none"
          style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
        />
        <input
          type="text"
          value={newFridgeAmount}
          onChange={(e) => onChangeAmount(e.target.value)}
          placeholder="量（例: 300g）"
          className="w-full p-3 rounded-xl text-[14px] outline-none"
          style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
        />
        <input
          type="date"
          value={newFridgeExpiry}
          onChange={(e) => onChangeExpiry(e.target.value)}
          className="w-full p-3 rounded-xl text-[14px] outline-none"
          style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
        />
        <button
          onClick={onAdd}
          disabled={!newFridgeName}
          className="w-full p-3 rounded-xl font-semibold text-[14px] disabled:opacity-50"
          style={{ background: colors.accent, color: '#fff' }}
        >
          追加する
        </button>
      </div>
    </motion.div>
  );
}
