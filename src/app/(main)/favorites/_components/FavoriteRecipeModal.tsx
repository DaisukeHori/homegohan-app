"use client";

// src/app/(main)/favorites/_components/FavoriteRecipeModal.tsx
// #1050 (UX2-06): お気に入りページから recipeUuid を保持しているのに未使用で、
// できるのは削除だけだった問題への対応。タップで材料・作り方・買い物追加ができる
// レシピ詳細を表示する。
//
// NOTE: recipe_uuid は `/api/recipes/[id]/like` (POST) 等の現行の「いいね」導線からは
// 一度も書き込まれておらず、実データ上はほぼ常に null になる（コードベース全体を grep して
// 確認済み・書き込み経路が無い）。そのため多くのお気に入りでは詳細を取得できず、その場合は
// 「詳細情報が保存されていません」という正直な空状態を表示する（存在しないデータを捏造しない）。
// recipeUuid が付与されている場合は `/api/recipes/{uuid}` から実際のレシピ詳細を取得して表示する。

import React, { useEffect, useState } from "react";
import { BookOpen, ShoppingCart, RefreshCw, AlertTriangle } from "lucide-react";
import { BottomSheet } from "@/components/common/BottomSheet";

const colors = {
  bg: "#F7F6F3",
  card: "#FFFFFF",
  text: "#2D2D2D",
  textLight: "#6B6B6B",
  textMuted: "#A0A0A0",
  accent: "#E07A5F",
  accentLight: "#FDF0ED",
  border: "#E8E6E1",
  danger: "#D64545",
  dangerLight: "#FDECEC",
};

export interface FavoriteRecipeModalItem {
  id: string;
  recipeName: string;
  recipeUuid: string | null;
}

interface RecipeDetail {
  id: string;
  name: string;
  description: string | null;
  caloriesKcal: number | null;
  cookingTimeMinutes: number | null;
  servings: number | null;
  ingredients: unknown;
  steps: string[] | null;
}

type LoadStatus = "loading" | "loaded" | "error" | "no-uuid" | "not-found";

/**
 * recipes.ingredients (Json 型) を { name, amount } の配列に正規化する。
 * 文字列配列（例: "卵 2個"）とオブジェクト配列（{name, amount}）の両方を許容する。
 */
function normalizeIngredients(raw: unknown): { name: string; amount?: string }[] {
  if (!Array.isArray(raw)) return [];
  const results: { name: string; amount?: string }[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (!trimmed) continue;
      // 末尾の分量表記を分離できるものだけ分離し、できなければ全体を name とする
      const match = trimmed.match(/^(.+?)\s+([\d０-９].*)$/);
      if (match) {
        results.push({ name: match[1].trim(), amount: match[2].trim() });
      } else {
        results.push({ name: trimmed });
      }
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const name = typeof obj.name === "string" ? obj.name : null;
      if (!name) continue;
      const amount = typeof obj.amount === "string" ? obj.amount : undefined;
      results.push({ name, amount });
    }
  }
  return results;
}

interface FavoriteRecipeModalProps {
  isOpen: boolean;
  favorite: FavoriteRecipeModalItem | null;
  onClose: () => void;
}

