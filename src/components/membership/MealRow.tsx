'use client';

// src/components/membership/MealRow.tsx
// (設計書 membership/03-ui-spec.md §5.2)
// 1 食分の表示 (オーナーアバター + メニュー名 + ペーストボタン)

import React from 'react';
import { MoreVertical, Link2 } from 'lucide-react';
import type { FamilyMember } from '@/schemas/membership';

// meals テーブルの行を表す最小インタフェース
export interface Meal {
  id: string;
  user_id: string;
  eaten_at: string | null;
  meal_type: string;
  photo_url: string | null;
  memo: string | null;
  paste_group_id: string | null;
  created_at?: string;
}

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

function formatTime(isoString: string | null): string {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

interface MealRowProps {
  meal: Meal;
  ownerMember: FamilyMember | null;
  memberIndex?: number;
  isPasteGrouped?: boolean;
  currentUserId: string;
  onPasteClick?: (meal: Meal) => void;
  onMenuClick?: (meal: Meal) => void;
}

export function MealRow({
  meal,
  ownerMember,
  memberIndex = 0,
  isPasteGrouped = false,
  currentUserId,
  onPasteClick,
  onMenuClick,
}: MealRowProps) {
  const color = getMemberColor(memberIndex, ownerMember?.avatar_color);
  const displayName = ownerMember ? getMemberDisplayName(ownerMember) : 'メンバー';
  const time = formatTime(meal.eaten_at);
  const isOwn = meal.user_id === currentUserId;

  return (
    <div
      className="flex items-center gap-2 py-2 px-3 rounded-lg hover:bg-gray-50 group"
      style={{ borderLeft: isPasteGrouped ? `3px solid ${color}` : undefined }}
    >
      {/* オーナーアバター */}
      <span
        aria-label={displayName}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: '50%',
          backgroundColor: color,
          fontSize: 11,
          color: '#fff',
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {displayName.charAt(0)}
      </span>

      {/* 表示名 */}
      <span className="text-xs text-gray-500 w-14 truncate flex-shrink-0">{displayName}</span>

      {/* メモ (メニュー名) */}
      <span className="text-sm text-gray-800 flex-1 truncate">
        {meal.memo || '（記録なし）'}
      </span>

      {/* 時刻 */}
      {time && <span className="text-xs text-gray-400 flex-shrink-0">{time}</span>}

      {/* paste_group アイコン */}
      {meal.paste_group_id && (
        <span title="ペーストグループ" className="flex-shrink-0">
          <Link2 size={12} color="#845EF7" />
        </span>
      )}

      {/* ケバブメニュー */}
      <button
        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-200 flex-shrink-0 transition-opacity"
        aria-label="操作メニュー"
        onClick={() => onMenuClick?.(meal)}
      >
        <MoreVertical size={14} color="#9CA3AF" />
      </button>
    </div>
  );
}
