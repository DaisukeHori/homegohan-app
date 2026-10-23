// src/components/ai-assistant/__tests__/V4GenerateModal-ultimate-mode.test.ts
// #1142 回帰防止: 献立生成モーダル (V4GenerateModal) の「究極モード」のスイッチ。
// 有料プランで使える (billing/03 §10.3): 無料プランでは錠 (契約の要約の features.ai_feature_caps.menu_generation_ultimate が 0) を掛ける。
// 要約は useBillingSummary で読むので、ここでは vi.mock で差し替える。既存の it は要約が null (錠なし) のときの挙動を見る。
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

import React, { act } from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import type { BillingSummaryWire } from '@homegohan/shared';

const billingMocks = vi.hoisted(() => ({ summary: null as BillingSummaryWire | null, enabledCalls: [] as boolean[] }));
vi.mock('@/hooks/useBillingSummary', () => ({
  BILLING_SUBSCRIPTION_API_PATH: '/api/billing/subscription',
  useBillingSummary: (enabled: boolean) => {
    billingMocks.enabledCalls.push(enabled);
    return billingMocks.summary;
  },
}));

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
  billingMocks.summary = null;
  billingMocks.enabledCalls = [];
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

describe('V4GenerateModal: 究極モードのスイッチ (契約の要約が無いときは錠を掛けない。#1142)', () => {
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

/** 契約の要約 (GET /api/billing/subscription の data)。ai_feature_caps は引数で渡す */
function summaryWithCaps(aiFeatureCaps: Record<string, number | null>): BillingSummaryWire {
  return {
    plan_key: 'free',
    effective_plan_key: 'free',
    status: null,
    source: null,
    manage_in_store: null,
    billing_interval: null,
    current_period_end: null,
    trial_ends_at: null,
    cancel_at_period_end: false,
    cancel_at: null,
    has_customer: false,
    can_purchase: true,
    can_cancel: false,
    can_resume: false,
    features: { ai_daily_limit: 3, ai_feature_caps: aiFeatureCaps },
  };
}

describe('V4GenerateModal: 究極モードの錠 (billing/03 §10.3)', () => {
  it('locks the ultimate-mode toggle with aria-disabled and the paid-plan wording when features.ai_feature_caps.menu_generation_ultimate is 0, and leaves it operable when the summary is null or the cap is above 0', async () => {
    const PLAN_REQUIRED_TEXT = '究極モードは有料プランでお使いいただけます';

    // 無料プラン (cap = 0): 錠。押しても ON にならず、生成でも ultimateMode: false
    billingMocks.summary = summaryWithCaps({ menu_generation_ultimate: 0, menu_generation: 3 });
    const onGenerate = vi.fn().mockResolvedValue(undefined);
    renderModal({ onGenerate });
    // 開いているときに要約を読む
    expect(billingMocks.enabledCalls).toContain(true);
    let toggle = getToggle();
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector('[data-testid="ultimate-mode-lock"]')).not.toBeNull();
    const describedBy = toggle.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy as string)?.textContent).toContain(PLAN_REQUIRED_TEXT);
    click(toggle);
    expect(getToggle().getAttribute('aria-checked')).toBe('false');
    await generateSingleDay();
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate.mock.calls[0][0].ultimateMode).toBe(false);

    // 要約が読めない (null): 錠を出さず、ON にできる
    for (const [label, summary] of [
      ['要約なし', null],
      ['有料プラン (cap = 2)', summaryWithCaps({ menu_generation_ultimate: 2 })],
      ['上限なし (cap = null)', summaryWithCaps({ menu_generation_ultimate: null })],
      ['キーの無いプラン (組織のプラン)', summaryWithCaps({})],
    ] as const) {
      act(() => {
        root.unmount();
      });
      act(() => {
        root = createRoot(container);
      });
      billingMocks.summary = summary;
      renderModal();
      toggle = getToggle();
      expect(toggle.getAttribute('aria-disabled'), label).toBeNull();
      expect(container.querySelector('[data-testid="ultimate-mode-lock"]'), label).toBeNull();
      expect(container.textContent, label).not.toContain(PLAN_REQUIRED_TEXT);
      click(toggle);
      expect(getToggle().getAttribute('aria-checked'), label).toBe('true');
    }
  });

  it('turns the toggle off when the lock arrives after it was switched on (the summary loads after the modal opens)', () => {
    billingMocks.summary = null;
    renderModal();
    click(getToggle());
    expect(getToggle().getAttribute('aria-checked')).toBe('true');

    // 要約が届いて錠が掛かる (無料プラン)
    billingMocks.summary = summaryWithCaps({ menu_generation_ultimate: 0 });
    renderModal();
    expect(getToggle().getAttribute('aria-disabled')).toBe('true');
    expect(getToggle().getAttribute('aria-checked')).toBe('false');
  });
});
