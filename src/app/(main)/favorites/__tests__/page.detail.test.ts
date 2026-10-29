// src/app/(main)/favorites/__tests__/page.detail.test.ts
// #2011 (docs/design/cross/22-dish-favorites.md §7.10・§9.3 (c)(d)):
//   お気に入りの画面 (/favorites) の、詳細の開閉と削除の応答 (H-1〜H-4) と、一覧のページングと削除の順序 (H-5〜H-10) を、
//   実際に画面を描いて確かめる。
//   - 詳細を閉じるのは「削除の応答の時点で、詳細がまだ消した行を出しているとき」だけ (openFavoriteIdRef)
//   - 閉じる途中のパネル (最後に開いていたときの props のまま) の ♥ は何も送らない
//   - 削除の応答待ちと一覧の GET の送信・応答待ちを重ねない (「次の50件を表示」の disabled・取り直しの GET は削除の後始末を待つ・
//     一覧の GET の応答待ちの間は削除を送らない)。削除のあとは offset を 1 戻す
//   - 詳細だけが出していた行 (一覧に無い行) を消したときは、一覧と offset を変えずに 1 ページ目を読み直す
//
// FavoriteRecipeModal は「描くたびに props を配列に積み、null を返す」偽物にし、最後の props を見る。
// FavoriteListItem は本物 (行の「{dish_name} のレシピを見る」・「お気に入りから削除」のボタンを押す)。
// fetch は偽物で、DELETE と 2 本目からの GET は外から解決する Promise を返し、応答の時点をテストが決める。

import React, { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { DISH_FAVORITES_PAGE_SIZE, DishSnapshotSchema, type DishFavorite } from '@/modules/dish-favorites/core';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));

/** FavoriteRecipeModal の偽物が受けた props (描くたびに 1 つ) */
interface ModalProps {
  isOpen: boolean;
  favorite: DishFavorite | null;
  isRemoving: boolean;
  onRemove: () => void;
  onNotice: (message: string) => void;
  onClose: () => void;
}
const modalCalls = vi.hoisted(() => [] as unknown[]);

vi.mock('../_components/FavoriteRecipeModal', () => ({
  FavoriteRecipeModal: (props: unknown) => {
    modalCalls.push(props);
    return null;
  },
}));

import FavoritesPage from '../page';

const h = React.createElement;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------
// 固定値
// ---------------------------------------------------------------

const TIMESTAMP = '2026-10-01T00:00:00.000Z';
/** uuid の形の id (末尾 12 桁に番号を入れる) */
const uuidOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function favoriteOf(n: number, dishName: string): DishFavorite {
  return {
    id: uuidOf(n),
    dish_name: dishName,
    dish: DishSnapshotSchema.parse({ name: dishName }),
    source_planned_meal_id: null,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
}

const F = favoriteOf(1, '肉じゃが');
const G = favoriteOf(2, '親子丼');
/** 1 ページ分の行 (P0〜P49) */
const PAGE_ROWS = Array.from({ length: DISH_FAVORITES_PAGE_SIZE }, (_, i) => favoriteOf(100 + i, `P${i}`));

// ---------------------------------------------------------------
// fetch の偽物
// ---------------------------------------------------------------

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
interface FetchCall {
  method: string;
  url: string;
}

let calls: FetchCall[];
let resolveDelete: (r: { ok: boolean; status: number }) => void;
let resolveGet: (r: FakeResponse) => void;

/** 1 本目の GET は firstGet を返し、2 本目からの GET と DELETE は外から解決する */
function installFetch(firstGet: { favorites: DishFavorite[]; total: number }) {
  let getCount = 0;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (method === 'DELETE') {
      return new Promise((resolve) => {
        resolveDelete = resolve;
      });
    }
    getCount += 1;
    if (getCount === 1) {
      return Promise.resolve({ ok: true, status: 200, json: async () => firstGet });
    }
    return new Promise((resolve) => {
      resolveGet = resolve;
    });
  });
  vi.stubGlobal('fetch', fetchMock);
}

const okList = (favorites: DishFavorite[], total: number): FakeResponse => ({
  ok: true,
  status: 200,
  json: async () => ({ favorites, total }),
});

const searchParamsOf = (call: FetchCall) => new URL(call.url, 'http://localhost').searchParams;
const getCalls = () => calls.filter((c) => c.method === 'GET');
const deleteCalls = () => calls.filter((c) => c.method === 'DELETE');
/** DELETE より後に送った GET */
function getsAfterDelete(): FetchCall[] {
  const deleteAt = calls.findIndex((c) => c.method === 'DELETE');
  expect(deleteAt).toBeGreaterThanOrEqual(0);
  return calls.slice(deleteAt + 1).filter((c) => c.method === 'GET');
}

