"use client";

import { Utensils, Heart, Clock } from "lucide-react";
import { motion } from "framer-motion";

const colors = {
  card: "#FFFFFF",
  text: "#2D2D2D",
  textMuted: "#A0A0A0",
  border: "#E8E6E1",
  bg: "#F7F6F3",
  favRed: "#FF6B6B",
  favRedLight: "#FFF0F0",
};

export interface FavoriteListItemData {
  id: string;
  recipeName: string;
  recipeUuid: string | null;
  likedAt: string;
}

export interface FavoriteListItemProps {
  item: FavoriteListItemData;
  isRemoving: boolean;
  onOpen: () => void;
  onRemove: () => void;
  formatDate: (iso: string) => string;
}

/**
 * お気に入り一覧の1行。
 *
 * #1050 round-2 (Opus 発見の Must 指摘): 以前はこの行全体が role="button" の
 * 疑似ボタンで、内側に本物の <button>（削除）をネストしていた。
 * このネスト自体が無効な ARIA 構造な上、行の onKeyDown が e.target と
 * e.currentTarget を区別せず、削除ボタンにフォーカスして Enter/Space を押すと
 * 行側の e.preventDefault() が削除ボタンのネイティブ活性化（click 合成）を
 * 握りつぶし、代わりに行のハンドラ (onOpen) が実行されてキーボードで
 * 削除できなくなっていた（マウスクリックは削除ボタン側の e.stopPropagation() で
 * 無傷だった）。
 *
 * ネイティブ <button> 2つを兄弟として並べることで、キーボードの Enter/Space
 * 活性化をブラウザ標準の挙動に委ね、独自の onKeyDown や interactive のネストを
 * 完全に無くした。テスト容易性のため独立コンポーネントとして切り出している
 * （src/app/(main)/favorites/_components/__tests__/FavoriteListItem.test.ts）。
 */
export function FavoriteListItem({
  item,
  isRemoving,
  onOpen,
  onRemove,
  formatDate,
}: FavoriteListItemProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.2 }}
      style={{
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderRadius: 16,
        padding: "14px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${item.recipeName} のレシピを見る`}
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 12,
          background: "none",
          border: "none",
          padding: 0,
          margin: 0,
          textAlign: "left",
          cursor: "pointer",
          font: "inherit",
          color: "inherit",
        }}
      >
        {/* Icon */}
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: colors.favRedLight,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Utensils size={20} color={colors.favRed} />
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              fontWeight: 600,
              fontSize: 15,
              color: colors.text,
              margin: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.recipeName}
          </p>
          <p
            style={{
              fontSize: 12,
              color: colors.textMuted,
              margin: "2px 0 0",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Clock size={11} />
            {formatDate(item.likedAt)} に追加
          </p>
        </div>
      </button>

      {/* Remove button */}
      <button
        type="button"
        onClick={onRemove}
        disabled={isRemoving}
        aria-label="お気に入りから削除"
        style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: isRemoving ? colors.bg : colors.favRedLight,
          border: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: isRemoving ? "default" : "pointer",
          flexShrink: 0,
          transition: "opacity 0.2s",
          opacity: isRemoving ? 0.5 : 1,
        }}
      >
        <Heart size={16} color={colors.favRed} fill={isRemoving ? "none" : colors.favRed} />
      </button>
    </motion.div>
  );
}
