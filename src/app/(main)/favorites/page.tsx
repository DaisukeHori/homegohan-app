"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Heart, Search, X, ChevronLeft, RefreshCw, SortAsc } from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { FavoriteRecipeModal } from "./_components/FavoriteRecipeModal";
import { FavoriteListItem } from "./_components/FavoriteListItem";

// カラーパレット（アプリ共通）
const colors = {
  bg: "#F7F6F3",
  card: "#FFFFFF",
  text: "#2D2D2D",
  textLight: "#6B6B6B",
  textMuted: "#A0A0A0",
  accent: "#E07A5F",
  accentLight: "#FDF0ED",
  border: "#E8E6E1",
  favRed: "#FF6B6B",
  favRedLight: "#FFF0F0",
};

type FavoriteItem = {
  id: string;
  recipeName: string;
  recipeUuid: string | null;
  likedAt: string;
};

type SortOption = "newest" | "oldest" | "name";

const PAGE_SIZE = 50;

export default function FavoritesPage() {
  const router = useRouter();

  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // UX2-19: 検索中は既存リストを残したまま小スピナーのみ表示するための状態（全画面ローディングとは分離）
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // UX2-19: 1キーストロークごとの全画面ローディングを防ぐため、実際の検索実行は300ms debounceする
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState<SortOption>("newest");
  const [removingId, setRemovingId] = useState<string | null>(null);
  // #263: offset-based pagination
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  // 初回フェッチかどうか（初回のみ全画面ローディングを表示し、以降の検索/並び替えは小スピナーに留める）
  const isFirstFetchRef = useRef(true);
  // UX2-06: recipeUuid を保持しているのに未使用で、削除しかできなかった問題への対応。
  // タップでレシピ詳細（材料・作り方・買い物追加）を表示する。
  // selectedFavorite は閉じるアニメーション中も内容を保持するため isRecipeModalOpen とは
  // 別の state にしている（isRecipeModalOpen=false で閉じアニメーションのみ発火させる）。
  const [selectedFavorite, setSelectedFavorite] = useState<FavoriteItem | null>(null);
  const [isRecipeModalOpen, setIsRecipeModalOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchFavorites = useCallback(async (nextOffset = 0) => {
    if (nextOffset === 0) {
      if (isFirstFetchRef.current) {
        setLoading(true);
      } else {
        setIsSearching(true);
      }
    } else {
      setLoadingMore(true);
    }
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset), sort });
      if (debouncedQuery) params.set("q", debouncedQuery);
      const res = await fetch(`/api/favorites?${params}`);
      if (!res.ok) throw new Error("Failed to fetch favorites");
      const data = await res.json();
      const fetched: FavoriteItem[] = data.favorites ?? [];
      if (nextOffset === 0) {
        setFavorites(fetched);
      } else {
        setFavorites((prev) => [...prev, ...fetched]);
      }
      setTotal(data.total ?? 0);
      setOffset(nextOffset + fetched.length);
      setHasMore(fetched.length === PAGE_SIZE);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
      setIsSearching(false);
      isFirstFetchRef.current = false;
    }
  }, [debouncedQuery, sort]);

  useEffect(() => {
    setOffset(0);
    fetchFavorites(0);
  }, [fetchFavorites]);

  const handleRemove = async (item: FavoriteItem) => {
    if (removingId) return;
    setRemovingId(item.id);
    try {
      const encodedName = encodeURIComponent(item.recipeName);
      const res = await fetch(`/api/recipes/${encodedName}/like`, { method: "DELETE" });
      if (res.ok) {
        setFavorites((prev) => prev.filter((f) => f.id !== item.id));
        setTotal((prev) => Math.max(0, prev - 1));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setRemovingId(null);
    }
  };

  const openRecipeDetail = (item: FavoriteItem) => {
    setSelectedFavorite(item);
    setIsRecipeModalOpen(true);
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  };

  return (
    <div
      style={{ minHeight: "100dvh", background: colors.bg, paddingBottom: 80 }}
    >
      {/* Header */}
      <div
        style={{
          background: colors.card,
          borderBottom: `1px solid ${colors.border}`,
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          position: "sticky",
          top: 0,
          zIndex: 50,
        }}
      >
        <button
          onClick={() => router.back()}
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: colors.bg,
            border: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <ChevronLeft size={20} color={colors.textLight} />
        </button>
        <div style={{ flex: 1 }}>
          <h1
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontWeight: 700,
              fontSize: 18,
              color: colors.text,
              margin: 0,
            }}
          >
            <Heart size={20} color={colors.favRed} fill={colors.favRed} />
            お気に入りレシピ
          </h1>
          {!loading && (
            <p style={{ fontSize: 12, color: colors.textMuted, margin: 0 }}>
              {total} 件
            </p>
          )}
        </div>
        <button
          onClick={() => fetchFavorites(0)}
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: colors.bg,
            border: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <RefreshCw size={16} color={colors.textLight} />
        </button>
      </div>

      {/* Search + Sort */}
      <div style={{ padding: "12px 16px", display: "flex", gap: 8 }}>
        {/* Search */}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: colors.card,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: "8px 12px",
          }}
        >
          {isSearching ? (
            <RefreshCw size={16} color={colors.textMuted} style={{ animation: "spin 1s linear infinite" }} />
          ) : (
            <Search size={16} color={colors.textMuted} />
          )}
          <input
            type="text"
            placeholder="レシピ名で検索..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              fontSize: 14,
              color: colors.text,
              background: "transparent",
            }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              <X size={14} color={colors.textMuted} />
            </button>
          )}
        </div>

        {/* Sort */}
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortOption)}
          style={{
            background: colors.card,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: "8px 10px",
            fontSize: 13,
            color: colors.textLight,
            outline: "none",
            cursor: "pointer",
          }}
        >
          <option value="newest">新しい順</option>
          <option value="oldest">古い順</option>
          <option value="name">名前順</option>
        </select>
      </div>

      {/* Content */}
      <div style={{ padding: "0 16px" }}>
        {loading ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              paddingTop: 80,
              gap: 12,
            }}
          >
            <RefreshCw size={24} color={colors.textMuted} style={{ animation: "spin 1s linear infinite" }} />
            <p style={{ color: colors.textMuted, fontSize: 14 }}>読み込み中...</p>
          </div>
        ) : favorites.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              paddingTop: 80,
              gap: 16,
            }}
          >
            <Heart size={48} color={colors.border} />
            <p style={{ color: colors.textMuted, fontSize: 15, textAlign: "center" }}>
              {searchQuery
                ? `「${searchQuery}」に一致するレシピが見つかりませんでした`
                : "お気に入りレシピはまだありません\n週間献立のレシピからハートを押して追加できます"}
            </p>
          </div>
        ) : (
          <AnimatePresence>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {favorites.map((item) => (
                <FavoriteListItem
                  key={item.id}
                  item={item}
                  isRemoving={removingId === item.id}
                  onOpen={() => openRecipeDetail(item)}
                  onRemove={() => handleRemove(item)}
                  formatDate={formatDate}
                />
              ))}

              {/* #263: 次の50件ボタン */}
              {hasMore && (
                <button
                  onClick={() => fetchFavorites(offset)}
                  disabled={loadingMore}
                  style={{
                    marginTop: 8,
                    padding: "12px 16px",
                    width: "100%",
                    borderRadius: 16,
                    border: `1px solid ${colors.border}`,
                    background: colors.card,
                    color: colors.textLight,
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: loadingMore ? "default" : "pointer",
                    opacity: loadingMore ? 0.6 : 1,
                  }}
                >
                  {loadingMore ? "読み込み中..." : "次の50件を表示"}
                </button>
              )}
            </div>
          </AnimatePresence>
        )}
      </div>

      {/* Spin keyframe */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      {/* UX2-06: レシピ詳細（材料・作り方・買い物追加） */}
      <FavoriteRecipeModal
        isOpen={isRecipeModalOpen}
        favorite={selectedFavorite}
        onClose={() => setIsRecipeModalOpen(false)}
      />
    </div>
  );
}
