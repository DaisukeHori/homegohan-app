// src/__tests__/app/menus/weekly/recipe-shopping-list.test.ts
// #2023: 献立の料理のモーダルの「材料を買い物リストに追加」(page.tsx の addRecipeToShoppingList) が、
// 材料が構造の形 ({ name, amount_g, note }) の料理で ing.match(…) の例外になり「追加に失敗しました」を出していた
// (docs/design/cross/22-dish-favorites.md F-31・F-32・§21 Q-8)。
// 材料の集め方と送り方は _state/recipeShoppingList.ts に出し、名前と分量への分け方はお気に入りと同じ ingredientInputsOf を使う。
// ここでは 構造の形・1 行の文字列・混在・空の材料 で、送る本文と画面の文 (成功 / 材料が無い / 失敗) を確かめる。
// page.tsx は巨大なクライアントコンポーネントで全体を描けないので、page がこの関数の結果を画面の文に繋ぐことはソースで見る。

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  addRecipeIngredientsToShoppingList,
  RECIPE_SHOPPING_ADD_FAILED_MESSAGE,
  RECIPE_SHOPPING_ADDED_TITLE,
  RECIPE_SHOPPING_LIST_ENDPOINT,
  RECIPE_SHOPPING_NO_INGREDIENTS_MESSAGE,
  RECIPE_SHOPPING_NO_INGREDIENTS_TITLE,
  recipeShoppingAddedMessage,
  recipeShoppingErrorAlertOf,
  recipeShoppingIngredientsOf,
} from '@/app/(main)/menus/weekly/_state/recipeShoppingList';
import { menuDishIngredientsOf } from '@/modules/dish-favorites/core';

const SHOPPING_LIST_ID = '44444444-4444-4444-8444-444444444444';

/** route が返す items の 1 件 (中身は page がそのまま買い物リストに足すだけ) */
const RETURNED_ITEM = { id: '55555555-5555-4555-8555-555555555555', itemName: '鶏むね肉' };

/** 献立の画面の selectedRecipeData の形: { ...料理, dishes: [料理] } (page.tsx の setSelectedRecipeData) */
function recipeDataOf(dish: Record<string, unknown>): Record<string, unknown> {
  return { ...dish, dishes: [dish], allIngredients: dish.ingredients ?? [] };
}

const STRUCTURED_DISH = {
  name: '鶏むね肉のソテー',
  role: 'main',
  ingredients: [
    { name: '鶏むね肉', amount_g: 200, note: '皮なし' },
    { name: '塩', amount_g: null, note: null },
    { name: 'オリーブオイル', amount_g: 8 },
  ],
};

const STRING_DISH = {
  name: '味噌汁',
  role: 'soup',
  ingredients: ['豆腐 100g', '味噌 少々', 'ねぎ'],
};

