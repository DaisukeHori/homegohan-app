/**
 * Web の V4GenerateModal (献立の AI アシスタント) の「期間を指定」の残り (#1498。#1463・#1482 の続き)
 *
 *   1. 保存した期間が無いときの終了日の既定に、期間の上限 (今日を含む最大31日) をかける。
 *      以前は表示中の週の終わりをそのまま使い、先の週 (今日 + 30 日より先) を表示して開くと、範囲で生成を押しても
 *      slot-builder が投げて何も起きなかった (サーバーは 400 を返すので、データは壊れない)。モバイルは #1482 で直した
 *   2. 生成ボタンで、生成の対象 (slot) を作るところ (buildTargetSlots) が投げたら、画面に文を出して止める (モバイルと同じ)。
 *      以前は捕まえず、押しても何も起きなかった
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDaysToDate } from '@homegohan/shared';

const slotBuilder = vi.hoisted(() => ({ throwOnRange: null as unknown }));

vi.mock('@/lib/slot-builder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/slot-builder')>();
  return {
    ...actual,
    buildRangeSlots: (...args: Parameters<typeof actual.buildRangeSlots>) => {
      if (slotBuilder.throwOnRange !== null) throw slotBuilder.throwOnRange;
      return actual.buildRangeSlots(...args);
    },
  };
});

// 同意画面は出さない (同意済みとして進める)
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: async () => 'consented' as const, consentModal: null }),
}));

import {
  defaultRangeEnd,
  GENERATE_RANGE_INVALID_MESSAGE,
  V4GenerateModal,
} from '@/components/ai-assistant/V4GenerateModal';

/** 期間の長さの上限 (開始日を含む日数。画面の説明「最大31日」)。手で書いた期待値 */
const EXPECTED_RANGE_MAX_DAYS = 31;
/** 上限よりずっと先の日付 (今日からの日数) */
const FAR_FUTURE_DAYS = 3650;
/** 保存した期間が無いとき、表示中の週が過ぎていれば今日から何日後までにするか (今日を含めて 1 週間)。手で書いた期待値 */
const EXPECTED_DEFAULT_DAYS_AFTER_TODAY = 6;
const STORAGE_KEY_RANGE_DAYS = 'v4_range_days';

/** 端末の暦での今日 (モーダルと同じ求め方) */
function deviceToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

let container: HTMLDivElement;
let root: Root;
let alertSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  slotBuilder.throwOnRange = null;
  alertSpy = vi.fn();
  vi.stubGlobal('alert', alertSpy);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderModal(weekEndDate: string) {
  const today = deviceToday();
  const onGenerate = vi.fn().mockResolvedValue(undefined);
  await act(async () => {
    root.render(
      createElement(V4GenerateModal, {
        isOpen: true,
        onClose: vi.fn(),
        mealPlanDays: [],
        weekStartDate: today,
        weekEndDate,
        onGenerate,
        isGenerating: false,
      }),
    );
  });
  return { onGenerate, today };
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`ボタン「${text}」が無い`);
  return button;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** 「期間を指定」を選び、開始日・終了日の欄の値を返す */
async function openRange(): Promise<{ start: string; end: string }> {
  await click(buttonWithText('期間を指定'));
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
  expect(inputs).toHaveLength(2);
  return { start: inputs[0].value, end: inputs[1].value };
}

