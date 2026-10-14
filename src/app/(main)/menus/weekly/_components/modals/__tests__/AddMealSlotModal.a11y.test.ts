// src/app/(main)/menus/weekly/_components/modals/__tests__/AddMealSlotModal.a11y.test.ts
// #1052 (体系的 a11y): weekly の19モーダル（このファイルはその代表例）に
// role="dialog"/aria-modal/フォーカストラップ/Escape がゼロだった問題への対応を、
// 実際に DOM へレンダリングして検証する。

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { AddMealSlotModal } from '../AddMealSlotModal';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;

const weekDates = [
  { date: new Date('2026-07-06'), dateStr: '2026-07-06', dayOfWeek: '月' },
];

beforeEach(() => {
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
});

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function render(onClose = vi.fn(), onSelectMealType = vi.fn()) {
  act(() => {
    root.render(
      h(AddMealSlotModal, {
        selectedDayIndex: 0,
        weekDates,
        onClose,
        onSelectMealType,
      })
    );
  });
  return { onClose, onSelectMealType };
}

describe('AddMealSlotModal: dialog a11y (#1052)', () => {
  it('role="dialog" aria-modal="true" aria-labelledby を持つ', () => {
    render();
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog, 'role="dialog" 要素が見つかりません').not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog!.getAttribute('aria-labelledby');
    expect(labelledBy, 'aria-labelledby が設定されていません').toBeTruthy();
    const labelEl = document.getElementById(labelledBy!);
    expect(labelEl?.textContent).toBe('食事を追加');
  });

  it('閉じるボタンに aria-label="閉じる" が付与され、ヒット領域が44x44px相当のクラスを持つ', () => {
    const { onClose } = render();
    const closeBtn = container.querySelector('button[aria-label="閉じる"]') as HTMLButtonElement;
    expect(closeBtn, '閉じるボタンが見つかりません').not.toBeNull();
    expect(closeBtn.className).toContain('min-w-[44px]');
    expect(closeBtn.className).toContain('min-h-[44px]');
    act(() => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('マウント時にフォーカスがダイアログ内へ移動する', async () => {
    render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('Escape キーで onClose が呼ばれる', () => {
    const { onClose } = render();
    act(() => {
      pressEscape();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Tab キーでフォーカスがダイアログ内にトラップされる（最後の要素で Tab を押してもダイアログ外に出ない）', async () => {
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

    // focus-trap-react は境界で内部のフォールバック要素（パネル自体, tabIndex=-1）に
    // 一旦フォーカスを戻すことがあるため、「特定のボタンに一致する」ではなく
    // 「ダイアログの外へフォーカスが漏れていない」ことを検証する（本質的な a11y 要件）。
    expect(
      dialog.contains(document.activeElement),
      '最後のフォーカス可能要素で Tab を押すと、ダイアログ外へフォーカスが漏れてはいけない'
    ).toBe(true);
  });

  it('食事タイプボタンをクリックすると onSelectMealType が選択中の日付インデックスで呼ばれる（既存挙動の維持）', () => {
    const { onSelectMealType } = render();
    const breakfastBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('朝食')
    ) as HTMLButtonElement;
    expect(breakfastBtn, '朝食ボタンが見つかりません').not.toBeNull();
    act(() => {
      breakfastBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectMealType).toHaveBeenCalledWith('breakfast', 0);
  });
});
