// src/__tests__/app/menus/weekly/state/recipeReducer.test.ts
// #2011 (docs/design/cross/22-dish-favorites.md §7.8): 献立の料理のモーダルの ♥ の状態 (isFavorite) と
// 保存済みのお気に入りの id (favoriteId) の扱い。
// 料理が変わったとき (別の名前・閉じる (null)) は両方を未取得に戻し、同じ名前を選び直したとき
// (買い物リストに足してモーダルが閉じ、selectedRecipe が残ったまま同じ料理を開く) は両方を保つ。

import { describe, it, expect } from 'vitest';
import {
  recipeReducer,
  initialRecipeState,
  type RecipeState,
} from '@/app/(main)/menus/weekly/_state/reducers/recipeReducer';

const FAVORITE_ID = '11111111-1111-4111-8111-111111111111';

/** 「肉じゃが」を開いていて、保存済み (♥ が塗り・id あり) の状態 */
const favoritedNikujaga: RecipeState = {
  ...initialRecipeState,
  selectedRecipe: '肉じゃが',
  isFavorite: true,
  favoriteId: FAVORITE_ID,
};

describe('recipeReducer (♥ の状態と favoriteId。#2011)', () => {
  it('R-1「RECIPE_SELECT で別の料理を選ぶと isFavorite は false・favoriteId は null に戻る」', () => {
    const next = recipeReducer(favoritedNikujaga, { type: 'RECIPE_SELECT', payload: '親子丼' });
    expect(next.selectedRecipe).toBe('親子丼');
    expect(next.isFavorite).toBe(false);
    expect(next.favoriteId).toBeNull();
  });

  it('R-2「RECIPE_SELECT で今と同じ料理を選び直すと isFavorite と favoriteId を保つ (買い物リストの追加で閉じたあとの開き直し)」', () => {
    const next = recipeReducer(favoritedNikujaga, { type: 'RECIPE_SELECT', payload: '肉じゃが' });
    expect(next.selectedRecipe).toBe('肉じゃが');
    expect(next.isFavorite).toBe(true);
    expect(next.favoriteId).toBe(FAVORITE_ID);
  });

  it('R-3「RECIPE_SELECT null で isFavorite は false・favoriteId は null に戻る」', () => {
    const next = recipeReducer(favoritedNikujaga, { type: 'RECIPE_SELECT', payload: null });
    expect(next.selectedRecipe).toBeNull();
    expect(next.isFavorite).toBe(false);
    expect(next.favoriteId).toBeNull();
  });

  it('R-4「FAVORITE_ID_SET は favoriteId だけを変え、RECIPE_RESET は favoriteId を null に戻す」', () => {
    const before: RecipeState = { ...initialRecipeState, selectedRecipe: '肉じゃが', isFavorite: true, isFavoriteLoading: true };
    const set = recipeReducer(before, { type: 'FAVORITE_ID_SET', payload: FAVORITE_ID });
    expect(set).toEqual({ ...before, favoriteId: FAVORITE_ID });

    const cleared = recipeReducer(set, { type: 'FAVORITE_ID_SET', payload: null });
    expect(cleared).toEqual({ ...before, favoriteId: null });

    const reset = recipeReducer(set, { type: 'RECIPE_RESET' });
    expect(reset).toEqual(initialRecipeState);
    expect(reset.favoriteId).toBeNull();
  });
});