// ---------------------------------------------------------------
// 画面の操作
// ---------------------------------------------------------------

let container: HTMLDivElement;
let root: Root | null;

/** 1 回の macrotask を待つ (その前の microtask (fetch・res.json()・削除の後始末の待ち) はすべて流れる。検索の debounce は進まない) */
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

async function mountPage(firstGet: { favorites: DishFavorite[]; total: number }) {
  if (root) {
    const prev = root;
    act(() => prev.unmount());
  }
  calls = [];
  modalCalls.length = 0;
  installFetch(firstGet);
  act(() => {
    root = createRoot(container);
    root.render(h(FavoritesPage));
  });
  await settle();
}

function lastModal(): ModalProps {
  const last = modalCalls[modalCalls.length - 1] as ModalProps | undefined;
  expect(last, 'FavoriteRecipeModal が描かれていません').toBeDefined();
  return last as ModalProps;
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function openButtonOf(dishName: string): HTMLButtonElement {
  const btn = container.querySelector(`button[aria-label="${dishName} のレシピを見る"]`);
  expect(btn, `「${dishName} のレシピを見る」が見つかりません`).not.toBeNull();
  return btn as HTMLButtonElement;
}

/** 行の ♥ (お気に入りから削除)。一覧の並びの順 */
function removeButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label="お気に入りから削除"]'));
}

function moreButton(): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent === '次の50件を表示',
  );
  expect(btn, '「次の50件を表示」が見つかりません').toBeDefined();
  return btn as HTMLButtonElement;
}

/** 一覧の行の料理名 (並びの順) */
function rowNames(): string[] {
  return Array.from(container.querySelectorAll('button[aria-label$=" のレシピを見る"]')).map((b) =>
    (b.getAttribute('aria-label') ?? '').replace(/ のレシピを見る$/, ''),
  );
}

/** 画面の見出しの「{total} 件」 */
function totalText(): string | undefined {
  return Array.from(container.querySelectorAll('p'))
    .map((p) => p.textContent ?? '')
    .find((text) => /^\d+ 件$/.test(text));
}

