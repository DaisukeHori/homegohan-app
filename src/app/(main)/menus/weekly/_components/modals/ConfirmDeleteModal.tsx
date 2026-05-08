"use client";

import React from "react";
import { motion } from "framer-motion";
import { Trash2 } from "lucide-react";
import { MEAL_LABELS } from "@homegohan/shared";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  danger: '#D64545',
  dangerLight: '#FDECEC',
};

type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'midnight_snack';

interface DeletingMeal {
  dishName?: string;
  mealType: string;
}

interface ConfirmDeleteModalProps {
  deletingMeal: DeletingMeal;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDeleteModal({
  deletingMeal,
  isDeleting,
  onCancel,
  onConfirm,
}: ConfirmDeleteModalProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[202] flex items-center justify-center p-4"
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-5"
        style={{ background: colors.card }}
      >
        <div className="flex flex-col items-center text-center mb-5">
          <div className="w-14 h-14 rounded-full flex items-center justify-center mb-3" style={{ background: colors.dangerLight }}>
            <Trash2 size={24} color={colors.danger} />
          </div>
          <h3 style={{ fontSize: 17, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
            この食事を削除しますか？
          </h3>
          <p style={{ fontSize: 13, color: colors.textMuted, margin: 0 }}>
            「{deletingMeal.dishName || MEAL_LABELS[deletingMeal.mealType as MealType]}」を削除します。<br/>
            この操作は取り消せません。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-3 rounded-xl"
            style={{ background: colors.bg }}
          >
            <span style={{ fontSize: 14, fontWeight: 500, color: colors.textLight }}>キャンセル</span>
          </button>
          <button
            onClick={onConfirm}
            disabled={isDeleting}
            className="flex-1 py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60"
            style={{ background: colors.danger }}
          >
            {isDeleting ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <>
                <Trash2 size={14} color="#fff" />
                <span style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>削除する</span>
              </>
            )}
          </button>
        </div>
      </div>
    </motion.div>
  );
}
