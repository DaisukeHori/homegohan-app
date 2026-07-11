// src/app/(main)/menus/weekly/_components/modals/__tests__/NutritionDetailModal-loading-state.test.ts
// #1050 (UX2-03) 回帰防止: 栄養分析モーダルの永久スピナー問題を検証する。
//
// 旧実装は `nutritionFeedback && !isLoadingFeedback` の否定 = 「フィードバックが無ければ
// 常にスピナー」という判定だったため、isLoadingFeedback が false になっても
// nutritionFeedback が空（想定外レスポンス等）だと「分析を準備中...」が実質的に
// 永久に表示され続けた。isLoadingFeedback を最優先で判定し、ローディング終了後は
// 取得成功/失敗を明確に分岐させ、失敗時は再試行ボタンを表示することを検証する。

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
  showNutritionDetailModal: true,
  selectedDayIndex: 0,
  weekDates,
  dayNutrition: {},
  mealCount: 2,
  radarChartNutrients: ['protein_g', 'fat_g', 'carbs_g'],
  isEditingRadarNutrients: false,
  tempRadarNutrients: [],
  isSavingRadarNutrients: false,
  praiseComment: null,
  onClose: () => {},
  onOpenImprove: () => {},
  onStartEditRadar: () => {},
  onCancelEditRadar: () => {},
  onToggleRadarNutrient: () => {},
  onSaveRadarNutrients: () => {},
};

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

describe('NutritionDetailModal: 献立改善ボタン領域の状態分岐 (#1050 UX2-03)', () => {
  it('isLoadingFeedback=true のときはスピナーを表示する', () => {
    act(() => {
      root.render(
        h(NutritionDetailModal, {
          ...baseProps,
          isLoadingFeedback: true,
          nutritionFeedback: null,
          nutritionTip: null,
          onRefetchFeedback: () => {},
        })
      );
    });
    expect(container.textContent).toContain('分析を準備中...');
    expect(container.querySelector('[data-testid="nutrition-feedback-retry"]')).toBeNull();
  });

  it('isLoadingFeedback=false かつ nutritionFeedback が空でも、永久スピナーにならず再試行ボタンを表示する（バグの中心）', () => {
    act(() => {
      root.render(
        h(NutritionDetailModal, {
          ...baseProps,
          isLoadingFeedback: false,
          nutritionFeedback: null,
          nutritionTip: null,
          onRefetchFeedback: () => {},
        })
      );
    });
    // 旧実装はここで「分析を準備中...」のスピナーが出続けていた
    expect(container.textContent).not.toContain('分析を準備中...');
    const retryButton = container.querySelector('[data-testid="nutrition-feedback-retry"]');
    expect(retryButton, '再試行ボタンが表示されていません').not.toBeNull();
  });

  it('再試行ボタンをクリックすると onRefetchFeedback が選択中の日付で呼ばれる', () => {
    const onRefetchFeedback = vi.fn();
    act(() => {
      root.render(
        h(NutritionDetailModal, {
          ...baseProps,
          isLoadingFeedback: false,
          nutritionFeedback: null,
          nutritionTip: null,
          onRefetchFeedback,
        })
      );
    });
    const retryButton = container.querySelector('[data-testid="nutrition-feedback-retry"]') as HTMLButtonElement;
    expect(retryButton).not.toBeNull();
    act(() => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRefetchFeedback).toHaveBeenCalledWith('2026-07-06');
  });

  it('isLoadingFeedback=false かつ nutritionFeedback が取得できていれば「この提案で献立を改善」ボタンを表示する', () => {
    act(() => {
      root.render(
        h(NutritionDetailModal, {
          ...baseProps,
          isLoadingFeedback: false,
          nutritionFeedback: 'もう少し野菜を増やしましょう',
          nutritionTip: null,
          onRefetchFeedback: () => {},
        })
      );
    });
    expect(container.textContent).toContain('この提案で献立を改善');
    expect(container.querySelector('[data-testid="nutrition-feedback-retry"]')).toBeNull();
  });
});
