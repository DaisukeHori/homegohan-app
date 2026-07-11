"use client";

import React from "react";
import { motion } from "framer-motion";
import { Trash2, type LucideIcon } from "lucide-react";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  danger: '#D64545',
  dangerLight: '#FDECEC',
  neutral: '#E07A5F',
  neutralLight: '#FDF0ED',
};

interface ConfirmDeleteModalProps {
  /** モーダルタイトル（例: 「この食事を削除しますか？」） */
  title: string;
  /** 削除対象の説明文（例: 「〇〇を削除します。この操作は取り消せません。」） */
  message: React.ReactNode;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** UX2-11: 削除以外の破壊的でない確認（中止など）にも流用できるよう一般化 */
  confirmLabel?: string;
  icon?: LucideIcon;
  /** 'danger'（既定・削除系）/ 'neutral'（中止など取り消し可能な操作） */
  tone?: 'danger' | 'neutral';
}

// #1053: 削除確認の見た目を weekly 全体で統一するため、
// 表示テキストは呼び出し元から渡す汎用コンポーネントに一般化（旧: 食事削除専用の固定文言）。
// UX2-11: confirmLabel/icon/tone を追加し、削除以外の確認（AI生成の中止など）にも再利用可能にした。
export function ConfirmDeleteModal({
  title,
  message,
  isDeleting,
  onCancel,
  onConfirm,
  confirmLabel = '削除する',
  icon: Icon = Trash2,
  tone = 'danger',
}: ConfirmDeleteModalProps) {
  const toneColor = tone === 'danger' ? colors.danger : colors.neutral;
  const toneColorLight = tone === 'danger' ? colors.dangerLight : colors.neutralLight;

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
          <div className="w-14 h-14 rounded-full flex items-center justify-center mb-3" style={{ background: toneColorLight }}>
            <Icon size={24} color={toneColor} />
          </div>
          <h3 style={{ fontSize: 17, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
            {title}
          </h3>
          <p style={{ fontSize: 13, color: colors.textMuted, margin: 0 }}>
            {message}
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
            style={{ background: toneColor }}
          >
            {isDeleting ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <>
                <Icon size={14} color="#fff" />
                <span style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>{confirmLabel}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </motion.div>
  );
}