let fetchMock: ReturnType<typeof vi.fn>;

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** fetch に渡した本文 (JSON) */
function sentBody(): { shoppingListId?: string; ingredients: Array<{ name: string; amount: string | null }> } {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(RECIPE_SHOPPING_LIST_ENDPOINT);
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('献立の「材料を買い物リストに追加」の本文 (#2023)', () => {
  it('構造の形の材料: 例外にならず { name, amount: "<amount_g>g" } (amount_g が無ければ null・メモは送らない) を 1 回ずつ送り、成功の文は件数を出す', async () => {
    fetchMock.mockResolvedValue(okResponse({ items: [RETURNED_ITEM] }));

    const result = await addRecipeIngredientsToShoppingList({ recipeData: recipeDataOf(STRUCTURED_DISH), shoppingListId: SHOPPING_LIST_ID });

    expect(sentBody()).toEqual({
      shoppingListId: SHOPPING_LIST_ID,
      ingredients: [
        { name: '鶏むね肉', amount: '200g' },
        { name: '塩', amount: null },
        { name: 'オリーブオイル', amount: '8g' },
      ],
    });
    expect(result).toEqual({ kind: 'added', count: 3, items: [RETURNED_ITEM] });
    expect(RECIPE_SHOPPING_ADDED_TITLE).toBe('買い物リストに追加しました ✓');
    expect(recipeShoppingAddedMessage(3)).toBe('3件の材料を追加しました');
  });

  it('1 行の文字列の材料: 以前と同じ正規表現で名前と分量に分け (分けられなければ分量 null)、dishes と直下の 2 回分を 1 回にする', async () => {
    fetchMock.mockResolvedValue(okResponse({ items: [] }));

    const result = await addRecipeIngredientsToShoppingList({ recipeData: recipeDataOf(STRING_DISH), shoppingListId: SHOPPING_LIST_ID });

    expect(sentBody().ingredients).toEqual([
      { name: '豆腐', amount: '100g' },
      { name: '味噌', amount: '少々' },
      { name: 'ねぎ', amount: null },
    ]);
    expect(result).toEqual({ kind: 'added', count: 3, items: [] });
  });

  it('混在: 文字列と構造の形を並びのまま送り、空の文字列・name の無い要素・数・null は捨てる。amount_g の数の文字列は数として読む', async () => {
    fetchMock.mockResolvedValue(okResponse({ items: [] }));
    const dish = {
      name: '親子丼',
      ingredients: [
        '玉ねぎ 1/2個',
        { name: ' 鶏もも肉 ', amount_g: '150', note: 'ひと口大' },
        '   ',
        { name: '   ', amount_g: 10 },
        { amount_g: 10 },
        3,
        null,
        ['卵'],
        { name: '卵', amount_g: -1, note: '' },
      ],
    };

    await addRecipeIngredientsToShoppingList({ recipeData: recipeDataOf(dish), shoppingListId: undefined });

    const body = sentBody();
    // shoppingListId が無ければ本文に出さない (以前と同じ JSON.stringify の振る舞い)
    expect(body).not.toHaveProperty('shoppingListId');
    expect(body.ingredients).toEqual([
      { name: '玉ねぎ', amount: '1/2個' },
      { name: '鶏もも肉', amount: '150g' },
      { name: '卵', amount: null },
    ]);
  });

  it('重複の除去: 同じ文字列・同じ name / amount_g / note の構造の形は 1 件にする。メモだけ違うものは別の要素として残す', () => {
    const recipeData = {
      ingredients: ['にんじん 50g', { name: '玉ねぎ', amount_g: 100, note: 'みじん切り' }],
      dishes: [
        { ingredients: ['にんじん 50g', { name: '玉ねぎ', amount_g: 100, note: 'みじん切り' }] },
        { ingredients: [{ name: '玉ねぎ', amount_g: 100, note: '薄切り' }, ' にんじん 50g '] },
      ],
    };

    // 集める順は dishes の各料理 → 直下 (以前と同じ)
    expect(recipeShoppingIngredientsOf(recipeData)).toEqual([
      { name: 'にんじん', amount: '50g' },
      { name: '玉ねぎ', amount: '100g' },
      { name: '玉ねぎ', amount: '100g' },
    ]);
  });

  it('dishes が無い旧形式の料理は直下の ingredients だけを読み、dishes の配列でない要素は飛ばす', () => {
    expect(recipeShoppingIngredientsOf({ ingredients: ['鮭 1切れ'] })).toEqual([{ name: '鮭', amount: '1切れ' }]);
    expect(
      recipeShoppingIngredientsOf({ dishes: [null, 'x', ['豚肉 100g'], { ingredients: '豚肉 100g' }, { ingredients: ['豚肉 100g'] }] }),
    ).toEqual([{ name: '豚肉', amount: '100g' }]);
  });
});

describe('材料が無いとき (#2023)', () => {
  it.each([
    ['材料の列が無い', { name: '白ごはん' }],
    ['材料の列が空', recipeDataOf({ name: '白ごはん', ingredients: [] })],
    ['材料が空の文字列と name の無い要素だけ', recipeDataOf({ name: '白ごはん', ingredients: ['', '  ', { note: '少なめ' }] })],
    ['材料の列が配列でない', recipeDataOf({ name: '白ごはん', ingredients: '米 150g' })],
  ])('%s: 送らずに「材料なし」を返す', async (_label, recipeData) => {
    const result = await addRecipeIngredientsToShoppingList({ recipeData, shoppingListId: SHOPPING_LIST_ID });

    expect(result).toEqual({ kind: 'no-ingredients' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(RECIPE_SHOPPING_NO_INGREDIENTS_TITLE).toBe('材料なし');
    expect(RECIPE_SHOPPING_NO_INGREDIENTS_MESSAGE).toBe('材料情報がありません。「AIで変更」で再生成してください。');
  });
});

describe('失敗したとき (#2023)', () => {
  it('応答が 2xx でなく error の文があれば「エラー: <文>」', async () => {
    fetchMock.mockResolvedValue(errorResponse(500, { error: '買い物リストへの追加に失敗しました' }));

    const result = await addRecipeIngredientsToShoppingList({ recipeData: recipeDataOf(STRUCTURED_DISH), shoppingListId: SHOPPING_LIST_ID });

    expect(result).toEqual({ kind: 'failed', alertMessage: 'エラー: 買い物リストへの追加に失敗しました' });
  });

  it('応答が 2xx でなく error の文が無ければ (文字列でなくても)「エラー: 追加に失敗しました」', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(400, {}));
    fetchMock.mockResolvedValueOnce(errorResponse(400, { error: { code: 'X' } }));

    const first = await addRecipeIngredientsToShoppingList({ recipeData: recipeDataOf(STRING_DISH), shoppingListId: SHOPPING_LIST_ID });
    const second = await addRecipeIngredientsToShoppingList({ recipeData: recipeDataOf(STRING_DISH), shoppingListId: SHOPPING_LIST_ID });

    expect(first).toEqual({ kind: 'failed', alertMessage: 'エラー: 追加に失敗しました' });
    expect(second).toEqual({ kind: 'failed', alertMessage: 'エラー: 追加に失敗しました' });
    expect(recipeShoppingErrorAlertOf('')).toBe('エラー: 追加に失敗しました');
  });

  it('通信の例外・本文が JSON でない・2xx でも items が配列でないときは「追加に失敗しました」', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 502 }));
    fetchMock.mockResolvedValueOnce(okResponse({ items: null }));

    const results = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(await addRecipeIngredientsToShoppingList({ recipeData: recipeDataOf(STRUCTURED_DISH), shoppingListId: SHOPPING_LIST_ID }));
    }

    expect(RECIPE_SHOPPING_ADD_FAILED_MESSAGE).toBe('追加に失敗しました');
    expect(results).toEqual([
      { kind: 'failed', alertMessage: '追加に失敗しました' },
      { kind: 'failed', alertMessage: '追加に失敗しました' },
      { kind: 'failed', alertMessage: '追加に失敗しました' },
    ]);
  });
});

