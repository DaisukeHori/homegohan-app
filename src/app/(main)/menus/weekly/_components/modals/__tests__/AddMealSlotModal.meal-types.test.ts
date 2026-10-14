// src/app/(main)/menus/weekly/_components/modals/__tests__/AddMealSlotModal.meal-types.test.ts
// #1446: 食事を追加するモーダルの選択肢は、5 値の手書きをやめて @homegohan/shared の
// MEAL_ORDER から導く。選択肢の値・並び・表示名が正本と一致することを、実際に描いて確かめる。

import React, { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MEAL_LABELS, MEAL_ORDER } from '@homegohan/shared';

import { AddMealSlotModal } from '../AddMealSlotModal';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;

const weekDates = [
  { date: new Date('2026-07-06'), dateStr: '2026-07-06', dayOfWeek: '月' },
];
const SELECTED_DAY_INDEX = 0;

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

function render(onSelectMealType = vi.fn()) {
  act(() => {
    root.render(
      h(AddMealSlotModal, {
        selectedDayIndex: SELECTED_DAY_INDEX,
        weekDates,
        onClose: vi.fn(),
        onSelectMealType,
      }),
    );
  });
  return { onSelectMealType };
}

/** 閉じるボタン (aria-label="閉じる") を除いた、食事の区分の選択肢のボタン */
function mealOptionButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter(
    (button) => button.getAttribute('aria-label') !== '閉じる',
  );
}

describe('AddMealSlotModal: 選択肢は MEAL_ORDER から導く (#1446)', () => {
  it('選択肢は MEAL_ORDER と同じ 5 件が同じ順に並び、表示名は MEAL_LABELS', () => {
    render();
    const labels = mealOptionButtons().map((button) => button.textContent ?? '');
    expect(labels).toHaveLength(MEAL_ORDER.length);
    MEAL_ORDER.forEach((mealType, index) => {
      expect(labels[index]).toContain(MEAL_LABELS[mealType]);
    });
  });

  it('n 番目の選択肢を押すと MEAL_ORDER の n 番目の値が渡る', () => {
    const { onSelectMealType } = render();
    const buttons = mealOptionButtons();
    buttons.forEach((button) => {
      act(() => {
        button.click();
      });
    });
    expect(onSelectMealType.mock.calls).toEqual(
      MEAL_ORDER.map((mealType) => [mealType, SELECTED_DAY_INDEX]),
    );
  });
});
