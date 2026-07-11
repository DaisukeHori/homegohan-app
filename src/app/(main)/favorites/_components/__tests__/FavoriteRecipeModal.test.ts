// src/app/(main)/favorites/_components/__tests__/FavoriteRecipeModal.test.ts
// #1050 (UX2-06) 回帰防止: お気に入りページからレシピの中身を開けない問題の修正を検証する。
//
// NOTE: このリポジトリの vitest 設定は tsconfig の jsx:"preserve" と非互換のため、
// 既存の modal-contracts.test.ts に倣い拡張子 .ts + React.createElement で JSX 構文を回避する。

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { FavoriteRecipeModal } from '../FavoriteRecipeModal';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
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
  document.body.style.overflow = '';
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('FavoriteRecipeModal: 表示制御', () => {
  it('favorite が null のときは何も描画しない', () => {
    act(() => {
      root.render(h(FavoriteRecipeModal, { isOpen: true, favorite: null, onClose: () => {} }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isOpen=false のときは何も描画しない', () => {
    act(() => {
      root.render(
        h(FavoriteRecipeModal, {
          isOpen: false,
          favorite: { id: 'f1', recipeName: '肉じゃが', recipeUuid: 'r1' },
          onClose: () => {},
        })
      );
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('FavoriteRecipeModal: recipeUuid が無い場合 (#1050 UX2-06)', () => {
  it('recipeUuid が null のときはフェッチせず「詳細情報が保存されていません」を表示する', async () => {
    act(() => {
      root.render(
        h(FavoriteRecipeModal, {
          isOpen: true,
          favorite: { id: 'f1', recipeName: '肉じゃが', recipeUuid: null },
          onClose: () => {},
        })
      );
    });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="favorite-recipe-no-uuid"]')).not.toBeNull();
    expect(container.textContent).toContain('詳細情報を保存していない');
  });
});

describe('FavoriteRecipeModal: レシピ詳細の取得成功 (#1050 UX2-06)', () => {
  it('recipeUuid があると /api/recipes/{uuid} をフェッチし、材料・作り方を表示する', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        recipe: {
          id: 'r1',
          name: '肉じゃが',
          description: 'ほっとする和食',
          caloriesKcal: 350,
          cookingTimeMinutes: 30,
          servings: 2,
          ingredients: ['じゃがいも 3個', '牛肉 200g'],
          steps: ['じゃがいもを切る', '炒める', '煮込む'],
        },
      }),
    });

    act(() => {
      root.render(
        h(FavoriteRecipeModal, {
          isOpen: true,
          favorite: { id: 'f1', recipeName: '肉じゃが', recipeUuid: 'r1' },
          onClose: () => {},
        })
      );
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/recipes/r1');
    expect(container.textContent).toContain('じゃがいも');
    expect(container.textContent).toContain('炒める');
    expect(container.querySelector('[data-testid="favorite-recipe-add-to-shopping-list"]')).not.toBeNull();
  });

  it('「材料を買い物リストに追加」を押すと /api/shopping-list/add-recipe に POST する', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        recipe: {
          id: 'r1',
          name: '肉じゃが',
          description: null,
          caloriesKcal: null,
          cookingTimeMinutes: null,
          servings: null,
          ingredients: ['じゃがいも 3個'],
          steps: [],
        },
      }),
    });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [] }) });

    act(() => {
      root.render(
        h(FavoriteRecipeModal, {
          isOpen: true,
          favorite: { id: 'f1', recipeName: '肉じゃが', recipeUuid: 'r1' },
          onClose: () => {},
        })
      );
    });
    await flush();

    const addButton = container.querySelector(
      '[data-testid="favorite-recipe-add-to-shopping-list"]'
    ) as HTMLButtonElement;
    expect(addButton).not.toBeNull();

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall[0]).toBe('/api/shopping-list/add-recipe');
    expect(secondCall[1]?.method).toBe('POST');
    const body = JSON.parse(secondCall[1]!.body as string);
    expect(body.ingredients).toEqual([{ name: 'じゃがいも', amount: '3個' }]);
  });
});

describe('FavoriteRecipeModal: 取得失敗時の再試行 (#1050 UX2-06)', () => {
  it('res.ok=false のときはエラー表示になり、再試行ボタンで再フェッチする', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    act(() => {
      root.render(
        h(FavoriteRecipeModal, {
          isOpen: true,
          favorite: { id: 'f1', recipeName: '肉じゃが', recipeUuid: 'r1' },
          onClose: () => {},
        })
      );
    });
    await flush();

    expect(container.querySelector('[data-testid="favorite-recipe-error"]')).not.toBeNull();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        recipe: {
          id: 'r1',
          name: '肉じゃが',
          description: null,
          caloriesKcal: null,
          cookingTimeMinutes: null,
          servings: null,
          ingredients: [],
          steps: [],
        },
      }),
    });

    const retryButton = container.querySelector('[data-testid="favorite-recipe-retry"]') as HTMLButtonElement;
    expect(retryButton).not.toBeNull();
    await act(async () => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="favorite-recipe-error"]')).toBeNull();
  });

  it('404 のときは「見つかりませんでした」を表示する', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });

    act(() => {
      root.render(
        h(FavoriteRecipeModal, {
          isOpen: true,
          favorite: { id: 'f1', recipeName: '肉じゃが', recipeUuid: 'r1' },
          onClose: () => {},
        })
      );
    });
    await flush();

    expect(container.querySelector('[data-testid="favorite-recipe-not-found"]')).not.toBeNull();
  });
});