describe('menuDishIngredientsOf (dish-favorites/core。#2023)', () => {
  it('文字列は前後の空白を除き、構造の形は amount_g / note を省いても null にそろえる。配列でなければ空', () => {
    expect(menuDishIngredientsOf([' 鶏むね肉 200g ', { name: '塩' }, { name: '油', amount_g: 8, note: '  ' }])).toEqual([
      '鶏むね肉 200g',
      { name: '塩', amount_g: null, note: null },
      { name: '油', amount_g: 8, note: null },
    ]);
    expect(menuDishIngredientsOf(undefined)).toEqual([]);
    expect(menuDishIngredientsOf({ name: '塩' })).toEqual([]);
  });
});

// ───────────── page.tsx の配線 (ソースの検査) ─────────────

const PAGE_TSX_PATH = path.resolve(__dirname, '../../../../app/(main)/menus/weekly/page.tsx');
const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

/** コメントの行を除いたソース (経緯のコメントに当たらないように、コードの行だけを検査する) */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
    .join('\n');
}

const pageCode = stripCommentLines(pageSource);
const HANDLER_START = 'const addRecipeToShoppingList = async () => {';
const handlerCode = pageCode.slice(pageCode.indexOf(HANDLER_START), pageCode.indexOf('const handleGenerateWeekly'));

describe('page.tsx の addRecipeToShoppingList の配線 (#2023)', () => {
  it('材料は addRecipeIngredientsToShoppingList に任せ、page の中で材料を文字列として分けない', () => {
    expect(pageCode.indexOf(HANDLER_START)).toBeGreaterThan(0);
    expect(handlerCode).toContain(
      'addRecipeIngredientsToShoppingList({\n      recipeData: selectedRecipeData,\n      shoppingListId: activeShoppingList?.id,\n    })',
    );
    expect(handlerCode).not.toMatch(/\.match\(/);
    expect(handlerCode).not.toContain("fetch('/api/shopping-list/add-recipe'");
    expect(handlerCode).not.toContain('new Set(');
  });

  it('結果を画面の文に繋ぐ: 材料なし → setSuccessMessage(材料なし) / 失敗 → alert / 成功 → 買い物リストに足してモーダルを閉じ (selectedRecipe は残す) 件数の文', () => {
    const noIngredients = handlerCode.slice(handlerCode.indexOf("if (result.kind === 'no-ingredients') {"), handlerCode.indexOf("if (result.kind === 'failed') {"));
    expect(noIngredients).toContain(
      'setSuccessMessage({ title: RECIPE_SHOPPING_NO_INGREDIENTS_TITLE, message: RECIPE_SHOPPING_NO_INGREDIENTS_MESSAGE });',
    );
    expect(noIngredients).toContain('return;');

    const failed = handlerCode.slice(handlerCode.indexOf("if (result.kind === 'failed') {"));
    expect(failed.slice(0, failed.indexOf('return;'))).toContain('alert(result.alertMessage);');

    const added = failed.slice(failed.indexOf('return;'));
    expect(added).toContain('setShoppingList([...useShoppingStore.getState().shoppingList, ...result.items]);');
    expect(added).toContain('setActiveModal(null);');
    expect(added).not.toContain('setSelectedRecipe(');
    expect(added).toContain('setSuccessMessage({ title: RECIPE_SHOPPING_ADDED_TITLE, message: recipeShoppingAddedMessage(result.count) });');
  });
});
