// src/app/(main)/favorites/_components/__tests__/FavoriteRecipeModal.test.ts
// #2011 (docs/design/cross/22-dish-favorites.md §7.12): お気に入りの詳細は、一覧の 1 件 (DishFavorite) が持つ
// 料理の写しを献立の RecipeModal で描く (問い合わせない)。♥ は塗り固定で、押すと onRemove。
// RecipeModal は幕を持たないので、FavoriteRecipeModal が幕 (favorite-recipe-backdrop) を兄弟として描く。
//
// 以前 (#1050 UX2-06) は recipe_uuid があるときだけ /api/recipes/{uuid} を取っていた。その検査 (uuid 無し・取得成功・再試行) は
// 取得そのものが無くなったので、ここでは RecipeModal に渡す props と幕と買い物リストの追加を見る。
//
// NOTE: このリポジトリの vitest 設定は tsconfig の jsx:"preserve" と非互換のため、
// 既存の modal-contracts.test.ts に倣い拡張子 .ts + React.createElement で JSX 構文を回避する。
// RecipeModal は props を記録する偽物にする (framer-motion のパネル・focus-trap を描かない)。幕は本物 (motion.div)。

import React, { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import {
  DishSnapshotSchema,
  ingredientInputsOf,
  recipeModalDataOf,
  type DishFavorite,
} from '@/modules/dish-favorites/core';

const recipeModalCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@/app/(main)/menus/weekly/_components/modals/RecipeModal', () => ({
  RecipeModal: (props: Record<string, unknown>) => {
    recipeModalCalls.push(props);
    return null;
  },
}));

import { FavoriteRecipeModal, type FavoriteRecipeModalProps } from '../FavoriteRecipeModal';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

const FAVORITE: DishFavorite = {
  id: '22222222-2222-4222-8222-222222222222',
  dish_name: '肉じゃが',
  dish: DishSnapshotSchema.parse({
    name: '肉じゃが',
    role: 'main',
    calories_kcal: 420,
    protein_g: 18,
    ingredients: ['じゃがいも 200g', { name: '牛肉', amount_g: 150, note: '薄切り' }],
    recipe_steps: ['材料を切る', '煮る'],
  }),
  source_planned_meal_id: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};

const FAVORITE_WITHOUT_INGREDIENTS: DishFavorite = {
  ...FAVORITE,
  id: '33333333-3333-4333-8333-333333333333',
  dish: DishSnapshotSchema.parse({ name: '肉じゃが' }),
};

function render(overrides: Partial<FavoriteRecipeModalProps> = {}) {
  const props: FavoriteRecipeModalProps = {
    isOpen: true,
    favorite: FAVORITE,
    isRemoving: false,
    onRemove: vi.fn(),
    onNotice: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  act(() => {
    root.render(h(FavoriteRecipeModal, props));
  });
  return props;
}

function lastRecipeModalProps(): Record<string, unknown> {
  const last = recipeModalCalls[recipeModalCalls.length - 1];
  expect(last, 'RecipeModal が描かれていません').toBeDefined();
  return last;
}

function backdrop(): HTMLElement | null {
  return container.querySelector('[data-testid="favorite-recipe-backdrop"]');
}

async function flush() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  recipeModalCalls.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('FavoriteRecipeModal (料理の写しを献立の RecipeModal で描く。#2011)', () => {
  it('M-1「favorite が null・isOpen=false のときは RecipeModal も幕 (favorite-recipe-backdrop) も描かない」', () => {
    render({ favorite: null });
    expect(recipeModalCalls).toHaveLength(0);
    expect(backdrop()).toBeNull();

    render({ isOpen: false });
    expect(recipeModalCalls).toHaveLength(0);
    expect(backdrop()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('M-2「RecipeModal に dish_name・recipeModalDataOf(favorite)・isFavorite=true・isFavoriteLoading=isRemoving を渡す」', () => {
    render({ isRemoving: false });
    let props = lastRecipeModalProps();
    expect(props.selectedRecipe).toBe('肉じゃが');
    expect(props.selectedRecipeData).toEqual(recipeModalDataOf(FAVORITE));
    expect(props.isFavorite).toBe(true);
    expect(props.isFavoriteLoading).toBe(false);

    render({ isRemoving: true });
    props = lastRecipeModalProps();
    expect(props.isFavorite).toBe(true);
    expect(props.isFavoriteLoading).toBe(true);
    // 詳細は問い合わせずに描く
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('M-3「onToggleFavorite が onRemove を呼ぶ」', () => {
    const { onRemove, onClose } = render();
    const props = lastRecipeModalProps();
    act(() => {
      (props.onToggleFavorite as () => void)();
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('M-4「材料を買い物リストに追加は ingredientInputsOf の形で /api/shopping-list/add-recipe に POST し、結果を onNotice に渡す (成功 / 失敗 / 材料なし)」', async () => {
    const expectedIngredients = ingredientInputsOf(FAVORITE.dish.ingredients);
    expect(expectedIngredients).toEqual([
      { name: 'じゃがいも', amount: '200g' },
      { name: '牛肉', amount: '150g' },
    ]);

    // 成功
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const { onNotice } = render();
    act(() => {
      (lastRecipeModalProps().onAddToShoppingList as () => void)();
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/shopping-list/add-recipe');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ ingredients: expectedIngredients });
    expect(onNotice).toHaveBeenLastCalledWith('2件の材料を買い物リストに追加しました');

    // 失敗 (サーバーの失敗と、届かない例外の両方)
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    act(() => {
      (lastRecipeModalProps().onAddToShoppingList as () => void)();
    });
    await flush();
    expect(onNotice).toHaveBeenLastCalledWith('買い物リストへの追加に失敗しました');

    fetchMock.mockRejectedValueOnce(new Error('network'));
    act(() => {
      (lastRecipeModalProps().onAddToShoppingList as () => void)();
    });
    await flush();
    expect(onNotice).toHaveBeenLastCalledWith('買い物リストへの追加に失敗しました');
    expect(onNotice).toHaveBeenCalledTimes(3);

    // 材料なし: 送らずに知らせる
    fetchMock.mockClear();
    const noIngredients = render({ favorite: FAVORITE_WITHOUT_INGREDIENTS });
    act(() => {
      (lastRecipeModalProps().onAddToShoppingList as () => void)();
    });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(noIngredients.onNotice).toHaveBeenCalledWith('材料情報がありません');
  });

  it('M-5「開いているときは RecipeModal の後ろに幕 (favorite-recipe-backdrop・fixed inset-0 z-[200]) を描き、幕を押すと onClose を 1 回呼ぶ (onRemove は呼ばない)」', () => {
    const { onClose, onRemove } = render();
    const el = backdrop();
    expect(el, '幕が描かれていません').not.toBeNull();
    const classes = (el as HTMLElement).className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['fixed', 'inset-0', 'z-[200]']));
    // RecipeModal も同時に描かれている (幕はその兄弟)
    expect(recipeModalCalls.length).toBeGreaterThan(0);

    act(() => {
      (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
  });
});
