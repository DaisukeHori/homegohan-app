'use client';

// src/components/membership/FamilyViewSwitcher.tsx
// (設計書 membership/03-ui-spec.md §4)
// 家族ビュー切替 UI — チップ表示 + bottom sheet

import React, { useState, useCallback } from 'react';
import { ChevronDown, X, Users, User } from 'lucide-react';
import type { FamilyMember } from '@/schemas/membership';
import type { FamilyViewState, FamilyViewPreset } from '@/hooks/useFamilyView';

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

interface FamilyViewSwitcherProps {
  familyMembers: FamilyMember[];
  currentUserId: string;
  value: FamilyViewState;
  onChange: (next: FamilyViewState) => void;
}

const PRESET_LABELS: Record<FamilyViewPreset, string> = {
  self: '自分だけ',
  self_partner: '自分 + 配偶者',
  self_children: '自分 + 子供',
  children_only: '子供だけ',
  all: '家族全員',
  custom: 'カスタム',
};

function getMemberColor(index: number, avatarColor?: string): string {
  if (avatarColor) return avatarColor;
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

function getMemberDisplayName(member: FamilyMember): string {
  if (member.display_name) return member.display_name;
  return 'メンバー';
}

export function FamilyViewSwitcher({
  familyMembers,
  currentUserId,
  value,
  onChange,
}: FamilyViewSwitcherProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draftIds, setDraftIds] = useState<string[]>(value.visible_member_ids);
  const [draftPreset, setDraftPreset] = useState<FamilyViewPreset>(value.preset);

  const activeMembers = familyMembers.filter((m) => m.status === 'active');

  // プリセット選択時に visible_member_ids を自動計算
  const resolveIdsForPreset = useCallback(
    (preset: FamilyViewPreset): string[] => {
      if (preset === 'all') return activeMembers.map((m) => m.id);
      if (preset === 'self') {
        const me = activeMembers.find((m) => m.user_id === currentUserId);
        return me ? [me.id] : [];
      }
      if (preset === 'self_partner') {
        const me = activeMembers.find((m) => m.user_id === currentUserId);
        const others = activeMembers
          .filter((m) => m.user_id !== currentUserId && m.role !== 'child')
          .slice(0, 1);
        return [...(me ? [me.id] : []), ...others.map((m) => m.id)];
      }
      if (preset === 'self_children') {
        const me = activeMembers.find((m) => m.user_id === currentUserId);
        const children = activeMembers.filter((m) => m.role === 'child');
        return [...(me ? [me.id] : []), ...children.map((m) => m.id)];
      }
      if (preset === 'children_only') {
        return activeMembers.filter((m) => m.role === 'child').map((m) => m.id);
      }
      // custom: 変更しない
      return draftIds;
    },
    [activeMembers, currentUserId, draftIds],
  );

  const handleOpenSheet = () => {
    setDraftPreset(value.preset);
    setDraftIds(value.visible_member_ids);
    setSheetOpen(true);
  };

  const handleSelectPreset = (preset: FamilyViewPreset) => {
    setDraftPreset(preset);
    if (preset !== 'custom') {
      setDraftIds(resolveIdsForPreset(preset));
    }
  };

  const handleToggleMember = (memberId: string) => {
    const next = draftIds.includes(memberId)
      ? draftIds.filter((id) => id !== memberId)
      : [...draftIds, memberId];
    setDraftIds(next);
    setDraftPreset('custom');
  };

  const handleApply = () => {
    onChange({ preset: draftPreset, visible_member_ids: draftIds });
    setSheetOpen(false);
  };

  const handleCancel = () => {
    setSheetOpen(false);
  };

  const currentLabel = PRESET_LABELS[value.preset] ?? '表示設定';
  const visibleCount =
    value.preset === 'all'
      ? activeMembers.length
      : value.visible_member_ids.length;

  return (
    <>
      {/* チップ表示バー */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-white rounded-xl border border-gray-200 shadow-sm cursor-pointer"
        onClick={handleOpenSheet}
        role="button"
        aria-label="ビューを切替"
        aria-haspopup="dialog"
      >
        <Users size={14} color="#6B6B6B" />
        <span className="text-sm font-medium text-gray-700">{currentLabel}</span>
        {/* アバターチップ */}
        <div className="flex items-center gap-0.5 ml-1">
          {activeMembers.slice(0, 6).map((member, idx) => {
            const color = getMemberColor(idx, member.avatar_color);
            const isVisible =
              value.preset === 'all' || value.visible_member_ids.includes(member.id);
            return (
              <span
                key={member.id}
                title={getMemberDisplayName(member)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  backgroundColor: isVisible ? color : '#D1D5DB',
                  fontSize: 10,
                  color: '#fff',
                  fontWeight: 700,
                  border: '1.5px solid #fff',
                }}
              >
                {getMemberDisplayName(member).charAt(0)}
              </span>
            );
          })}
        </div>
        {visibleCount > 0 && (
          <span className="text-xs text-gray-400 ml-1">{visibleCount}人</span>
        )}
        <ChevronDown size={14} color="#9CA3AF" className="ml-auto" />
      </div>

      {/* Bottom Sheet Overlay */}
      {sheetOpen && (
        <div
          className="fixed inset-0 z-50"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={handleCancel}
          role="dialog"
          aria-modal="true"
          aria-label="表示するメンバーを選択"
        >
          <div
            className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl shadow-xl"
            onClick={(e) => e.stopPropagation()}
            style={{ maxHeight: '80vh', overflowY: 'auto' }}
          >
            {/* ヘッダ */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <span className="font-semibold text-gray-800 text-base">表示するメンバー</span>
              <button
                onClick={handleCancel}
                className="p-1 rounded-full hover:bg-gray-100"
                aria-label="閉じる"
              >
                <X size={18} color="#6B6B6B" />
              </button>
            </div>

            {/* プリセット一覧 */}
            <div className="px-4 py-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                プリセット
              </p>
              {(Object.entries(PRESET_LABELS) as [FamilyViewPreset, string][]).map(
                ([preset, label]) => (
                  <button
                    key={preset}
                    className="w-full flex items-center gap-3 py-2.5 px-1 rounded-lg hover:bg-gray-50 text-left"
                    onClick={() => handleSelectPreset(preset)}
                  >
                    <span
                      className="w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0"
                      style={{
                        borderColor: draftPreset === preset ? '#E07A5F' : '#D1D5DB',
                        backgroundColor: draftPreset === preset ? '#E07A5F' : 'transparent',
                      }}
                    >
                      {draftPreset === preset && (
                        <span className="w-1.5 h-1.5 bg-white rounded-full" />
                      )}
                    </span>
                    <span className="text-sm text-gray-700">{label}</span>
                  </button>
                ),
              )}
            </div>

            {/* メンバー個別選択 */}
            <div className="px-4 pb-3 border-t border-gray-100">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mt-3 mb-2">
                メンバー個別選択
              </p>
              {activeMembers.map((member, idx) => {
                const color = getMemberColor(idx, member.avatar_color);
                const checked = draftIds.includes(member.id);
                const isMe = member.user_id === currentUserId;
                return (
                  <button
                    key={member.id}
                    className="w-full flex items-center gap-3 py-2.5 px-1 rounded-lg hover:bg-gray-50 text-left"
                    onClick={() => handleToggleMember(member.id)}
                  >
                    {/* アバター */}
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 28,
                        height: 28,
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
                    <span className="text-sm text-gray-700 flex-1">
                      {getMemberDisplayName(member)}
                      {isMe && (
                        <span className="ml-1 text-xs text-gray-400">(自分)</span>
                      )}
                      {member.role === 'representative' && (
                        <span className="ml-1 text-xs text-gray-400">(代表)</span>
                      )}
                      {member.role === 'child' && (
                        <span className="ml-1 text-xs text-gray-400">(子供)</span>
                      )}
                    </span>
                    {/* チェックボックス */}
                    <span
                      className="w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0"
                      style={{
                        borderColor: checked ? '#E07A5F' : '#D1D5DB',
                        backgroundColor: checked ? '#E07A5F' : 'transparent',
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
              })}
            </div>

            {/* 適用ボタン */}
            <div className="px-4 pb-6 pt-2">
              <button
                className="w-full py-3 rounded-xl text-white font-semibold text-sm"
                style={{ backgroundColor: '#E07A5F' }}
                onClick={handleApply}
              >
                適用する
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
