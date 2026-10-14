// src/components/ai-assistant/__tests__/V4GenerateModal-overwrite-confirm.test.ts
// #1050 (UX2-04) 回帰防止: V4GenerateModal で「既存の献立も作り直す」等、既存献立を
// 上書きする生成の前に対象件数付き確認が必ず出ることを検証する。
//
// NOTE: このリポジトリの vitest 設定は tsconfig の jsx:"preserve" と非互換のため、
// 既存の modal-contracts.test.ts に倣い拡張子 .ts + React.createElement で JSX 構文を回避する。

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { V4GenerateModal } from '../V4GenerateModal';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  localStorage.clear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.style.overflow = '';
});

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function findButtonByText(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text)
  );
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn as HTMLButtonElement;
}

describe('V4GenerateModal: 既存献立の上書き確認 (#1050 UX2-04)', () => {
  it('「既存の献立も作り直す」で既存献立がある期間を生成しようとすると、確認ダイアログが出て onGenerate は即座に呼ばれない', async () => {
    const today = todayStr();
    const weekEnd = addDaysStr(today, 6);
    const onGenerate = vi.fn().mockResolvedValue(undefined);

    const mealPlanDays = [
      {
        dayDate: today,
        meals: [
          { id: 'meal-1', mealType: 'breakfast', dishName: '既存の朝食' },
        ],
      },
    ];

    act(() => {
      root.render(
        h(V4GenerateModal, {
          isOpen: true,
          onClose: () => {},
          mealPlanDays: mealPlanDays as any,
          weekStartDate: today,
          weekEndDate: weekEnd,
          onGenerate,
          isGenerating: false,
        })
      );
    });

    // 「期間を指定」モードを選択
    act(() => {
      findButtonByText('期間を指定').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // 「既存の献立も作り直す」チェックボックスを ON にする
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    act(() => {
      checkbox.click();
    });

    // 「献立を生成」をクリック
    act(() => {
      findButtonByText('献立を生成').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // 確認無しに onGenerate が呼ばれてはいけない
    expect(onGenerate).not.toHaveBeenCalled();

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog, '上書き確認ダイアログが表示されていません').not.toBeNull();
    // 対象件数（今日の朝食1件のみ既存）が明示されていること
    expect(dialog!.textContent).toContain('1件');
    expect(dialog!.textContent).toContain('上書き');

    // 確認モーダルの「上書きして生成する」を押す
    await act(async () => {
      findButtonByText('上書きして生成する').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onGenerate).toHaveBeenCalledTimes(1);
    const callArgs = onGenerate.mock.calls[0][0];
    const overwrittenSlot = callArgs.targetSlots.find(
      (s: any) => s.date === today && s.mealType === 'breakfast'
    );
    expect(overwrittenSlot?.plannedMealId).toBe('meal-1');
  });

  it('確認ダイアログでキャンセルすると onGenerate は呼ばれない', async () => {
    const today = todayStr();
    const weekEnd = addDaysStr(today, 6);
    const onGenerate = vi.fn().mockResolvedValue(undefined);

    const mealPlanDays = [
      {
        dayDate: today,
        meals: [{ id: 'meal-1', mealType: 'breakfast', dishName: '既存の朝食' }],
      },
    ];

    act(() => {
      root.render(
        h(V4GenerateModal, {
          isOpen: true,
          onClose: () => {},
          mealPlanDays: mealPlanDays as any,
          weekStartDate: today,
          weekEndDate: weekEnd,
          onGenerate,
          isGenerating: false,
        })
      );
    });

    act(() => {
      findButtonByText('期間を指定').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      checkbox.click();
    });
    act(() => {
      findButtonByText('献立を生成').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      findButtonByText('キャンセル').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onGenerate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('空欄を埋めるモード（上書きが発生しない）では確認ダイアログを出さず即座に onGenerate される', async () => {
    const today = todayStr();
    const weekEnd = addDaysStr(today, 6);
    const onGenerate = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(
        h(V4GenerateModal, {
          isOpen: true,
          onClose: () => {},
          mealPlanDays: [] as any,
          weekStartDate: today,
          weekEndDate: weekEnd,
          onGenerate,
          isGenerating: false,
        })
      );
    });

    act(() => {
      findButtonByText('空欄を埋める').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      findButtonByText('献立を生成').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});
