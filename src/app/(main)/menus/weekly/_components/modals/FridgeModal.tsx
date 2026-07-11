"use client";

import React, { useId, useRef } from "react";
import { motion } from "framer-motion";
import FocusTrap from "focus-trap-react";
import { Refrigerator, X, Trash2, Plus, Camera, Pencil, RefreshCw } from "lucide-react";
import { daysUntilLocal, formatExpiry } from "@homegohan/shared";
import type { PantryItem } from "@/types/domain";
import { usePantryStore } from "../../_state";
import { useDialogA11y } from "@/components/common/useDialogA11y";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#767676', // #1052 (コントラスト): #A0A0A0 (白地で約2.7:1) から WCAG AA相当の #767676 (約4.5:1) へ
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

interface FridgeModalProps {
  onClose: () => void;
  onOpenAddFridge: () => void;
  onDeleteItem: (id: string) => void;
  /** UX2-18: 一覧タップで編集フォームを開く（/pantry ページとの機能非対称解消）。未指定なら編集不可（従来どおり） */
  onEditItem?: (item: PantryItem) => void;
  /** UX2-18: /pantry ページと同じ「写真で追加」を、このモーダルからも実行できるようにする。未指定なら非表示 */
  onPhotoSelected?: (file: File) => void;
  isAnalyzingPhoto?: boolean;
}

export function FridgeModal({
  onClose,
  onOpenAddFridge,
  onDeleteItem,
  onEditItem,
  onPhotoSelected,
  isAnalyzingPhoto = false,
}: FridgeModalProps) {
  const fridgeItems = usePantryStore((s) => s.fridgeItems);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // #1052 (体系的 a11y)
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogA11y({ onClose });

  return (
    <FocusTrap
      focusTrapOptions={{
        allowOutsideClick: true,
        escapeDeactivates: false,
        fallbackFocus: () => panelRef.current ?? document.body,
      }}
    >
    <motion.div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
      style={{ background: colors.card, maxHeight: '75vh' }}
    >
      <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex items-center gap-2">
          <Refrigerator size={18} color={colors.blue} />
          <span id={titleId} style={{ fontSize: 15, fontWeight: 600 }}>冷蔵庫</span>
          <span style={{ fontSize: 11, color: colors.textMuted }}>{fridgeItems.length}品</span>
        </div>
        <button onClick={onClose} aria-label="閉じる" className="min-w-[44px] min-h-[44px] -m-2 flex items-center justify-center">
          <span className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
            <X size={14} color={colors.textLight} />
          </span>
        </button>
      </div>
      {isAnalyzingPhoto && (
        <div className="flex items-center gap-2 px-4 py-2.5" style={{ background: colors.accentLight }}>
          <RefreshCw size={14} className="animate-spin" color={colors.accent} />
          <span style={{ fontSize: 12, color: colors.accent }}>写真から食材を解析中…</span>
        </div>
      )}
      <div className="flex-1 p-3 overflow-auto">
        {fridgeItems.length === 0 ? (
          <p className="text-center py-8" style={{ color: colors.textMuted }}>冷蔵庫は空です</p>
        ) : (
          fridgeItems.sort((a, b) => (daysUntilLocal(a.expirationDate) ?? 999) - (daysUntilLocal(b.expirationDate) ?? 999)).map(item => {
            const daysLeft = daysUntilLocal(item.expirationDate);
            return (
              // UX2-18: 既存 E2E (store-selector-sync.spec.ts) が
              // `ancestor::div[contains(@class,'rounded')]` / `locator("button").last()` で
              // 削除ボタンを特定しているため、ルート要素は div のまま維持し、削除ボタンを最後の button にする
              <div
                key={item.id}
                data-testid="fridge-item"
                role={onEditItem ? "button" : undefined}
                tabIndex={onEditItem ? 0 : undefined}
                onClick={() => onEditItem?.(item)}
                onKeyDown={(e) => {
                  // #1052: role="button" のカスタム要素は Enter に加え Space でも
                  // 活性化できる必要がある（WAI-ARIA APG のボタンパターン）。
                  if (onEditItem && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    onEditItem(item);
                  }
                }}
                className="flex items-center justify-between px-3 py-2.5 rounded-[10px] mb-1.5"
                style={{
                  background: daysLeft !== null && daysLeft <= 1 ? colors.dangerLight : daysLeft !== null && daysLeft <= 3 ? colors.warningLight : colors.bg,
                  cursor: onEditItem ? 'pointer' : 'default',
                }}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <span style={{ fontSize: 14, fontWeight: 500, color: colors.text }} className="truncate">{item.name}</span>
                  <span style={{ fontSize: 11, color: colors.textMuted }}>{item.amount || ''}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: daysLeft !== null && daysLeft <= 1 ? colors.danger : daysLeft !== null && daysLeft <= 3 ? colors.warning : colors.textMuted,
                  }}>
                    {formatExpiry(daysLeft)}
                  </span>
                  {onEditItem && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onEditItem(item); }}
                      className="w-6 h-6 rounded-md flex items-center justify-center"
                      style={{ background: 'rgba(0,0,0,0.05)' }}
                      aria-label="編集"
                    >
                      <Pencil size={12} color={colors.textMuted} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onDeleteItem(item.id); }}
                    className="w-6 h-6 rounded-md flex items-center justify-center"
                    style={{ background: 'rgba(0,0,0,0.05)' }}
                    aria-label="削除"
                  >
                    <Trash2 size={12} color={colors.textMuted} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="px-4 py-2.5 pb-4 lg:pb-6 flex gap-2" style={{ borderTop: `1px solid ${colors.border}` }}>
        {onPhotoSelected && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onPhotoSelected(file);
                e.target.value = '';
              }}
            />
            {/* UX2-18: /pantry ページと同じ「写真で追加」をこのモーダルからも使えるようにする */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isAnalyzingPhoto}
              className="flex-1 p-3 rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50"
              style={{ background: colors.bg, border: `1px dashed ${colors.border}` }}
            >
              <Camera size={16} color={colors.textMuted} />
              <span style={{ fontSize: 13, color: colors.textMuted }}>写真で追加</span>
            </button>
          </>
        )}
        {/* UX2-18: ボタン文言は既存 E2E (store-selector-sync.spec.ts) が「食材を追加」で検索するため維持 */}
        <button onClick={onOpenAddFridge} className="flex-1 p-3 rounded-xl flex items-center justify-center gap-1.5" style={{ background: colors.bg, border: `1px dashed ${colors.border}` }}>
          <Plus size={16} color={colors.textMuted} />
          <span style={{ fontSize: 13, color: colors.textMuted }}>食材を追加</span>
        </button>
      </div>
    </motion.div>
    </FocusTrap>
  );
}
