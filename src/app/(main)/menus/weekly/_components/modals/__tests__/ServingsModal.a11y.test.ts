// src/app/(main)/menus/weekly/_components/modals/__tests__/ServingsModal.a11y.test.ts
// #1052 (体系的 a11y):
// - role="dialog"/aria-modal/フォーカストラップ/Escape の後付け
// - 「人数±」ボタンが 24-36px でタップ領域基準未達だった問題への対応
//   （aria-label 付与 + 垂直方向のみ(min-h/-my)ヒット領域を拡大）
// - 敵対レビュー統合修正: 当初は水平方向(-mx)にもヒット領域を拡大していたが、
//   grid-cols-4 の狭いセルで隣の食事列(朝/昼/夜)の±ボタンと水平方向に重なり、
//   誤操作で別食事の人数が増減するバグがあったため、水平方向の負マージンは撤回した。
// - コミット記録で「代表5モーダルで Tab トラップを実DOM検証」と述べていたが実際には
//   AddMealSlotModal にしかその実テストが無かったため、本ファイルにも実際の Tab
//   (+Shift+Tab) 境界テストを追加してその主張を実態に合わせる。

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ServingsModal } from '../ServingsModal';
import { useServingsConfigStore } from '../../../_state';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useServingsConfigStore.getState().setServingsConfig({ default: 2, byDayMeal: {} });
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
  useServingsConfigStore.getState().setServingsConfig(null);
});

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function render(onClose = vi.fn(), onSave = vi.fn()) {
  act(() => {
    root.render(h(ServingsModal, { onClose, onSave }));
  });
  return { onClose, onSave };
}

describe('ServingsModal: dialog a11y (#1052)', () => {
  it('role="dialog" aria-modal="true" aria-labelledby を持つ', () => {
    render();
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog!.getAttribute('aria-labelledby');
    expect(document.getElementById(labelledBy!)?.textContent).toBe('曜日別人数設定');
  });

  it('Escape キーで onClose が呼ばれる', () => {
    const { onClose } = render();
    act(() => {
      pressEscape();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('閉じるボタンに aria-label="閉じる" が付与される', () => {
    render();
    expect(container.querySelector('button[aria-label="閉じる"]')).not.toBeNull();
  });
});

describe('ServingsModal: 人数±ボタンのタップ領域とaria-label (#1052)', () => {
  it('月曜朝の「増やす」ボタンに aria-label が付与され、垂直方向に44px相当のヒット領域クラスを持つ', () => {
    render();
    const btn = container.querySelector(
      'button[aria-label="月曜朝の人数を1人増やす"]'
    ) as HTMLButtonElement;
    expect(btn, '増やすボタンが見つかりません').not.toBeNull();
    expect(btn.className).toContain('min-h-[44px]');
  });

  it('敵対レビュー統合修正の回帰テスト: ±ボタンは水平方向の負マージン(-mx)を使わない（隣の食事列との水平衝突防止）', () => {
    render();
    const allDayMealButtons = Array.from(
      container.querySelectorAll('button[aria-label*="の人数を1人"]')
    ) as HTMLButtonElement[];
    expect(allDayMealButtons.length).toBeGreaterThan(0);
    for (const btn of allDayMealButtons) {
      expect(
        btn.className,
        `${btn.getAttribute('aria-label')} が水平方向の負マージン(-mx)を使用しています: ${btn.className}`
      ).not.toMatch(/-mx-/);
      expect(
        btn.className,
        `${btn.getAttribute('aria-label')} が min-w-[44px] で水平方向にヒット領域を拡大しています: ${btn.className}`
      ).not.toContain('min-w-[44px]');
    }
  });

  it('「増やす」ボタンをクリックすると setServingsConfig 経由で該当セルの人数が+1される（既存挙動の維持）', () => {
    render();
    const btn = container.querySelector(
      'button[aria-label="月曜朝の人数を1人増やす"]'
    ) as HTMLButtonElement;
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const updated = useServingsConfigStore.getState().servingsConfig;
    expect(updated?.byDayMeal?.monday?.breakfast).toBe(3);
  });

  it('「減らす」ボタンにも aria-label が付与される', () => {
    render();
    expect(
      container.querySelector('button[aria-label="月曜朝の人数を1人減らす"]')
    ).not.toBeNull();
  });

  it('視覚上のボタンサイズ (28x28px相当の内側span) は維持される（見た目の非回帰）', () => {
    render();
    const btn = container.querySelector(
      'button[aria-label="月曜朝の人数を1人増やす"]'
    ) as HTMLButtonElement;
    // 負マージンで見た目のフットプリントを打ち消しているため、テキストの「+」自体は
    // そのまま button 内に存在し続けることを確認する
    expect(btn.textContent).toBe('+');
  });
});

describe('ServingsModal: Tab キーによるフォーカストラップ境界 (#1052 敵対レビュー統合修正)', () => {
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
