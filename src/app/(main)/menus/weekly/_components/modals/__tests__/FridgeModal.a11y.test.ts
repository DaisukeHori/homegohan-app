// src/app/(main)/menus/weekly/_components/modals/__tests__/FridgeModal.a11y.test.ts
// #1052 (体系的 a11y):
// - role="dialog"/aria-modal/フォーカストラップ/Escape の後付け
// - 冷蔵庫アイテム行 (role="button") が Enter に加え Space でも活性化できることの検証
//   （WAI-ARIA APG のボタンパターン。従来は Enter のみだった）
// - 編集/削除ボタンの aria-label 維持確認（既存実装で既についていたもの）
// - 敵対レビュー統合修正(Suggestion D): コミット記録で「代表5モーダルで Tab トラップを
//   実DOM検証」と述べていたが実際には AddMealSlotModal にしかその実テストが無かったため、
//   本ファイルにも実際の Tab(+Shift+Tab) 境界テストを追加してその主張を実態に合わせる。

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { FridgeModal } from '../FridgeModal';
import { usePantryStore } from '../../../_state';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;

const ITEM = {
  id: 'p1',
  userId: 'u1',
  name: 'にんじん',
  amount: '2本',
  category: 'vegetable' as const,
  expirationDate: null,
  addedAt: '2026-07-01T00:00:00.000Z',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

beforeEach(() => {
  usePantryStore.getState().setFridgeItems([ITEM]);
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
  usePantryStore.getState().setFridgeItems([]);
});

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function render(onEditItem = vi.fn(), onClose = vi.fn(), onDeleteItem = vi.fn()) {
  act(() => {
    root.render(
      h(FridgeModal, {
        onClose,
        onOpenAddFridge: () => {},
        onDeleteItem,
        onEditItem,
      })
    );
  });
  return { onEditItem, onClose, onDeleteItem };
}

describe('FridgeModal: dialog a11y (#1052)', () => {
  it('role="dialog" aria-modal="true" を持ち、Escape で onClose が呼ばれる', () => {
    const { onClose } = render();
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    act(() => {
      pressEscape();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('閉じるボタンに aria-label="閉じる" が付き、44x44px相当のヒット領域クラスを持つ', () => {
    render();
    const closeBtn = container.querySelector('button[aria-label="閉じる"]') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    expect(closeBtn.className).toContain('min-w-[44px]');
  });
});

describe('FridgeModal: 冷蔵庫アイテム行のキーボード操作 (#1052, 堀さんのキーボードチェックリスト)', () => {
  it('Enter キーで行の onEditItem が呼ばれる（従来から対応済み）', () => {
    const { onEditItem } = render();
    const row = container.querySelector('[data-testid="fridge-item"]') as HTMLElement;
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('tabindex')).toBe('0');
    act(() => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onEditItem).toHaveBeenCalledWith(ITEM);
  });

  it('Space キーでも行の onEditItem が呼ばれる（#1052 で追加した回帰防止対象）', () => {
    const { onEditItem } = render();
    const row = container.querySelector('[data-testid="fridge-item"]') as HTMLElement;
    act(() => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    });
    expect(onEditItem).toHaveBeenCalledWith(ITEM);
  });

  it('Space キーのデフォルト動作(ページスクロール)は preventDefault される', () => {
    const { onEditItem } = render();
    const row = container.querySelector('[data-testid="fridge-item"]') as HTMLElement;
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    act(() => {
      row.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(onEditItem).toHaveBeenCalledTimes(1);
  });

  it('他のキー(例: "a")では onEditItem が呼ばれない', () => {
    const { onEditItem } = render();
    const row = container.querySelector('[data-testid="fridge-item"]') as HTMLElement;
    act(() => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
    });
    expect(onEditItem).not.toHaveBeenCalled();
  });

  it('編集/削除ボタンに aria-label が付いている（既存実装の維持確認）', () => {
    render();
    expect(container.querySelector('button[aria-label="編集"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="削除"]')).not.toBeNull();
  });
});

describe('FridgeModal: Tab キーによるフォーカストラップ境界 (#1052 敵対レビュー統合修正)', () => {
  it('最後のフォーカス可能要素で Tab を押してもダイアログ外へフォーカスが漏れない', async () => {
    render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    const focusables = Array.from(dialog.querySelectorAll('button')) as HTMLElement[];
    expect(focusables.length).toBeGreaterThan(1);
    const last = focusables[focusables.length - 1];

    act(() => {
      last.focus();
    });
    expect(document.activeElement).toBe(last);

    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.dispatchEvent(event);
    });

    expect(
      dialog.contains(document.activeElement),
      '最後のフォーカス可能要素で Tab を押すと、ダイアログ外へフォーカスが漏れてはいけない'
    ).toBe(true);
  });

  it('最初のフォーカス可能要素で Shift+Tab を押してもダイアログ外へフォーカスが漏れない', async () => {
    render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    const focusables = Array.from(dialog.querySelectorAll('button')) as HTMLElement[];
    expect(focusables.length).toBeGreaterThan(1);
    const first = focusables[0];

    act(() => {
      first.focus();
    });
    expect(document.activeElement).toBe(first);

    act(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
    });

    expect(
      dialog.contains(document.activeElement),
      '最初のフォーカス可能要素で Shift+Tab を押すと、ダイアログ外へフォーカスが漏れてはいけない'
    ).toBe(true);
  });
});
