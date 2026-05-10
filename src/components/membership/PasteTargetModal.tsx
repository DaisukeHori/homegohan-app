'use client';

// src/components/membership/PasteTargetModal.tsx
// (設計書 membership/03-ui-spec.md §6.2)
// 「家族のどのメンバに貼るか」選択モーダル

import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { Meal } from './MealRow';
import type { FamilyMember } from '@/schemas/membership';

// アバター色パレット (設計書 §11.1)
const AVATAR_COLORS = [
  '#FF6B6B',
  '#51CF66',
  '#FAB005',
  '#845EF7',
  '#22B8CF',
  '#FF8787',
  '#94D82D',
  '#FFA94D',
];

function getMemberColor(index: number, avatarColor?: string): string {
  if (avatarColor) return avatarColor;
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

function getMemberDisplayName(member: FamilyMember): string {
  return member.display_name ?? 'メンバー';
}

interface PasteTargetModalProps {
  meal: Meal;
  members: FamilyMember[];
  currentUserId: string;
  onConfirm: (params: { target_user_ids: string[] }) => void;
  onClose: () => void;
  isPasting?: boolean;
}

export function PasteTargetModal({
  meal,
  members,
  currentUserId,
  onConfirm,
  onClose,
  isPasting = false,
}: PasteTargetModalProps) {
  // ペースト対象は自分以外のアクティブメンバのみ
  const targets = members.filter(
    (m) => m.status === 'active' && m.user_id !== currentUserId,
  );

  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);

  const handleToggle = (userId: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  const handleConfirm = () => {
    if (selectedUserIds.length === 0) return;
    onConfirm({ target_user_ids: selectedUserIds });
  };

  return (
    <div
      className="fixed inset-0 z-50"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="ペースト先の選択"
    >
      <div
        className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl shadow-xl"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: '75vh', overflowY: 'auto' }}
      >
        {/* ヘッダ */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <span className="font-semibold text-gray-800 text-base">
            ペースト先を選んでください
          </span>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-gray-100"
            aria-label="閉じる"
          >
            <X size={18} color="#6B6B6B" />
          </button>
        </div>

        {/* ペースト元の食事サマリ */}
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-100">
          <p className="text-xs text-gray-500">ペースト元</p>
          <p className="text-sm font-medium text-gray-800 mt-0.5">
            {meal.memo || '（記録なし）'}
          </p>
        </div>

        {/* メンバー一覧 */}
        <div className="py-2">
          {targets.length === 0 ? (
            <p className="px-4 py-4 text-sm text-gray-500 text-center">
              ペースト先のメンバーが見つかりません
            </p>
          ) : (
            targets.map((member, idx) => {
              const color = getMemberColor(idx, member.avatar_color);
              const userId = member.user_id ?? '';
              const checked = userId ? selectedUserIds.includes(userId) : false;
              const roleLabel =
                member.role === 'representative'
                  ? '代表'
                  : member.role === 'child'
                  ? '子供'
                  : '大人';

              return (
                <button
                  key={member.id}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 text-left"
                  onClick={() => userId && handleToggle(userId)}
                  disabled={!userId}
                >
                  {/* アバター */}
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      backgroundColor: color,
                      fontSize: 13,
                      color: '#fff',
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {getMemberDisplayName(member).charAt(0)}
                  </span>

                  {/* 表示名 + ロール */}
                  <span className="flex-1 text-sm text-gray-700">
                    {getMemberDisplayName(member)}
                    <span className="ml-1.5 text-xs text-gray-400">({roleLabel})</span>
                    {!userId && (
                      <span className="ml-1.5 text-xs text-gray-300">
                        アカウント未連携
                      </span>
                    )}
                  </span>

                  {/* チェックボックス */}
                  <span
                    className="w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0"
                    style={{
                      borderColor: checked ? '#845EF7' : '#D1D5DB',
                      backgroundColor: checked ? '#845EF7' : 'transparent',
                    }}
                  >
                    {checked && (
                      <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                        <path
                          d="M1 4l2.5 2.5L9 1"
                          stroke="#fff"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* 確定ボタン */}
        <div className="px-4 pb-6 pt-2 border-t border-gray-100">
          <button
            className="w-full py-3 rounded-xl text-white font-semibold text-sm disabled:opacity-50"
            style={{ backgroundColor: '#845EF7' }}
            onClick={handleConfirm}
            disabled={selectedUserIds.length === 0 || isPasting}
          >
            {isPasting
              ? 'ペースト中...'
              : `選択してペースト (${selectedUserIds.length}人)`}
          </button>
        </div>
      </div>
    </div>
  );
}
