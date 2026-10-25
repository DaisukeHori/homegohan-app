// src/app/(main)/menus/weekly/_state/recipeShoppingList.ts
// 献立の料理のモーダルの「材料を買い物リストに追加」(page.tsx の addRecipeToShoppingList) の材料の集め方と送り方 (#2023)。
// 料理の材料は 1 行の文字列 (「鶏むね肉 200g」・材料全体の長い 1 行) と構造の形 ({ name, amount_g, note }) の両方がある
// (docs/design/cross/22-dish-favorites.md F-31)。以前は文字列だけを仮定して ing.match(…) を呼び、構造の形の料理で例外になっていた (F-32)。
// 名前と分量への分け方はお気に入りの詳細と同じ ingredientInputsOf (§21 Q-8)。
import {
  ingredientInputsOf,
  menuDishIngredientsOf,
  type DishIngredient,
  type ShoppingIngredientInput,
} from '@/modules/dish-favorites/core';
import type { ShoppingListItem } from '@/types/domain';

/** 送る先 (route の形は変えない。本文は { shoppingListId, ingredients }) */
export const RECIPE_SHOPPING_LIST_ENDPOINT = '/api/shopping-list/add-recipe';

/** 材料が 1 件も無いときの知らせ (setSuccessMessage) */
export const RECIPE_SHOPPING_NO_INGREDIENTS_TITLE = '材料なし';
export const RECIPE_SHOPPING_NO_INGREDIENTS_MESSAGE = '材料情報がありません。「AIで変更」で再生成してください。';
/** 足せたときの知らせ (setSuccessMessage) */
export const RECIPE_SHOPPING_ADDED_TITLE = '買い物リストに追加しました ✓';
export function recipeShoppingAddedMessage(count: number): string {
  return `${count}件の材料を追加しました`;
}
/** 失敗したときの alert の文 (応答に error の文があればそれを出す) */
export const RECIPE_SHOPPING_ADD_FAILED_MESSAGE = '追加に失敗しました';
export function recipeShoppingErrorAlertOf(error: unknown): string {
  return `エラー: ${typeof error === 'string' && error !== '' ? error : RECIPE_SHOPPING_ADD_FAILED_MESSAGE}`;
}

/** 重複の除去の鍵: 文字列は同じ文字列、構造の形は同じ name・amount_g・note (どちらも menuDishIngredientsOf でそろえた後の値) */
function ingredientKeyOf(item: DishIngredient): string {
  return typeof item === 'string' ? JSON.stringify(item) : JSON.stringify([item.name, item.amount_g, item.note]);
}

/**
 * モーダルの料理 (selectedRecipeData) から買い物リストに送る材料を作る。
 * 材料は dishes の各料理の ingredients と、旧形式のフォールバックの直下の ingredients の両方から集める。
 * selectedRecipeData は { ...料理, dishes: [料理] } なので同じ料理の材料の列が 2 回集まる。同じ要素を 1 つにしてから (F-32 の new Set の役目)
 * ingredientInputsOf で名前と分量に分ける。
 */
export function recipeShoppingIngredientsOf(recipeData: Readonly<Record<string, unknown>>): ShoppingIngredientInput[] {
  const collected: DishIngredient[] = [];
  const dishes: unknown = recipeData.dishes;
  if (Array.isArray(dishes)) {
    for (const dish of dishes) {
      if (dish === null || typeof dish !== 'object' || Array.isArray(dish)) continue;
      collected.push(...menuDishIngredientsOf((dish as Readonly<Record<string, unknown>>).ingredients));
    }
  }
  collected.push(...menuDishIngredientsOf(recipeData.ingredients));

  const seen = new Set<string>();
  const unique: DishIngredient[] = [];
  for (const item of collected) {
    const key = ingredientKeyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return ingredientInputsOf(unique);
}

/** 追加の結果 (page.tsx がこれで知らせ・alert・買い物リストの更新を決める) */
export type RecipeShoppingListAddResult =
  | { kind: 'no-ingredients' }
  | { kind: 'added'; count: number; items: ShoppingListItem[] }
  | { kind: 'failed'; alertMessage: string };

/**
 * 材料を集めて POST し、結果を返す。材料が無ければ送らない。
 * 応答が 2xx でも items が配列でなければ失敗として扱う (以前は spread の例外で catch に落ちていたのと同じ文)
 */
export async function addRecipeIngredientsToShoppingList(params: {
  recipeData: Readonly<Record<string, unknown>>;
  shoppingListId: string | undefined;
}): Promise<RecipeShoppingListAddResult> {
  const ingredients = recipeShoppingIngredientsOf(params.recipeData);
  if (ingredients.length === 0) return { kind: 'no-ingredients' };
  try {
    const res = await fetch(RECIPE_SHOPPING_LIST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shoppingListId: params.shoppingListId, ingredients }),
    });
    const data = (await res.json()) as { items?: unknown; error?: unknown } | null;
    if (!res.ok) return { kind: 'failed', alertMessage: recipeShoppingErrorAlertOf(data?.error) };
    if (!Array.isArray(data?.items)) return { kind: 'failed', alertMessage: RECIPE_SHOPPING_ADD_FAILED_MESSAGE };
    return { kind: 'added', count: ingredients.length, items: data.items as ShoppingListItem[] };
  } catch (e) {
    console.error('Add to shopping list error:', e);
    return { kind: 'failed', alertMessage: RECIPE_SHOPPING_ADD_FAILED_MESSAGE };
  }
}
