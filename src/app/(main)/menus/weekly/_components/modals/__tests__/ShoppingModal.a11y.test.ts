// src/app/(main)/menus/weekly/_components/modals/__tests__/ShoppingModal.a11y.test.ts
// #1052 (体系的 a11y):
// - role="dialog"/aria-modal/フォーカストラップ/Escape の後付け
// - 買い物削除ボタンが 24px でタップ領域基準未達だった問題への対応（44x44pxに拡大）
// - チェック(購入済み)トグルボタンに aria-label/aria-pressed が無かった問題への対応

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ShoppingModal } from '../ShoppingModal';
import { useShoppingStore } from '../../../_state';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;

const ITEM = {
  id: 's1',
  shoppingListId: 'list1',
  category: '野菜',
  itemName: 'にんじん',
  quantity: '2本',
  isChecked: false,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  source: 'manual' as const,
  normalizedName: null,
  quantityVariants: [],
  selectedVariantIndex: 0,
};

beforeEach(() => {
  useShoppingStore.getState().setShoppingList([ITEM]);
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  document.body.style.overflow = '';
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.style.overflow = '';
  useShoppingStore.getState().resetShoppingState();
});

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function render(overrides: Partial<{ onDeleteItem: (id: string) => void; onToggleItem: (id: string, c: boolean) => void }> = {}) {
  const onClose = vi.fn();
  const onDeleteItem = overrides.onDeleteItem ?? vi.fn();
  const onToggleItem = overrides.onToggleItem ?? vi.fn();
  act(() => {
    root.render(
      h(ShoppingModal, {
        groupedShoppingList: [['野菜', [ITEM]]],
        hasAnyMealsThisWeek: true,
        onClose,
        onOpenAddShopping: () => {},
        onOpenShoppingRange: () => {},
        onToggleItem,
        onDeleteItem,
        onDeleteAll: () => {},
        onToggleVariant: () => {},
        onOpenServingsModal: () => {},
        onDismissProgress: () => {},
        onSetSuccessMessage: () => {},
      })
    );
  });
  return { onClose, onDeleteItem, onToggleItem };
}

describe('ShoppingModal: dialog a11y (#1052)', () => {
  it('role="dialog" aria-modal="true" aria-labelledby を持つ', () => {
    render();
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog!.getAttribute('aria-labelledby');
    expect(document.getElementById(labelledBy!)?.textContent).toBe('買い物リスト');
  });

  it('Escape キーで onClose が呼ばれる', () => {
    const { onClose } = render();
    act(() => {
      pressEscape();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ShoppingModal: アイテム行のタップ領域とaria (#1052)', () => {
  it('削除ボタンに商品名を含む aria-label が付き、44x44px相当のヒット領域クラスを持つ', () => {
    const { onDeleteItem } = render();
    const delBtn = container.querySelector(`button[aria-label="${ITEM.itemName}を削除"]`) as HTMLButtonElement;
    expect(delBtn, '削除ボタンが見つかりません').not.toBeNull();
    expect(delBtn.className).toContain('min-w-[44px]');
    expect(delBtn.className).toContain('min-h-[44px]');
    act(() => {
      delBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDeleteItem).toHaveBeenCalledWith(ITEM.id);
  });

  it('チェック(購入済み)トグルボタンに aria-label と aria-pressed=false（未購入）が付与される', () => {
    render();
    const toggleBtn = container.querySelector(
      `button[aria-label="${ITEM.itemName}を購入済みにする"]`
    ) as HTMLButtonElement;
    expect(toggleBtn, 'チェックボタンが見つかりません').not.toBeNull();
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('購入済み(isChecked=true)のときは aria-label/aria-pressed が反転する', () => {
    useShoppingStore.getState().setShoppingList([{ ...ITEM, isChecked: true }]);
    act(() => {
      root.render(
        h(ShoppingModal, {
          groupedShoppingList: [['野菜', [{ ...ITEM, isChecked: true }]]],
          hasAnyMealsThisWeek: true,
          onClose: () => {},
          onOpenAddShopping: () => {},
          onOpenShoppingRange: () => {},
          onToggleItem: () => {},
          onDeleteItem: () => {},
          onDeleteAll: () => {},
          onToggleVariant: () => {},
          onOpenServingsModal: () => {},
          onDismissProgress: () => {},
          onSetSuccessMessage: () => {},
        })
      );
    });
    const toggleBtn = container.querySelector(
      `button[aria-label="${ITEM.itemName}を未購入に戻す"]`
    ) as HTMLButtonElement;
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');
  });
});
