// src/app/(main)/menus/weekly/_components/modals/__tests__/ShoppingRangeModal.a11y.test.ts
// #1052 (体系的 a11y / 敵対レビュー統合修正):
// - role="dialog"/aria-modal/フォーカストラップ/Escape の後付け確認
// - Step2「人数を確認」の±ボタンが 24-32px でタップ領域基準未達だった問題への対応
//   （aria-label 付与 + 垂直方向のみ(min-h/-my)ヒット領域を拡大）
// - 敵対レビュー統合修正: 当初は水平方向(-mx-[10px])にもヒット領域を拡大していたが、
//   grid-cols-4 の狭いセルで隣の食事列(朝/昼/夜)の±ボタンと水平方向に重なり、
//   375px幅の実機で誤操作（別食事の人数が増減）を招くバグがあったため撤回した。

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ShoppingRangeModal } from '../ShoppingRangeModal';
import { useShoppingStore, useServingsConfigStore } from '../../../_state';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;

const currentWeekStart = new Date('2026-07-06');

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
  useShoppingStore.getState().resetShoppingState();
});

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function render(overrides: Partial<{
  onClose: () => void;
  onToggleTodayExpanded: (expanded: boolean) => void;
  onGenerate: (servingsConfig: unknown) => Promise<void>;
  isTodayExpanded: boolean;
}> = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const onToggleTodayExpanded = overrides.onToggleTodayExpanded ?? vi.fn();
  const onGenerate = overrides.onGenerate ?? vi.fn().mockResolvedValue(undefined);
  act(() => {
    root.render(
      h(ShoppingRangeModal, {
        isTodayExpanded: overrides.isTodayExpanded ?? false,
        currentWeekStart,
        onClose,
        onToggleTodayExpanded,
        onGenerate,
      })
    );
  });
  return { onClose, onToggleTodayExpanded, onGenerate };
}

describe('ShoppingRangeModal: dialog a11y (#1052)', () => {
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

  it('閉じるボタンに aria-label="閉じる" が付与される', () => {
    render();
    expect(container.querySelector('button[aria-label="閉じる"]')).not.toBeNull();
  });
});

describe('ShoppingRangeModal: Step2 人数±ボタンのタップ領域とaria-label (#1052)', () => {
  beforeEach(() => {
    useShoppingStore.getState().setShoppingRangeStep('servings');
  });

  it('月曜朝の「増やす」ボタンに aria-label が付与され、垂直方向に44px相当のヒット領域クラスを持つ', () => {
    render();
    const btn = container.querySelector(
      'button[aria-label="月曜朝の人数を1人増やす"]'
    ) as HTMLButtonElement;
    expect(btn, '増やすボタンが見つかりません').not.toBeNull();
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

  it('敵対レビュー統合修正の回帰テスト: ±ボタンは水平方向の負マージン(-mx)を使わない（隣の食事列との水平衝突防止）', () => {
    render();
    const allDayMealButtons = Array.from(
      container.querySelectorAll('button[aria-label*="の人数を1人"]')
    ) as HTMLButtonElement[];
    // 7曜日 x 3食 x 2ボタン(増やす/減らす) = 42個
    expect(allDayMealButtons.length).toBe(42);
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
});