function changeSort(value: 'newest' | 'oldest' | 'name') {
  const select = container.querySelector('select');
  expect(select, '並び替えが見つかりません').not.toBeNull();
  act(() => {
    (select as HTMLSelectElement).value = value;
    (select as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
});

afterEach(() => {
  if (root) {
    const prev = root;
    act(() => prev.unmount());
  }
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------
// H-1〜H-4: 詳細の開閉と削除の応答 (§9.3 (c))
// ---------------------------------------------------------------

describe('お気に入りの画面: 詳細の開閉と削除の応答 (#2011)', () => {
  it('H-1「詳細の ♥ (onRemove) は DELETE /api/favorites/{id} を送り、応答待ちの間は isRemoving=true、200 で詳細を閉じて一覧からその行を外し件数を 1 減らす (404 も同じ)」', async () => {
    for (const response of [{ ok: true, status: 200 }, { ok: false, status: 404 }]) {
      await mountPage({ favorites: [F, G], total: 2 });
      expect(rowNames()).toEqual(['肉じゃが', '親子丼']);
      expect(totalText()).toBe('2 件');

      click(openButtonOf('肉じゃが'));
      expect(lastModal().isOpen).toBe(true);
      expect(lastModal().favorite?.id).toBe(F.id);
      expect(lastModal().isRemoving).toBe(false);

      act(() => lastModal().onRemove());
      expect(deleteCalls()).toEqual([{ method: 'DELETE', url: `/api/favorites/${F.id}` }]);
      expect(lastModal().isRemoving).toBe(true);
      // 応答の前は閉じない・一覧も変えない
      expect(lastModal().isOpen).toBe(true);
      expect(rowNames()).toEqual(['肉じゃが', '親子丼']);

      resolveDelete(response);
      await settle();
      expect(lastModal().isOpen).toBe(false);
      expect(lastModal().isRemoving).toBe(false);
      expect(rowNames()).toEqual(['親子丼']);
      expect(totalText()).toBe('1 件');
      // 一覧にあった行なので読み直さない
      expect(getsAfterDelete()).toEqual([]);
    }
  });

  it('H-2「詳細の ♥ の応答の前に詳細を閉じて別の行の詳細を開くと、削除の応答 (200) はその別の行の詳細を閉じない (isOpen=true・favorite はその別の行のまま。一覧からは消した行だけを外す)」', async () => {
    await mountPage({ favorites: [F, G], total: 2 });
    click(openButtonOf('肉じゃが'));
    act(() => lastModal().onRemove());
    expect(lastModal().isRemoving).toBe(true);

    act(() => lastModal().onClose());
    expect(lastModal().isOpen).toBe(false);
    click(openButtonOf('親子丼'));
    expect(lastModal().isOpen).toBe(true);
    expect(lastModal().favorite?.id).toBe(G.id);

    resolveDelete({ ok: true, status: 200 });
    await settle();
    expect(lastModal().isOpen).toBe(true);
    expect(lastModal().favorite?.id).toBe(G.id);
    expect(lastModal().isRemoving).toBe(false);
    expect(rowNames()).toEqual(['親子丼']);
    expect(totalText()).toBe('1 件');
  });

  it('H-3「削除の応答待ちの間は、別の行の詳細を開いても isRemoving=true で、応答のあと false に戻る」', async () => {
    await mountPage({ favorites: [F, G], total: 2 });
    click(openButtonOf('肉じゃが'));
    act(() => lastModal().onRemove());
    act(() => lastModal().onClose());
    click(openButtonOf('親子丼'));
    expect(lastModal().favorite?.id).toBe(G.id);
    expect(lastModal().isRemoving).toBe(true);

    // 応答待ちの間に別の行の詳細の ♥ を押しても 2 本目の DELETE は送らない
    act(() => lastModal().onRemove());
    expect(deleteCalls()).toHaveLength(1);

    resolveDelete({ ok: true, status: 200 });
    await settle();
    expect(lastModal().isRemoving).toBe(false);
    expect(lastModal().favorite?.id).toBe(G.id);
    expect(deleteCalls()).toHaveLength(1);
  });

  it('H-4「詳細を閉じたあと (閉じる途中)、開いていたときの props の onRemove を 2 回呼んでも DELETE を送らず、isRemoving は false のまま・件数も変わらない」', async () => {
    await mountPage({ favorites: [F, G], total: 2 });
    click(openButtonOf('肉じゃが'));
    const staleOnRemove = lastModal().onRemove;

    act(() => lastModal().onClose());
    expect(lastModal().isOpen).toBe(false);

    act(() => {
      staleOnRemove();
      staleOnRemove();
    });
    await settle();
    expect(deleteCalls()).toHaveLength(0);
    expect(lastModal().isRemoving).toBe(false);
    expect(rowNames()).toEqual(['肉じゃが', '親子丼']);
    expect(totalText()).toBe('2 件');
  });
});

// ---------------------------------------------------------------
// H-5〜H-10: 一覧のページングと削除の順序 (§9.3 (d))
// ---------------------------------------------------------------

describe('お気に入りの画面: 一覧のページングと削除の順序 (#2011)', () => {
  const FULL_PAGE = { favorites: PAGE_ROWS, total: DISH_FAVORITES_PAGE_SIZE + 1 };

  it('H-5「一覧の行の ♥ で 1 件消した (200) あとの「次の50件を表示」は、offset = 読み込んだ行の数 − 1 で GET を送り、件数は 1 減る (404 も同じ)」', async () => {
    for (const response of [{ ok: true, status: 200 }, { ok: false, status: 404 }]) {
      await mountPage(FULL_PAGE);
      expect(rowNames()).toHaveLength(DISH_FAVORITES_PAGE_SIZE);
      expect(totalText()).toBe(`${DISH_FAVORITES_PAGE_SIZE + 1} 件`);

      click(removeButtons()[0]);
      expect(deleteCalls()).toEqual([{ method: 'DELETE', url: `/api/favorites/${PAGE_ROWS[0].id}` }]);
      resolveDelete(response);
      await settle();
      expect(rowNames()).toHaveLength(DISH_FAVORITES_PAGE_SIZE - 1);
      expect(rowNames()).not.toContain('P0');
      expect(totalText()).toBe(`${DISH_FAVORITES_PAGE_SIZE} 件`);

      click(moreButton());
      const gets = getCalls();
      expect(gets).toHaveLength(2);
      expect(searchParamsOf(gets[1]).get('offset')).toBe(String(DISH_FAVORITES_PAGE_SIZE - 1));
    }
  });

  it('H-6「削除の応答待ちの間は「次の50件を表示」が disabled で GET を送らず、応答のあとに押せるようになる」', async () => {
    await mountPage(FULL_PAGE);
    click(removeButtons()[0]);
    const more = moreButton();
    expect(more.disabled).toBe(true);
    act(() => more.click());
    expect(getCalls()).toHaveLength(1);

    resolveDelete({ ok: true, status: 200 });
    await settle();
    expect(moreButton().disabled).toBe(false);
    expect(getCalls()).toHaveLength(1);
  });

  it('H-7「一覧の GET の応答待ちの間 (「次の50件を表示」を押したあと) に行の ♥ を押しても DELETE を送らず、GET の応答のあとに押すと送る」', async () => {
    await mountPage(FULL_PAGE);
    click(moreButton());
    expect(getCalls()).toHaveLength(2);

    const p0Remove = removeButtons()[0];
    click(p0Remove);
    expect(deleteCalls()).toHaveLength(0);
    expect(p0Remove.disabled).toBe(false);

    resolveGet(okList([], DISH_FAVORITES_PAGE_SIZE + 1));
    await settle();
    click(removeButtons()[0]);
    expect(deleteCalls()).toEqual([{ method: 'DELETE', url: `/api/favorites/${PAGE_ROWS[0].id}` }]);
  });

  it('H-8「削除の応答待ちの間に並び替えを変えると、一覧の GET は削除の応答のあとに送る」', async () => {
    await mountPage(FULL_PAGE);
    click(removeButtons()[0]);
    changeSort('oldest');
    await settle();
    expect(getCalls().filter((c) => searchParamsOf(c).get('sort') === 'oldest')).toHaveLength(0);

    resolveDelete({ ok: true, status: 200 });
    await settle();
    const oldestGets = getCalls().filter((c) => searchParamsOf(c).get('sort') === 'oldest');
    expect(oldestGets).toHaveLength(1);
    expect(calls.indexOf(oldestGets[0])).toBeGreaterThan(calls.findIndex((c) => c.method === 'DELETE'));
    expect(searchParamsOf(oldestGets[0]).get('offset')).toBe('0');
  });

  it('H-9「詳細を開いたあとに一覧が置き換わり、詳細の行が一覧に無いとき、詳細の ♥ の削除 (200) は一覧と件数を変えずに詳細を閉じ、1 ページ目の GET を DELETE のあとに 1 本送る」', async () => {
    await mountPage({ favorites: [F, G], total: 2 });
    click(openButtonOf('肉じゃが'));
    // 一覧が置き換わる経路は検索語の確定と同じ fetchFavorites(0)。テストは並び替えで起こす
    changeSort('oldest');
    await settle();
    resolveGet(okList([G], 2));
    await settle();
    expect(rowNames()).toEqual(['親子丼']);
    expect(lastModal().isOpen).toBe(true);
    expect(lastModal().favorite?.id).toBe(F.id);

    act(() => lastModal().onRemove());
    expect(deleteCalls()).toEqual([{ method: 'DELETE', url: `/api/favorites/${F.id}` }]);
    resolveDelete({ ok: true, status: 200 });
    await settle();
    expect(lastModal().isOpen).toBe(false);
    expect(rowNames()).toEqual(['親子丼']);
    expect(totalText()).toBe('2 件');
    const after = getsAfterDelete();
    expect(after).toHaveLength(1);
    expect(searchParamsOf(after[0]).get('offset')).toBe('0');
    expect(searchParamsOf(after[0]).get('sort')).toBe('oldest');

    resolveGet(okList([G], 1));
    await settle();
    expect(totalText()).toBe('1 件');
    expect(rowNames()).toEqual(['親子丼']);
  });

  it('H-10「H-9 の削除の応答の前に並び替えを変えると、削除の応答のあとの GET は並び替えの 1 本だけ (読み直しを足さない)」', async () => {
    await mountPage({ favorites: [F, G], total: 2 });
    click(openButtonOf('肉じゃが'));
    changeSort('oldest');
    await settle();
    resolveGet(okList([G], 2));
    await settle();
    act(() => lastModal().onRemove());
    expect(deleteCalls()).toHaveLength(1);

    const getsBefore = getCalls().length;
    changeSort('name');
    await settle();
    expect(getCalls()).toHaveLength(getsBefore);

    resolveDelete({ ok: true, status: 200 });
    await settle();
    const after = getsAfterDelete();
    expect(after).toHaveLength(1);
    expect(searchParamsOf(after[0]).get('sort')).toBe('name');
    expect(searchParamsOf(after[0]).get('offset')).toBe('0');
  });
});
