// src/components/ai-assistant/__tests__/V4GenerateModal-ultimate-mode.test.ts
// #1142 回帰防止: 献立生成モーダル (V4GenerateModal) の「究極モード」は全員に開放されている。
//
// 以前は Premium プラン向けとして、スイッチが disabled、押すと alert('…準備中です') が出るだけの飾りだった
// (プラン自体が未提供で、有効にする方法がコードのどこにも無かった)。
// ここでは次の 3 点を固定する。
//   1. スイッチが実際に操作でき、「Premium」「準備中」の表示が無い
//   2. 押した状態が、生成ボタンで onGenerate の ultimateMode にそのまま渡る
//   3. 時間と AI の呼び出しが増えるオプションなので、モーダルを開くたびに OFF に戻る
//
// NOTE: このリポジトリの vitest 設定は tsconfig の jsx:"preserve" と非互換のため、
// 既存の V4GenerateModal-overwrite-confirm.test.ts に倣い拡張子 .ts + React.createElement で JSX 構文を回避する。

import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { V4GenerateModal } from '../V4GenerateModal';

const h = React.createElement;

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: unknown;

beforeAll(() => {
  // React の act() が「テスト環境である」と分かるようにする (警告を出さないため)
  previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

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
  vi.restoreAllMocks();
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

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function findButtonByText(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text)
  );
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn as HTMLButtonElement;
}

function getToggle(): HTMLButtonElement {
  const toggle = container.querySelector('[data-testid="ultimate-mode-toggle"]');
  if (!toggle) throw new Error('究極モードのスイッチが見つかりません');
  return toggle as HTMLButtonElement;
}

type ModalProps = {
  isOpen?: boolean;
  onGenerate?: (params: any) => Promise<void>;
  mealPlanDays?: any[];
};

function renderModal({ isOpen = true, onGenerate, mealPlanDays = [] }: ModalProps = {}) {
  const today = todayStr();
  act(() => {
    root.render(
      h(V4GenerateModal, {
        isOpen,
        onClose: () => {},
        mealPlanDays,
        weekStartDate: today,
        weekEndDate: addDaysStr(today, 6),
        onGenerate: onGenerate ?? vi.fn().mockResolvedValue(undefined),
        isGenerating: false,
      })
    );
  });
}

/** 「1日献立変更」を選んで「献立を生成」を押す (既存の献立が無ければ上書き確認は出ない) */
async function generateSingleDay() {
  click(findButtonByText('1日献立変更'));
  await act(async () => {
    findButtonByText('献立を生成').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('V4GenerateModal: 究極モードは全員に開放されている (#1142)', () => {
  it('スイッチが表示され、無効化されていない', () => {
    renderModal();

    const toggle = getToggle();
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('role')).toBe('switch');
    // 既定は OFF
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // 読み上げ用の名前と説明が付いている
    expect(toggle.getAttribute('aria-label')).toBe('究極モード');
    const describedBy = toggle.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toContain('栄養バランス');
  });

  it('「Premium」「準備中」の表示が無い', () => {
    renderModal();

    const text = container.textContent ?? '';
    expect(text).toContain('究極モード');
    expect(text).not.toContain('Premium');
    expect(text).not.toContain('準備中');
  });

  it('押すと alert は出ず、ON と OFF が切り替わる', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    renderModal();

    click(getToggle());
    expect(getToggle().getAttribute('aria-checked')).toBe('true');

    click(getToggle());
    expect(getToggle().getAttribute('aria-checked')).toBe('false');

    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('OFF のまま生成すると onGenerate に ultimateMode: false が渡る', async () => {
    const onGenerate = vi.fn().mockResolvedValue(undefined);
    renderModal({ onGenerate });

    await generateSingleDay();

    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate.mock.calls[0][0].ultimateMode).toBe(false);
  });

  it('ON にして生成すると onGenerate に ultimateMode: true が渡る', async () => {
    const onGenerate = vi.fn().mockResolvedValue(undefined);
    renderModal({ onGenerate });

    click(getToggle());
    await generateSingleDay();

    expect(onGenerate).toHaveBeenCalledTimes(1);
    const args = onGenerate.mock.calls[0][0];
    expect(args.ultimateMode).toBe(true);
    // 生成の対象 (1 日 3 食) など、ほかの引数は今までどおり
    expect(args.targetSlots).toHaveLength(3);
  });

  it('既存の献立の上書き確認を通る生成でも、ON のまま onGenerate に渡る', async () => {
    const today = todayStr();
    const onGenerate = vi.fn().mockResolvedValue(undefined);
    renderModal({
      onGenerate,
      mealPlanDays: [
        { dayDate: today, meals: [{ id: 'meal-1', mealType: 'breakfast', dishName: '既存の朝食' }] },
      ],
    });

    // 「期間を指定」→「既存の献立も作り直す」を ON → 究極モードを ON
    click(findButtonByText('期間を指定'));
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    act(() => {
      checkbox.click();
    });
    click(getToggle());

    // 「献立を生成」→ 上書き確認が出て、まだ onGenerate は呼ばれない
    click(findButtonByText('献立を生成'));
    expect(onGenerate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      findButtonByText('上書きして生成する').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate.mock.calls[0][0].ultimateMode).toBe(true);
  });

  it('モーダルを閉じて開き直すと OFF に戻る (使うかどうかを毎回選ぶ)', () => {
    renderModal({ isOpen: true });
    click(getToggle());
    expect(getToggle().getAttribute('aria-checked')).toBe('true');

    // 閉じる (V4GenerateModal はコンポーネントを残したまま isOpen だけ切り替わる)
    renderModal({ isOpen: false });
    expect(container.querySelector('[data-testid="ultimate-mode-toggle"]')).toBeNull();

    // 開き直す
    renderModal({ isOpen: true });
    expect(getToggle().getAttribute('aria-checked')).toBe('false');
  });
});
