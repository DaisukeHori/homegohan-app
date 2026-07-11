// src/app/(main)/favorites/_components/__tests__/FavoriteListItem.test.ts
// #1050 round-2 (2モデル敵対レビュー Must 指摘, Opus 発見):
// お気に入り一覧の行 (role="button" 相当) の中に本物の削除 <button> をネストしており、
// 行の onKeyDown が e.target と e.currentTarget を区別していなかったため、
// 削除ボタンにフォーカスして Enter/Space を押すと、行側の handler がイベントバブルを
// 拾って e.preventDefault() し、削除ボタンのネイティブ活性化をキャンセルした上で
// 代わりに openRecipeDetail が呼ばれてしまい、キーボードで削除できなかった
// （マウスクリックは削除ボタン側の e.stopPropagation() で無傷だった）。
//
// 修正: 行全体の role="button"/onKeyDown/ネストされた<button> という構造そのものを廃止し、
// 「レシピを開く」ボタンと「削除する」ボタンをネイティブ <button> の兄弟として並べた
// (FavoriteListItem.tsx)。ネスト自体が無いため、キーボードの Enter/Space 活性化は
// ブラウザ標準の挙動（フォーカスされている方の button だけが click される）に委ねられる。
//
// このテストは実際に DOM へレンダリングし、
// 1. 「レシピを見る」ボタンをクリック（Enter/Space によるネイティブボタン活性化と等価）
//    すると onOpen が呼ばれ、onRemove は呼ばれないこと
// 2. 「削除」ボタンをクリックすると onRemove が呼ばれ、onOpen は呼ばれないこと
// 3. 削除ボタン起点でバブルする keydown (Enter) が、祖先のどのハンドラからも
//    onOpen を誤って呼び出さないこと（旧バグの再現手順そのものを直接検証）
// 4. 削除ボタンが行の role="button" 相当要素の中にネストされていない
//    （無効な ARIA 構造の解消）
// を検証する。「行の onKeyDown ガードを外す」「削除ボタンを再びネストする」という
// 1行の巻き戻しで red になることを想定した回帰テスト。

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { FavoriteListItem } from '../FavoriteListItem';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;

const ITEM = {
  id: 'fav-1',
  recipeName: '鶏の唐揚げ',
  recipeUuid: 'uuid-1',
  likedAt: '2026-07-01T00:00:00.000Z',
};

const formatDate = (iso: string) => iso.slice(0, 10);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function getOpenButton(): HTMLButtonElement {
  const btn = container.querySelector(`button[aria-label="${ITEM.recipeName} のレシピを見る"]`);
  expect(btn, '「レシピを見る」ボタンが見つかりません').not.toBeNull();
  return btn as HTMLButtonElement;
}

function getRemoveButton(): HTMLButtonElement {
  const btn = container.querySelector('button[aria-label="お気に入りから削除"]');
  expect(btn, '「削除」ボタンが見つかりません').not.toBeNull();
  return btn as HTMLButtonElement;
}

function render(overrides: Partial<{ isRemoving: boolean; onOpen: () => void; onRemove: () => void }> = {}) {
  const onOpen = overrides.onOpen ?? vi.fn();
  const onRemove = overrides.onRemove ?? vi.fn();
  act(() => {
    root.render(
      h(FavoriteListItem, {
        item: ITEM,
        isRemoving: overrides.isRemoving ?? false,
        onOpen,
        onRemove,
        formatDate,
      })
    );
  });
  return { onOpen, onRemove };
}

describe('FavoriteListItem: キーボード削除リグレッション (#1050 round-2 Must)', () => {
  it('(a) 「レシピを見る」ボタンの活性化（クリック = Enter/Space のネイティブ活性化と等価）で onOpen が呼ばれ、onRemove は呼ばれない', () => {
    const { onOpen, onRemove } = render();
    const openBtn = getOpenButton();
    act(() => {
      openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('(b) 「削除」ボタンの活性化（クリック = Enter/Space のネイティブ活性化と等価）で onRemove が呼ばれ、onOpen は呼ばれない（キーボード削除の回帰防止）', () => {
    const { onOpen, onRemove } = render();
    const removeBtn = getRemoveButton();
    act(() => {
      removeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('(c) 削除ボタンを起点にバブルする keydown Enter が、祖先の何らかのハンドラで onOpen を誤って呼び出さない（旧バグの直接再現）', () => {
    // 旧実装では行の onKeyDown が e.target を検査せず、削除ボタンから bubble してきた
    // keydown を拾って openRecipeDetail (= onOpen) を呼んでいた。
    // 新実装は行に onKeyDown 自体を持たないため、bubble しても何も起きないはずである。
    const { onOpen, onRemove } = render();
    const removeBtn = getRemoveButton();
    act(() => {
      removeBtn.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    });
    expect(onOpen, '削除ボタンからバブルした keydown で onOpen が呼ばれています（キーボード削除リグレッション）').not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled(); // keydown 自体はネイティブ click を合成しないため（jsdom制約）、ここでは呼ばれない想定
  });

  it('(d) 削除ボタンが行のトップレベル要素の中に「role=button またはネイティブbutton」としてネストされていない（無効なARIAネストの解消）', () => {
    render();
    const removeBtn = getRemoveButton();
    // 削除ボタンの直近の button/role=button 祖先を辿る。存在するなら親コンテナ (motion.div) まで
    // 遡っても button/role=button に行き当たらないことを確認する（=兄弟構造になっていること）。
    let el: HTMLElement | null = removeBtn.parentElement;
    let foundInteractiveAncestor = false;
    while (el && el !== container) {
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
        foundInteractiveAncestor = true;
        break;
      }
      el = el.parentElement;
    }
    expect(
      foundInteractiveAncestor,
      '削除ボタンが interactive な要素 (button / role=button) の中にネストされています'
    ).toBe(false);
  });

  it('isRemoving=true のとき削除ボタンが disabled になる（連打防止の既存挙動の維持）', () => {
    render({ isRemoving: true });
    const removeBtn = getRemoveButton();
    expect(removeBtn.disabled).toBe(true);
  });
});
