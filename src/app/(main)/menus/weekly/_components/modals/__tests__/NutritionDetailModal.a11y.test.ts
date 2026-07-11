// src/app/(main)/menus/weekly/_components/modals/__tests__/NutritionDetailModal.a11y.test.ts
// #1052 (体系的 a11y): このモーダルは独自の backdrop/panel を持つ「自己完結型」だったため、
// 共通 BottomSheet（role="dialog"/aria-modal/フォーカストラップ/Escape/背景スクロールロック）
// への載せ替えを行った。BottomSheet 経由でも既存の isOpen 制御（showNutritionDetailModal）が
// 変わらず機能し、role/aria-modal/Escape が実際に効くことを検証する。

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { NutritionDetailModal } from '../NutritionDetailModal';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;

const weekDates = [
  { date: new Date('2026-07-06'), dateStr: '2026-07-06', dayOfWeek: '月' },
];

const baseProps = {
  selectedDayIndex: 0,
  weekDates,
  dayNutrition: {},
  mealCount: 2,
  radarChartNutrients: ['protein_g', 'fat_g', 'carbs_g'],
  isEditingRadarNutrients: false,
  tempRadarNutrients: [],
  isSavingRadarNutrients: false,
  isLoadingFeedback: false,
  praiseComment: null,
  nutritionFeedback: null,
  nutritionTip: null,
  onOpenImprove: () => {},
  onRefetchFeedback: () => {},
  onStartEditRadar: () => {},
  onCancelEditRadar: () => {},
  onToggleRadarNutrient: () => {},
  onSaveRadarNutrients: () => {},
};

beforeEach(() => {
  if (typeof (globalThis as any).ResizeObserver === 'undefined') {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
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

describe('NutritionDetailModal: BottomSheet 化による dialog a11y (#1052)', () => {
  it('showNutritionDetailModal=false のときは role="dialog" がレンダリングされない（isOpen 制御の維持）', () => {
    act(() => {
      root.render(h(NutritionDetailModal, { ...baseProps, showNutritionDetailModal: false, onClose: () => {} }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('showNutritionDetailModal=true のとき role="dialog" aria-modal="true" aria-labelledby でレンダリングされる', () => {
    act(() => {
      root.render(h(NutritionDetailModal, { ...baseProps, showNutritionDetailModal: true, onClose: () => {} }));
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog!.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent).toContain('の栄養分析');
  });

  it('Escape キーで onClose が呼ばれる（BottomSheet の Escape 機構が機能している）', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(h(NutritionDetailModal, { ...baseProps, showNutritionDetailModal: true, onClose }));
    });
    act(() => {
      pressEscape();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('閉じるボタンに aria-label="閉じる" があり、44px相当のヒット領域(p-3)を持つ', () => {
    const onClose = vi.fn();
    act(() => {
      root.render(h(NutritionDetailModal, { ...baseProps, showNutritionDetailModal: true, onClose }));
    });
    const closeBtn = container.querySelector('button[aria-label="閉じる"]') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    expect(closeBtn.className).toContain('p-3');
    act(() => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('開いたときにフォーカスがダイアログ内に移動する', async () => {
    act(() => {
      root.render(h(NutritionDetailModal, { ...baseProps, showNutritionDetailModal: true, onClose: () => {} }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