export function FavoriteRecipeModal({ isOpen, favorite, onClose }: FavoriteRecipeModalProps) {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [recipe, setRecipe] = useState<RecipeDetail | null>(null);
  const [isAddingToShoppingList, setIsAddingToShoppingList] = useState(false);
  const [addResultMessage, setAddResultMessage] = useState<string | null>(null);
  // fetchTrigger を変えることで「再試行」ボタンから再フェッチできるようにする
  const [fetchTrigger, setFetchTrigger] = useState(0);

  const recipeUuid = favorite?.recipeUuid ?? null;

  useEffect(() => {
    if (!isOpen || !favorite) return;
    setAddResultMessage(null);

    if (!recipeUuid) {
      setStatus("no-uuid");
      setRecipe(null);
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setRecipe(null);

    (async () => {
      try {
        const res = await fetch(`/api/recipes/${encodeURIComponent(recipeUuid)}`);
        if (cancelled) return;
        if (res.status === 404) {
          setStatus("not-found");
          return;
        }
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (!data?.recipe) {
          setStatus("error");
          return;
        }
        setRecipe(data.recipe);
        setStatus("loaded");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, favorite?.id, recipeUuid, fetchTrigger]);

  const handleAddToShoppingList = async () => {
    if (!recipe) return;
    const ingredients = normalizeIngredients(recipe.ingredients);
    if (ingredients.length === 0) {
      setAddResultMessage("材料情報がありません");
      return;
    }
    setIsAddingToShoppingList(true);
    setAddResultMessage(null);
    try {
      const res = await fetch("/api/shopping-list/add-recipe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ingredients }),
      });
      if (res.ok) {
        setAddResultMessage(`${ingredients.length}件の材料を買い物リストに追加しました`);
      } else {
        setAddResultMessage("買い物リストへの追加に失敗しました");
      }
    } catch {
      setAddResultMessage("買い物リストへの追加に失敗しました");
    } finally {
      setIsAddingToShoppingList(false);
    }
  };

  if (!favorite) return null;

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      position="bottom"
      ariaLabelledBy="favorite-recipe-modal-title"
      overlayClassName="z-[210]"
      panelClassName="w-full lg:max-w-lg max-h-[85vh] rounded-t-3xl lg:rounded-3xl overflow-hidden flex flex-col"
      panelStyle={{ background: colors.card }}
      testId="favorite-recipe-modal"
    >
      <div className="flex justify-between items-center px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex items-center gap-2 min-w-0">
          <BookOpen size={18} color={colors.accent} />
          <span id="favorite-recipe-modal-title" style={{ fontSize: 15, fontWeight: 600 }} className="truncate">
            {favorite.recipeName}
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="閉じる"
          className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: colors.bg }}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <div className="flex-1 min-h-0 p-4 overflow-y-auto">
        {status === "loading" && (
          <div className="flex items-center gap-2 py-8 justify-center" data-testid="favorite-recipe-loading">
            <RefreshCw size={16} className="animate-spin" color={colors.textMuted} />
            <span style={{ fontSize: 13, color: colors.textMuted }}>読み込み中...</span>
          </div>
        )}

        {status === "no-uuid" && (
          <div className="flex flex-col items-center gap-2 py-8 text-center" data-testid="favorite-recipe-no-uuid">
            <AlertTriangle size={24} color={colors.textMuted} />
            <p style={{ fontSize: 13, color: colors.textMuted }}>
              このお気に入りはレシピの詳細情報を保存していないため、内容を表示できません。
            </p>
          </div>
        )}

        {status === "not-found" && (
          <div className="flex flex-col items-center gap-3 py-8 text-center" data-testid="favorite-recipe-not-found">
            <AlertTriangle size={24} color={colors.textMuted} />
            <p style={{ fontSize: 13, color: colors.textMuted }}>
              レシピが見つかりませんでした（削除された可能性があります）。
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="flex flex-col items-center gap-3 py-8 text-center" data-testid="favorite-recipe-error">
            <AlertTriangle size={24} color={colors.danger} />
            <p style={{ fontSize: 13, color: colors.textMuted }}>
              レシピの詳細を取得できませんでした。
            </p>
            <button
              data-testid="favorite-recipe-retry"
              onClick={() => setFetchTrigger((v) => v + 1)}
              className="px-4 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5"
              style={{ background: colors.accent, color: "#fff" }}
            >
              <RefreshCw size={12} />
              再試行
            </button>
          </div>
        )}

        {status === "loaded" && recipe && (
          <>
            {recipe.description && (
              <p style={{ fontSize: 13, color: colors.textLight, marginBottom: 12 }}>{recipe.description}</p>
            )}
            <div className="flex flex-wrap gap-3 mb-4" style={{ fontSize: 12, color: colors.textLight }}>
              {recipe.caloriesKcal != null && <span>{recipe.caloriesKcal}kcal</span>}
              {recipe.cookingTimeMinutes != null && <span>{recipe.cookingTimeMinutes}分</span>}
              {recipe.servings != null && <span>{recipe.servings}人分</span>}
            </div>

            <p style={{ fontSize: 13, fontWeight: 600, color: colors.text, margin: "0 0 8px" }}>🥕 材料</p>
            <div className="rounded-xl p-3 mb-4" style={{ background: colors.bg }}>
              {(() => {
                const ingredients = normalizeIngredients(recipe.ingredients);
                if (ingredients.length === 0) {
                  return <p style={{ fontSize: 13, color: colors.textMuted }}>材料情報なし</p>;
                }
                return (
                  <ul style={{ fontSize: 13, color: colors.text, margin: 0, paddingLeft: 18 }}>
                    {ingredients.map((ing, i) => (
                      <li key={i}>
                        {ing.name}
                        {ing.amount ? ` ${ing.amount}` : ""}
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </div>

            <p style={{ fontSize: 13, fontWeight: 600, color: colors.text, margin: "0 0 8px" }}>👨‍🍳 作り方</p>
            <div className="rounded-xl p-3" style={{ background: colors.bg }}>
              {recipe.steps && recipe.steps.length > 0 ? (
                <ol style={{ fontSize: 13, color: colors.text, margin: 0, paddingLeft: 18 }}>
                  {recipe.steps.map((step, i) => (
                    <li key={i} style={{ marginBottom: 8 }}>
                      {step.replace(/^\d+\.\s*/, "")}
                    </li>
                  ))}
                </ol>
              ) : (
                <p style={{ fontSize: 13, color: colors.textMuted }}>作り方情報なし</p>
              )}
            </div>
          </>
        )}
      </div>

      {status === "loaded" && recipe && (
        <div className="px-4 py-3 flex-shrink-0" style={{ borderTop: `1px solid ${colors.border}` }}>
          {addResultMessage && (
            <p style={{ fontSize: 12, color: colors.textLight, marginBottom: 8 }}>{addResultMessage}</p>
          )}
          <button
            data-testid="favorite-recipe-add-to-shopping-list"
            onClick={handleAddToShoppingList}
            disabled={isAddingToShoppingList}
            className="w-full p-3 rounded-xl font-semibold text-[14px] flex items-center justify-center gap-2 disabled:opacity-60"
            style={{ background: colors.accent, color: "#fff" }}
          >
            <ShoppingCart size={18} />
            {isAddingToShoppingList ? "追加中..." : "材料を買い物リストに追加"}
          </button>
        </div>
      )}
    </BottomSheet>
  );
}
