"use client";

import React from "react";
import { motion } from "framer-motion";
import {
  ShoppingCart, X, Trash2, Plus, Users, Check, RefreshCw
} from "lucide-react";
import type { ShoppingListItem } from "@/types/domain";
import { SHOPPING_LIST_PHASES } from "@homegohan/shared";
import { ProgressTodoCard } from "../ProgressTodoCard";
import { useShoppingStore } from "../../_state";

const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  success: '#6B9B6B',
  purple: '#7C6BA0',
  border: '#E8E8E8',
  danger: '#D64545',
};

interface ShoppingModalProps {
  groupedShoppingList: [string, ShoppingListItem[]][];
  hasAnyMealsThisWeek: boolean;
  onClose: () => void;
  onOpenAddShopping: () => void;
  onOpenShoppingRange: () => void;
  onToggleItem: (id: string, isChecked: boolean) => void;
  onDeleteItem: (id: string) => void;
  onDeleteAll: () => void;
  onToggleVariant: (id: string, item: ShoppingListItem) => void;
  onOpenServingsModal: () => void;
  onDismissProgress: () => void;
  onSetSuccessMessage: (msg: { title: string; message: string }) => void;
}

export function ShoppingModal({
  groupedShoppingList,
  hasAnyMealsThisWeek,
  onClose,
  onOpenAddShopping,
  onOpenShoppingRange,
  onToggleItem,
  onDeleteItem,
  onDeleteAll,
  onToggleVariant,
  onOpenServingsModal,
  onDismissProgress,
  onSetSuccessMessage,
}: ShoppingModalProps) {
  const shoppingList = useShoppingStore((s) => s.shoppingList);
  const shoppingListTotalServings = useShoppingStore((s) => s.shoppingListTotalServings);
  const isRegeneratingShoppingList = useShoppingStore((s) => s.isRegeneratingShoppingList);
  const shoppingListProgress = useShoppingStore((s) => s.shoppingListProgress);

  return (
    <div className="fixed inset-0 z-[201] pointer-events-none">
      {/* backdrop: 背後ナビを遮断しモーダルを閉じる (#76) */}
      <div
        className="absolute inset-0 pointer-events-auto"
        onClick={onClose}
      />
      <motion.div
        initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="absolute bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 flex flex-col rounded-t-3xl pointer-events-auto"
        style={{ background: colors.card, maxHeight: '75vh' }}
      >
        <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
          <div className="flex items-center gap-2">
            <ShoppingCart size={18} color={colors.accent} />
            <span style={{ fontSize: 15, fontWeight: 600 }}>買い物リスト</span>
            <span style={{ fontSize: 11, color: colors.textMuted }}>{shoppingList.filter(i => !i.isChecked).length}/{shoppingList.length}</span>
            {shoppingListTotalServings !== null && shoppingListTotalServings > 0 && (
              <span style={{ fontSize: 11, color: colors.accent, fontWeight: 600, background: colors.accentLight, padding: '2px 6px', borderRadius: 8 }}>
                {shoppingListTotalServings}食分
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {shoppingList.length > 0 && (
              <button
                onClick={onDeleteAll}
                className="w-7 h-7 rounded-full flex items-center justify-center"
                style={{ background: colors.bg }}
                title="すべて削除"
              >
                <Trash2 size={14} color={colors.danger || '#ef4444'} />
              </button>
            )}
            <button
              onClick={onOpenServingsModal}
              className="w-7 h-7 rounded-full flex items-center justify-center"
              style={{ background: colors.bg }}
              title="人数設定"
            >
              <Users size={14} color={colors.textLight} />
            </button>
            <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
              <X size={14} color={colors.textLight} />
            </button>
          </div>
        </div>
        <div className="flex-1 p-3 overflow-auto">
          {shoppingList.length === 0 ? (
            <p className="text-center py-8" style={{ color: colors.textMuted }}>買い物リストは空です</p>
          ) : (
            <div className="space-y-4">
              {groupedShoppingList.map(([category, items]) => (
                <div key={category}>
                  {/* カテゴリ見出し */}
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <span className="text-[13px] font-semibold" style={{ color: colors.text }}>{category}</span>
                    <span className="text-[11px]" style={{ color: colors.textMuted }}>
                      {items.filter(i => !i.isChecked).length}/{items.length}
                    </span>
                  </div>
                  {/* カテゴリ内アイテム */}
                  {items.map(item => (
                    <div
                      key={item.id}
                      className="flex items-center gap-2.5 p-3 rounded-[10px] mb-1.5"
                      style={{ background: item.isChecked ? colors.bg : colors.card, border: item.isChecked ? 'none' : `1px solid ${colors.border}` }}
                    >
                      <button
                        onClick={() => onToggleItem(item.id, item.isChecked)}
                        className="w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0"
                        style={{
                          border: item.isChecked ? 'none' : `2px solid ${colors.border}`,
                          background: item.isChecked ? colors.success : 'transparent'
                        }}
                      >
                        {item.isChecked && <Check size={12} color="#fff" />}
                      </button>
                      <span className="flex-1" style={{ fontSize: 14, color: item.isChecked ? colors.textMuted : colors.text, textDecoration: item.isChecked ? 'line-through' : 'none' }}>
                        {item.itemName}
                      </span>
                      {/* 数量（タップで切り替え） */}
                      <button
                        onClick={() => onToggleVariant(item.id, item)}
                        disabled={!item.quantityVariants || item.quantityVariants.length <= 1}
                        className="px-2 py-0.5 rounded text-[12px] transition-colors"
                        style={{
                          color: colors.textMuted,
                          background: item.quantityVariants?.length > 1 ? colors.bg : 'transparent',
                          cursor: item.quantityVariants?.length > 1 ? 'pointer' : 'default'
                        }}
                        title={item.quantityVariants?.length > 1 ? 'タップで単位切替' : undefined}
                      >
                        {item.quantity || '適量'}
                        {item.quantityVariants?.length > 1 && <span className="ml-0.5 text-[10px]">⟳</span>}
                      </button>
                      {/* AI/手動バッジ */}
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px]"
                        style={{
                          background: item.source === 'generated' ? '#E8F5E9' : '#FFF3E0',
                          color: item.source === 'generated' ? '#2E7D32' : '#E65100'
                        }}
                      >
                        {item.source === 'generated' ? 'AI' : '手動'}
                      </span>
                      <button
                        onClick={() => onDeleteItem(item.id)}
                        className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
                        style={{ background: 'rgba(0,0,0,0.05)' }}
                      >
                        <Trash2 size={12} color={colors.textMuted} />
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        {/* 再生成中の進捗表示 */}
        {isRegeneratingShoppingList && shoppingListProgress && (
          <div className="mx-0">
            <ProgressTodoCard
              progress={shoppingListProgress}
              colors={colors}
              phases={SHOPPING_LIST_PHASES}
              defaultMessage="買い物リストを生成中..."
            />
            {/* エラー時の閉じるボタン */}
            {shoppingListProgress.phase === 'failed' && (
              <div className="mx-3 mt-2 flex justify-end">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDismissProgress();
                  }}
                  className="px-4 py-2 rounded-lg text-sm font-medium"
                  style={{ background: colors.card, color: colors.text, border: `1px solid ${colors.border}` }}
                >
                  閉じる
                </button>
              </div>
            )}
          </div>
        )}
        <div className="px-4 py-2.5 pb-4 lg:pb-6 flex gap-2" style={{ borderTop: `1px solid ${colors.border}` }}>
          <button onClick={onOpenAddShopping} className="flex-1 p-3 rounded-xl flex items-center justify-center gap-1.5" style={{ background: colors.bg, border: `1px dashed ${colors.border}` }}>
            <Plus size={14} color={colors.textMuted} />
            <span style={{ fontSize: 12, color: colors.textMuted }}>追加</span>
          </button>
          <button
            onClick={() => {
              if (!hasAnyMealsThisWeek) {
                onSetSuccessMessage({
                  title: '献立がありません',
                  message: 'この週の献立がありません。先に献立を生成してください。',
                });
                return;
              }
              onOpenShoppingRange();
            }}
            disabled={isRegeneratingShoppingList}
            data-testid="shopping-regenerate-button"
            className="flex-[2] p-3 rounded-xl flex items-center justify-center gap-1.5 transition-opacity"
            style={{ background: colors.accent, opacity: isRegeneratingShoppingList ? 0.7 : 1 }}
          >
            {isRegeneratingShoppingList ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>AIが整理中...</span>
              </>
            ) : (
              <>
                <RefreshCw size={14} color="#fff" />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>献立から再生成</span>
              </>
            )}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