describe('defaultRangeEnd: 保存した期間が無いときの終了日の既定 (#1498)', () => {
  const today = '2026-10-12';

  it('表示中の週の終わりが今日以降で、期間の上限の中なら、その日', () => {
    expect(defaultRangeEnd(today, '2026-10-18')).toBe('2026-10-18');
  });

  it('表示中の週の終わりが期間の上限 (今日 + 30 日) より先なら、上限に収める', () => {
    expect(defaultRangeEnd(today, addDaysToDate(today, FAR_FUTURE_DAYS))).toBe(addDaysToDate(today, EXPECTED_RANGE_MAX_DAYS - 1));
    // 上限ちょうどはそのまま、1 日先は上限に
    expect(defaultRangeEnd(today, addDaysToDate(today, EXPECTED_RANGE_MAX_DAYS - 1))).toBe(addDaysToDate(today, EXPECTED_RANGE_MAX_DAYS - 1));
    expect(defaultRangeEnd(today, addDaysToDate(today, EXPECTED_RANGE_MAX_DAYS))).toBe(addDaysToDate(today, EXPECTED_RANGE_MAX_DAYS - 1));
  });

  it('表示中の週が過ぎていれば、今日から 1 週間 (以前どおり)', () => {
    expect(defaultRangeEnd(today, '2026-10-01')).toBe(addDaysToDate(today, EXPECTED_DEFAULT_DAYS_AFTER_TODAY));
  });
});

describe('V4GenerateModal (Web): 保存した期間が無く、先の週を表示して開いたとき (#1498)', () => {
  it('終了日の既定を期間の上限に収め、そのまま生成すると 31 日分の slot を渡す (以前は何も起きなかった)', async () => {
    const { onGenerate, today } = await renderModal(addDaysToDate(deviceToday(), FAR_FUTURE_DAYS));

    const { start, end } = await openRange();
    expect(start).toBe(today);
    expect(end).toBe(addDaysToDate(today, EXPECTED_RANGE_MAX_DAYS - 1));

    await click(buttonWithText('献立を生成'));

    expect(alertSpy).not.toHaveBeenCalled();
    expect(onGenerate).toHaveBeenCalledTimes(1);
    const dates = new Set(onGenerate.mock.calls[0][0].targetSlots.map((slot: { date: string }) => slot.date));
    expect(dates.size).toBe(EXPECTED_RANGE_MAX_DAYS);
    expect([...dates].sort()).toEqual(
      Array.from({ length: EXPECTED_RANGE_MAX_DAYS }, (_, i) => addDaysToDate(today, i)),
    );
  });

  it('保存した期間があれば、以前どおりそれを今日からの日数で復元する (上限の中)', async () => {
    localStorage.setItem(STORAGE_KEY_RANGE_DAYS, JSON.stringify({ startDays: 2, endDays: 9 }));
    const { today } = await renderModal(addDaysToDate(deviceToday(), FAR_FUTURE_DAYS));

    const { start, end } = await openRange();
    expect(start).toBe(addDaysToDate(today, 2));
    expect(end).toBe(addDaysToDate(today, 9));
  });
});

describe('V4GenerateModal (Web): 生成の対象を作るところが投げたら、画面に文を出して止める (#1498。モバイルと同じ)', () => {
  it('Error なら、その文 (slot-builder の「期間は最大31日までです」など) を出し、生成を依頼しない', async () => {
    const { onGenerate } = await renderModal(addDaysToDate(deviceToday(), 6));
    await openRange();
    slotBuilder.throwOnRange = new Error(`期間は最大${EXPECTED_RANGE_MAX_DAYS}日までです`);

    await click(buttonWithText('献立を生成'));

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith('期間は最大31日までです');
    expect(onGenerate).not.toHaveBeenCalled();
    // ボタンは押せるまま (送信中のまま止まらない)
    expect(buttonWithText('献立を生成').disabled).toBe(false);
  });

  it('Error でないものが投げられたら、決まった文を出す', async () => {
    const { onGenerate } = await renderModal(addDaysToDate(deviceToday(), 6));
    await openRange();
    slotBuilder.throwOnRange = 'unexpected';

    await click(buttonWithText('献立を生成'));

    expect(GENERATE_RANGE_INVALID_MESSAGE).toBe('期間が正しくありません');
    expect(alertSpy).toHaveBeenCalledWith(GENERATE_RANGE_INVALID_MESSAGE);
    expect(onGenerate).not.toHaveBeenCalled();
  });
});
