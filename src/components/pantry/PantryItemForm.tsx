"use client";

import React from "react";

/**
 * UX2-18: 冷蔵庫アイテムの追加・編集フォーム（週間献立の FridgeModal と /pantry ページで共通利用）。
 * 「編集フォーム共通化」の要求に対応するための、状態を持たない純粋な表示コンポーネント。
 */

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  accent: '#E07A5F',
  border: '#E8E8E8',
};

export interface PantryItemFormValues {
  name: string;
  amount: string;
  expirationDate: string;
}

interface PantryItemFormProps {
  values: PantryItemFormValues;
  onChange: (values: PantryItemFormValues) => void;
  onSubmit: () => void;
  /** true の場合は「更新する」等、編集モードの文言・挙動になる */
  isEditing?: boolean;
  submitting?: boolean;
}

export function PantryItemForm({
  values,
  onChange,
  onSubmit,
  isEditing = false,
  submitting = false,
}: PantryItemFormProps) {
  return (
    <div className="space-y-3">
      <input
        type="text"
        value={values.name}
        onChange={(e) => onChange({ ...values, name: e.target.value })}
        placeholder="食材名（例: 鶏もも肉）"
        className="w-full p-3 rounded-xl text-[14px] outline-none"
        style={{ background: colors.bg, border: `1px solid ${colors.border}`, color: colors.text }}
      />
      <input
        type="text"
        value={values.amount}
        onChange={(e) => onChange({ ...values, amount: e.target.value })}
        placeholder="量（例: 300g）"
        className="w-full p-3 rounded-xl text-[14px] outline-none"
        style={{ background: colors.bg, border: `1px solid ${colors.border}`, color: colors.text }}
      />
      <input
        type="date"
        value={values.expirationDate}
        onChange={(e) => onChange({ ...values, expirationDate: e.target.value })}
        className="w-full p-3 rounded-xl text-[14px] outline-none"
        style={{ background: colors.bg, border: `1px solid ${colors.border}`, color: colors.text }}
      />
      <button
        onClick={onSubmit}
        disabled={!values.name || submitting}
        className="w-full p-3 rounded-xl font-semibold text-[14px] disabled:opacity-50"
        style={{ background: colors.accent, color: '#fff' }}
      >
        {submitting ? '保存中…' : isEditing ? '更新する' : '追加する'}
      </button>
    </div>
  );
}

export const emptyPantryItemFormValues: PantryItemFormValues = {
  name: '',
  amount: '',
  expirationDate: '',
};

// カラーパレットは呼び出し元のヘッダー等でも揃えたい場合のために export しておく
export const pantryFormColors = colors;
