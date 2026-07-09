// src/__tests__/app/menus/weekly/modal-contracts.test.ts
// Issue #1031: 「store に seed した値がモーダルに正しく描画されるか」の契約テスト。
//
// #1031 以前は page.tsx が local useState を保持し、モーダルは store を直接
// read/write していたため、page.tsx がどれだけ store に値を書いても
// (あるいは store にどれだけ値を積んでも) モーダル側の表示は
// 「常に空」「常にデフォルト」になっていた。
//
// このテストは page.tsx を経由せず、モーダルコンポーネント単体に対して
// 「store に値を seed → render → DOM に反映されているか」を直接検証する
// (= #1031 の受入基準そのもの)。
//
// NOTE: このリポジトリの tsconfig.json は Next.js の SWC コンパイラ向けに
// `jsx: "preserve"` を指定しており、Vitest (esbuild/rolldown 経由) の .tsx
// 変換と非互換 ("Failed to parse source... jsx to preserve" エラー)。
// 共有設定である vitest.config.ts を変更する影響範囲を避けるため、本ファイルは
// あえて拡張子 .ts + React.createElement を使い JSX 構文を回避する。

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { usePantryStore } from '@/app/(main)/menus/weekly/_state/pantryStore';
import { useShoppingStore } from '@/app/(main)/menus/weekly/_state/shoppingStore';
import { useFormDraftStore } from '@/app/(main)/menus/weekly/_state/formDraftStore';
import { useServingsConfigStore } from '@/app/(main)/menus/weekly/_state/servingsConfigStore';

import { FridgeModal } from '@/app/(main)/menus/weekly/_components/modals/FridgeModal';
import { AddFridgeModal } from '@/app/(main)/menus/weekly/_components/modals/AddFridgeModal';
import { ShoppingModal } from '@/app/(main)/menus/weekly/_components/modals/ShoppingModal';
import { EditMealModal } from '@/app/(main)/menus/weekly/_components/modals/EditMealModal';
import { ServingsModal } from '@/app/(main)/menus/weekly/_components/modals/ServingsModal';

import type { PantryItem, ShoppingListItem } from '@/types/domain';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;

function renderComponent(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });

  // 各テスト前に全 store を初期状態へ戻す (テスト間の汚染防止)
  usePantryStore.setState({ fridgeItems: [] });
  useShoppingStore.getState().resetShoppingState();
  useFormDraftStore.setState({
    newFridgeName: '',
    newFridgeAmount: '',
    newFridgeExpiry: '',
    editMealName: '',
    editMealMode: 'cook',
  });
  useServingsConfigStore.setState({ servingsConfig: null, isLoadingServingsConfig: false });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

const noop = () => {};

const MODE_CONFIG_FAKE = {
  cook: { icon: () => null, label: '自炊', color: '#000', bg: '#fff' },
  quick: { icon: () => null, label: '時短', color: '#000', bg: '#fff' },
};

describe('モーダル契約テスト: store seed → 描画 assert (#1031 受入基準)', () => {
  it('FridgeModal: pantryStore.fridgeItems に1品追加すると描画される', () => {
    usePantryStore.getState().setFridgeItems([
      { id: 'f1', name: 'にんじん', amount: '2本', category: 'other', expirationDate: null } as PantryItem,
    ]);

    renderComponent(
      h(FridgeModal, { onClose: noop, onOpenAddFridge: noop, onDeleteItem: noop })
    );

    expect(container.textContent).toContain('にんじん');
    expect(container.textContent).not.toContain('冷蔵庫は空です');
  });

  it('FridgeModal: fridgeItems が空なら「冷蔵庫は空です」を表示する (0件の契約も検証)', () => {
    renderComponent(
      h(FridgeModal, { onClose: noop, onOpenAddFridge: noop, onDeleteItem: noop })
    );
    expect(container.textContent).toContain('冷蔵庫は空です');
  });

  it('AddFridgeModal: formDraftStore.newFridgeName を seed すると input value に反映される', () => {
    useFormDraftStore.getState().setNewFridgeName('たまねぎ');

    renderComponent(h(AddFridgeModal, { onAdd: noop, onClose: noop }));

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.value).toBe('たまねぎ');
  });

  it('ShoppingModal: shoppingStore.shoppingList に seed した商品名が描画される', () => {
    const items: ShoppingListItem[] = [
      {
        id: 's1',
        itemName: 'にんじん',
        quantity: '2本',
        category: '青果（野菜・果物）',
        isChecked: false,
      } as ShoppingListItem,
    ];
    useShoppingStore.getState().setShoppingList(items);

    renderComponent(
      h(ShoppingModal, {
        groupedShoppingList: [['青果（野菜・果物）', items]],
        hasAnyMealsThisWeek: true,
        onClose: noop,
        onOpenAddShopping: noop,
        onOpenShoppingRange: noop,
        onToggleItem: noop,
        onDeleteItem: noop,
        onDeleteAll: noop,
        onToggleVariant: noop,
        onOpenServingsModal: noop,
        onDismissProgress: noop,
        onSetSuccessMessage: noop,
      })
    );

    expect(container.textContent).toContain('にんじん');
    expect(container.textContent).not.toContain('買い物リストは空です');
  });

  it('EditMealModal: formDraftStore.editMealName を seed すると input value に反映される (既存料理名が表示されない #1031 の症状に対する回帰防止)', () => {
    useFormDraftStore.getState().setEditMealName('肉じゃが');
    useFormDraftStore.getState().setEditMealMode('cook');

    renderComponent(
      h(EditMealModal, { modeConfig: MODE_CONFIG_FAKE as any, onClose: noop, onSave: noop })
    );

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.value).toBe('肉じゃが');
  });

  it('ServingsModal: servingsConfigStore.servingsConfig を seed すると保存済み人数が表示される (常にデフォルト2人表示になる #1031 の症状に対する回帰防止)', () => {
    useServingsConfigStore.getState().setServingsConfig({
      default: 5,
      byDayMeal: { monday: { breakfast: 1 } },
    });

    renderComponent(h(ServingsModal, { onClose: noop, onSave: noop }));

    // monday/breakfast セルには保存済みの 1 が表示される (デフォルト 5 ではない)
    expect(container.textContent).toContain('1');
  });
});
