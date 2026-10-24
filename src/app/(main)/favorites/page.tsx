"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Heart, Search, X, ChevronLeft, RefreshCw, SortAsc } from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { FavoriteRecipeModal } from "./_components/FavoriteRecipeModal";
import { FavoriteListItem } from "./_components/FavoriteListItem";
import { DISH_FAVORITES_PAGE_SIZE, type DishFavorite, type DishFavoriteSort } from "@/modules/dish-favorites/core";

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

// 一覧の 1 件は献立の料理の写し (dish_favorites。docs/design/cross/22-dish-favorites.md §7.10)
type FavoriteItem = DishFavorite;
type SortOption = DishFavoriteSort;
const PAGE_SIZE = DISH_FAVORITES_PAGE_SIZE;
/** 知らせ (買い物リストの結果) を消すまでの時間 (ミリ秒)。読める長さで、次の操作の邪魔にならない程度 */
const NOTICE_HIDE_MS = 3000;

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
  // UX2-06 / #2011: タップでレシピ詳細（材料・作り方・栄養・買い物追加）を表示する。
  // 詳細は一覧の 1 件 (DishFavorite) が持つ料理の写しで描く (問い合わせない)。
  // selectedFavorite は閉じるアニメーション中も内容を保持するため isRecipeModalOpen とは
  // 別の state にしている（isRecipeModalOpen=false で閉じアニメーションのみ発火させる）。
  const [selectedFavorite, setSelectedFavorite] = useState<FavoriteItem | null>(null);
  const [isRecipeModalOpen, setIsRecipeModalOpen] = useState(false);
  /** 買い物リストに足したときの知らせ (RecipeModal には文を出す場所が無いので、画面の下に短く出す。#2011) */
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_HIDE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  /**
   * 詳細がいま出している行の id (閉じていれば null)。削除の応答の時点で読む。
   * handleRemove の閉包の selectedFavorite は押した時点の値なので、それで比べると、
   * 応答の前に詳細を閉じて別の行を開いたとき、その別の行の詳細を閉じてしまう (#2011)
   */
  const openFavoriteIdRef = useRef<string | null>(null);
  // 詳細を開く・閉じるは openRecipeDetail・closeRecipeDetail だけが行う
  const openRecipeDetail = (item: FavoriteItem) => {
    openFavoriteIdRef.current = item.id;
    setSelectedFavorite(item);
    setIsRecipeModalOpen(true);
  };
  /** selectedFavorite は閉じるアニメーションの間も中身を保つため残す */
  const closeRecipeDetail = () => {
    openFavoriteIdRef.current = null;
    setIsRecipeModalOpen(false);
  };

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  /** 応答待ちの一覧の GET の本数 (最初の読み込み・取り直し・次のページ)。0 でない間は handleRemove が何も送らない */
  const fetchesInFlightRef = useRef(0);
  /**
   * 応答待ちの削除 (handleRemove の後始末 (一覧・total・offset) が済むと解ける Promise。無ければ null)。
   * 一覧の GET はこれを待ってから送る。先に送ると、消す前の一覧が後から届いて消した行が戻ったり、
   * 消したあとの一覧に削除の後始末が重なって total と offset が 1 ずつずれたりする
   */
  const removalRef = useRef<Promise<void> | null>(null);
  /**
   * 一覧 (favorites) の写し。一覧を変える 3 か所 (取り直し・次のページ・削除) で state と同じ配列を同時に入れる。
   * 削除の応答で「消した行が読み込んだ一覧にあったか」を描画を待たずに読む (詳細だけが出していた行は一覧に無いことがある)
   */
  const favoritesRef = useRef<FavoriteItem[]>([]);
  const fetchFavorites = useCallback(async (nextOffset = 0) => {
    fetchesInFlightRef.current += 1;
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
      // 待つのは取り直し (nextOffset 0) だけになる: 次のページは削除の応答待ちの間に押せない (「次の50件を表示」の disabled)。
      // 取り直しの応答は一覧・total・offset を置き換えるので、削除の後始末のあとに届けば正しい
      const pendingRemoval = removalRef.current;
      if (pendingRemoval) await pendingRemoval;
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset), sort });
      if (debouncedQuery) params.set("q", debouncedQuery);
      const res = await fetch(`/api/favorites?${params}`);
      if (!res.ok) throw new Error("Failed to fetch favorites");
      const data = await res.json();
      const fetched: FavoriteItem[] = data.favorites ?? [];
      const nextFavorites = nextOffset === 0 ? fetched : [...favoritesRef.current, ...fetched];
      favoritesRef.current = nextFavorites;
      setFavorites(nextFavorites);
      setTotal(data.total ?? 0);
      setOffset(nextOffset + fetched.length);
      setHasMore(fetched.length === PAGE_SIZE);
    } catch (err) {
      console.error(err);
    } finally {
      fetchesInFlightRef.current -= 1;
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

  // お気に入りから消す (id の DELETE /api/favorites/{id})。200 と 404 (もう無い) のとき:
  //   - 消した行が読み込んだ一覧にあれば、一覧から外し、total と offset を 1 ずつ戻す。offset は次のページの GET の offset で、
  //     サーバーでは消した行の後ろが 1 つ前に詰まるので、戻さないと「次の50件を表示」で次のページの先頭の 1 行が読まれない
  //   - 一覧に無ければ (詳細を開いたあとに検索語が確定して一覧が置き換わり、詳細だけが出していた行)、一覧と offset は
  //     そのまま。total に入っていたかは分からないので 1 ページ目から読み直す。
  //     読み直しが既に削除の応答を待っていれば (fetchesInFlightRef が 0 でない)、それが最新の検索語と並びで読むので足さない
  //   詳細がいま消した行を出しているときだけ閉じる (応答の時点の openFavoriteIdRef で比べる)。
  //   削除の応答待ち (removingId) と一覧の GET の応答待ち (fetchesInFlightRef) の間は何も送らない
  const handleRemove = async (item: FavoriteItem) => {
    if (removingId || fetchesInFlightRef.current > 0) return;
    setRemovingId(item.id);
    let settleRemoval = () => {};
    removalRef.current = new Promise<void>((resolve) => {
      settleRemoval = () => resolve();
    });
    try {
      const res = await fetch(`/api/favorites/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      if (res.ok || res.status === 404) {
        const remaining = favoritesRef.current.filter((f) => f.id !== item.id);
        if (remaining.length < favoritesRef.current.length) {
          favoritesRef.current = remaining;
          setFavorites(remaining);
          setTotal((prev) => Math.max(0, prev - 1));
          setOffset((prev) => Math.max(0, prev - 1));
        } else if (fetchesInFlightRef.current === 0) {
          // この fetchFavorites は押した時点の検索語と並びのもの。そのあとに変わっていれば effect の読み直しが
          // removalRef を待っている (fetchesInFlightRef が 0 でない) のでここには来ない。送るのは finally で removalRef が解けてから
          void fetchFavorites(0);
        }
        if (openFavoriteIdRef.current === item.id) closeRecipeDetail();
      }
    } catch (err) {
      console.error(err);
    } finally {
      // 後始末 (上の set*) のあとで解く。待っている取り直しの GET はここから送られる
      removalRef.current = null;
      settleRemoval();
      setRemovingId(null);
    }
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
                  // 削除の応答待ちの間も押せない (offset が削除の後始末で 1 戻る前の値で GET が出て、次のページの先頭の 1 行が読まれないため)
                  disabled={loadingMore || removingId !== null}
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

      {/* UX2-06 / #2011: レシピ詳細（材料・作り方・栄養・買い物追加）。料理の写しを献立のモーダルで描く */}
      {/*
        isRemoving はどの行の削除の応答待ちでも true (handleRemove は応答待ちの間の 2 本目を黙って捨てるので、♥ の disabled をそれに合わせる)。
        onRemove は押した時点の openFavoriteIdRef を読み、詳細がいま selectedFavorite を出していなければ何もしない
        (閉じる途中のパネルは最後に開いていたときの props のまま押せるので、閉じる途中に 2 回押して DELETE が 2 本出ないように)
      */}
      <FavoriteRecipeModal
        isOpen={isRecipeModalOpen}
        favorite={selectedFavorite}
        isRemoving={removingId !== null}
        onRemove={() => {
          if (!selectedFavorite || openFavoriteIdRef.current !== selectedFavorite.id) return;
          void handleRemove(selectedFavorite);
        }}
        onNotice={setNotice}
        onClose={closeRecipeDetail}
      />
      {notice && (
        <div role="status" style={{ position: "fixed", left: 16, right: 16, bottom: 96, padding: "10px 14px", borderRadius: 12, background: colors.text, color: colors.card, fontSize: 13, zIndex: 300, pointerEvents: "none" }}>
          {notice}
        </div>
      )}
    </div>
  );
}
