"use client";

import React from "react";
import { motion } from "framer-motion";
import { Refrigerator, X, Trash2, Plus } from "lucide-react";
import { usePantryStore } from "../../_state";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#E5A84B',
  warningLight: '#FEF9EE',
  purple: '#7C6BA0',
  purpleLight: '#F5F3F8',
  blue: '#5B8BC7',
  blueLight: '#EEF4FB',
  border: '#E8E8E8',
  danger: '#D64545',
  dangerLight: '#FDECEC',
};

const getDaysUntil = (dateStr: string | null | undefined): number | null => {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
};

interface FridgeModalProps {
  onClose: () => void;
  onOpenAddFridge: () => void;
  onDeleteItem: (id: string) => void;
}

export function FridgeModal({
  onClose,
  onOpenAddFridge,
  onDeleteItem,
}: FridgeModalProps) {
  const fridgeItems = usePantryStore((s) => s.fridgeItems);

  return (
    <motion.div
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
      style={{ background: colors.card, maxHeight: '75vh' }}
    >
      <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex items-center gap-2">
          <Refrigerator size={18} color={colors.blue} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>冷蔵庫</span>
          <span style={{ fontSize: 11, color: colors.textMuted }}>{fridgeItems.length}品</span>
        </div>
        <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
          <X size={14} color={colors.textLight} />
        </button>
      </div>
      <div className="flex-1 p-3 overflow-auto">
        {fridgeItems.length === 0 ? (
          <p className="text-center py-8" style={{ color: colors.textMuted }}>冷蔵庫は空です</p>
        ) : (
          fridgeItems.sort((a, b) => (getDaysUntil(a.expirationDate) || 999) - (getDaysUntil(b.expirationDate) || 999)).map(item => {
            const daysLeft = getDaysUntil(item.expirationDate);
            return (
              <div key={item.id} className="flex items-center justify-between px-3 py-2.5 rounded-[10px] mb-1.5" style={{
                background: daysLeft !== null && daysLeft <= 1 ? colors.dangerLight : daysLeft !== null && daysLeft <= 3 ? colors.warningLight : colors.bg
              }}>
                <div className="flex items-center gap-2.5">
                  <span style={{ fontSize: 14, fontWeight: 500, color: colors.text }}>{item.name}</span>
                  <span style={{ fontSize: 11, color: colors.textMuted }}>{item.amount || ''}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: daysLeft !== null && daysLeft <= 1 ? colors.danger : daysLeft !== null && daysLeft <= 3 ? colors.warning : colors.textMuted,
                  }}>
                    {daysLeft === null ? '' : daysLeft === 0 ? '今日まで' : daysLeft === 1 ? '明日まで' : `${daysLeft}日`}
                  </span>
                  <button onClick={() => onDeleteItem(item.id)} className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.05)' }}>
                    <Trash2 size={12} color={colors.textMuted} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="px-4 py-2.5 pb-4 lg:pb-6" style={{ borderTop: `1px solid ${colors.border}` }}>
        <button onClick={onOpenAddFridge} className="w-full p-3 rounded-xl flex items-center justify-center gap-1.5" style={{ background: colors.bg, border: `1px dashed ${colors.border}` }}>
          <Plus size={16} color={colors.textMuted} />
          <span style={{ fontSize: 13, color: colors.textMuted }}>食材を追加</span>
        </button>
      </div>
    </motion.div>
  );
}
