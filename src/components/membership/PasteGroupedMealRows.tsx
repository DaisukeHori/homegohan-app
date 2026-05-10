'use client';

// src/components/membership/PasteGroupedMealRows.tsx
// (設計書 membership/03-ui-spec.md §5.2)
// 同じ paste_group_id の meals をまとめて 1 ブロック表示

import React from 'react';
import { Link2, Users } from 'lucide-react';
import { MealRow } from './MealRow';
import type { Meal } from './MealRow';
import type { FamilyMember } from '@/schemas/membership';
import type { FamilyViewState } from '@/hooks/useFamilyView';

interface PasteGroupedMealRowsProps {
  meals: Meal[];
  members: FamilyMember[];
  group_id: string;
  viewState?: FamilyViewState;
  currentUserId: string;
  onPasteClick?: (meal: Meal) => void;
  onMenuClick?: (meal: Meal) => void;
}

export function PasteGroupedMealRows({
  meals,
  members,
  group_id,
  viewState,
  currentUserId,
  onPasteClick,
  onMenuClick,
}: PasteGroupedMealRowsProps) {
  // ビュー切替フィルタ (viewState がなければ全件表示)
  const visibleMeals = meals.filter((meal) => {
    if (!viewState || viewState.preset === 'all') return true;
    const ownerMember = members.find((m) => m.user_id === meal.user_id);
    if (!ownerMember) return false;
    return viewState.visible_member_ids.includes(ownerMember.id);
  });

  if (visibleMeals.length === 0) return null;

  // 時刻昇順でソート
  const sorted = [...visibleMeals].sort((a, b) => {
    const ta = a.eaten_at ? new Date(a.eaten_at).getTime() : 0;
    const tb = b.eaten_at ? new Date(b.eaten_at).getTime() : 0;
    return ta - tb;
  });

  // メンバー情報を user_id で引く
  function getMember(userId: string): FamilyMember | null {
    return members.find((m) => m.user_id === userId) ?? null;
  }
  function getMemberIndex(userId: string): number {
    return members.findIndex((m) => m.user_id === userId);
  }

  return (
    <div className="relative">
      {/* 縦線 */}
      <div
        className="absolute left-3 top-0 bottom-6 w-0.5"
        style={{ backgroundColor: '#845EF7', opacity: 0.3 }}
      />
      {/* 各行 */}
      <div className="space-y-0">
        {sorted.map((meal) => {
          const member = getMember(meal.user_id);
          const idx = getMemberIndex(meal.user_id);
          return (
            <MealRow
              key={meal.id}
              meal={meal}
              ownerMember={member}
              memberIndex={idx >= 0 ? idx : 0}
              isPasteGrouped
              currentUserId={currentUserId}
              onPasteClick={onPasteClick}
              onMenuClick={onMenuClick}
            />
          );
        })}
      </div>

      {/* グループフッタ: 「🔗 N人で共有」 */}
      <div className="flex items-center gap-1.5 pl-5 pb-1 mt-0.5">
        <Link2 size={11} color="#845EF7" />
        <span className="text-xs text-purple-600">
          {sorted.length}人で共有
        </span>
      </div>
    </div>
  );
}
