'use client';

// src/components/membership/MealActionSheet.tsx
// (設計書 membership/03-ui-spec.md §6.1)
// meal 行クリック時のアクション (編集/削除/家族にペースト)

import React from 'react';
import { X, Copy, Pencil, Trash2 } from 'lucide-react';
import type { Meal } from './MealRow';

interface MealActionSheetProps {
  meal: Meal;
  onClose: () => void;
  onPaste: (meal: Meal) => void;
  onEdit?: (meal: Meal) => void;
  onDelete?: (meal: Meal) => void;
  isOwner?: boolean; // 自分の食事のみペースト可
}

function formatTime(isoString: string | null): string {
  if (!isoString) return '';
  try {
    return new Date(isoString).toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function MealActionSheet({
  meal,
  onClose,
  onPaste,
  onEdit,
  onDelete,
  isOwner = true,
}: MealActionSheetProps) {
  const time = formatTime(meal.eaten_at);

  return (
    <div
      className="fixed inset-0 z-50"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="食事の操作"
    >
      <div
        className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダ */}
        <div className="flex items-start justify-between px-4 py-3 border-b border-gray-100">
          <div>
            <p className="font-semibold text-gray-800 text-base">
              {meal.memo || '（記録なし）'}
            </p>
            {time && (
              <p className="text-sm text-gray-400 mt-0.5">{time}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-gray-100"
            aria-label="閉じる"
          >
            <X size={18} color="#6B6B6B" />
          </button>
        </div>

        {/* アクション一覧 */}
        <div className="py-2">
          {isOwner && (
            <button
              className="w-full flex items-center gap-3 px-5 py-3.5 hover:bg-gray-50 text-left"
              onClick={() => { onPaste(meal); onClose(); }}
            >
              <Copy size={18} color="#845EF7" />
              <span className="text-sm font-medium text-gray-800">家族にもペースト</span>
            </button>
          )}
          {onEdit && (
            <button
              className="w-full flex items-center gap-3 px-5 py-3.5 hover:bg-gray-50 text-left"
              onClick={() => { onEdit(meal); onClose(); }}
            >
              <Pencil size={18} color="#5B8BC7" />
              <span className="text-sm font-medium text-gray-800">編集</span>
            </button>
          )}
          {onDelete && (
            <button
              className="w-full flex items-center gap-3 px-5 py-3.5 hover:bg-gray-50 text-left"
              onClick={() => { onDelete(meal); onClose(); }}
            >
              <Trash2 size={18} color="#D64545" />
              <span className="text-sm font-medium text-red-600">削除</span>
            </button>
          )}
        </div>

        <div className="pb-6" />
      </div>
    </div>
  );
}
