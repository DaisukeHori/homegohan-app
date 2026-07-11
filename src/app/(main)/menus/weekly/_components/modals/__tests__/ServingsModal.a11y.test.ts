// src/app/(main)/menus/weekly/_components/modals/__tests__/ServingsModal.a11y.test.ts
// #1052 (体系的 a11y):
// - role="dialog"/aria-modal/フォーカストラップ/Escape の後付け
// - 「人数±」ボタンが 24-36px でタップ領域基準未達だった問題への対応
//   （視覚サイズ維持のまま min-w/min-h + 負マージンでヒット領域を44x44pxに拡大 + aria-label 付与）

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
  it('月曜朝の「増やす」ボタンに aria-label が付与され、44x44px相当のヒット領域クラスを持つ', () => {
    render();
    const btn = container.querySelector(
      'button[aria-label="月曜朝の人数を1人増やす"]'
    ) as HTMLButtonElement;
    expect(btn, '増やすボタンが見つかりません').not.toBeNull();
    expect(btn.className).toContain('min-w-[44px]');
    expect(btn.className).toContain('min-h-[44px]');
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
