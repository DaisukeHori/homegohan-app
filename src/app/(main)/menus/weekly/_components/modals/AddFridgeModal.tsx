"use client";

import React, { useId, useRef } from "react";
import { motion } from "framer-motion";
import FocusTrap from "focus-trap-react";
import { X } from "lucide-react";
import { useFormDraftStore } from "../../_state";
import { PantryItemForm, type PantryItemFormValues } from "@/components/pantry/PantryItemForm";
import { useDialogA11y } from "@/components/common/useDialogA11y";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#767676', // #1052 (コントラスト): #A0A0A0 (白地で約2.7:1) から WCAG AA相当の #767676 (約4.5:1) へ
  accent: '#E07A5F',
  border: '#E8E8E8',
};

interface AddFridgeModalProps {
  onAdd: () => void;
  onClose: () => void;
  /** 保存中の場合は送信ボタンを disabled にする（UX2-18: 編集フォーム共通化に伴い追加） */
  submitting?: boolean;
}

export function AddFridgeModal({
  onAdd,
  onClose,
  submitting = false,
}: AddFridgeModalProps) {
  const newFridgeName = useFormDraftStore((s) => s.newFridgeName);
  const newFridgeAmount = useFormDraftStore((s) => s.newFridgeAmount);
  const newFridgeExpiry = useFormDraftStore((s) => s.newFridgeExpiry);
  const editingFridgeItemId = useFormDraftStore((s) => s.editingFridgeItemId);
  const setNewFridgeName = useFormDraftStore((s) => s.setNewFridgeName);
  const setNewFridgeAmount = useFormDraftStore((s) => s.setNewFridgeAmount);
  const setNewFridgeExpiry = useFormDraftStore((s) => s.setNewFridgeExpiry);

  const values: PantryItemFormValues = {
    name: newFridgeName,
    amount: newFridgeAmount,
    expirationDate: newFridgeExpiry,
  };

  const handleChange = (next: PantryItemFormValues) => {
    if (next.name !== newFridgeName) setNewFridgeName(next.name);
    if (next.amount !== newFridgeAmount) setNewFridgeAmount(next.amount);
    if (next.expirationDate !== newFridgeExpiry) setNewFridgeExpiry(next.expirationDate);
  };

  // #1052 (体系的 a11y): role="dialog"/aria-modal/フォーカストラップ/Escape が
  // ゼロだった問題への対応。バックドロップ自体は page.tsx の共有 {activeModal && ...} が
  // 担うため、この階層では useDialogA11y で Escape・背景スクロールロックのみ後付けする。
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
        className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-4 pb-4 lg:pb-6 rounded-t-3xl"
        style={{ background: colors.card }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <span id={titleId} style={{ fontSize: 15, fontWeight: 600 }}>
            {editingFridgeItemId ? '食材を編集' : '食材を追加'}
          </span>
          {/* #1052 (タップ領域): モーダル閉じるXは元 28px。視覚サイズ維持でヒット領域のみ44x44pxに拡大 */}
          <button onClick={onClose} aria-label="閉じる" className="min-w-[44px] min-h-[44px] -m-2 flex items-center justify-center">
            <span className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
              <X size={14} color={colors.textLight} />
            </span>
          </button>
        </div>
        {/* UX2-18: 追加・編集フォームを共通コンポーネント化 */}
        <PantryItemForm
          values={values}
          onChange={handleChange}
          onSubmit={onAdd}
          isEditing={Boolean(editingFridgeItemId)}
          submitting={submitting}
        />
      </motion.div>
    </FocusTrap>
  );
}
