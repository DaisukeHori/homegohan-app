// src/components/ai-assistant/__tests__/V4GenerateModal-range-max.test.ts
// #1463 回帰防止: V4GenerateModal の「期間を指定」の開始日・終了日の入力欄に上限 (max) があり、
// 上限より先の日付 (キーボードで打った日付・前回の保存からの復元) は上限に収めること。
// 以前は上限が無く、遠い未来の日付を選ぶと、端末の slot-builder とサーバーの行事の検索 (getEventsForRange) が 1 日ずつ大量に回った。
//   - 開始日: 今日 〜 今日 + 30 日 (「1日だけ」の欄の「今日から1ヶ月先まで」と同じ)
//   - 終了日: 開始日 〜 開始日 + 30 日 (画面の説明「最大31日」)
//
// NOTE: このリポジトリの vitest 設定は tsconfig の jsx:"preserve" と非互換のため、
// 既存の V4GenerateModal-overwrite-confirm.test.ts に倣い拡張子 .ts + React.createElement で JSX 構文を回避する。

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { addDaysToDate } from '@/lib/date-utils';
import { V4GenerateModal, generateRangeEndMax, generateRangeStartMax } from '../V4GenerateModal';

const h = React.createElement;

/** 開始日の上限 (今日から何日先まで)。「1日だけ」の欄と同じ */
const EXPECTED_START_MAX_DAYS_AHEAD = 30;
/** 期間の長さの上限 (開始日を含む日数)。画面の説明「最大31日」 */
const EXPECTED_RANGE_MAX_DAYS = 31;
/** 上限よりずっと先の日付 (今日からの日数) */
const FAR_FUTURE_DAYS = 3650;

const STORAGE_KEY_RANGE_DAYS = 'v4_range_days';

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

/** 端末の暦での今日 (モーダルと同じ求め方) */
function deviceToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function findButtonByText(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn as HTMLButtonElement;
}

/** 「期間を指定」の開始日・終了日の入力欄 */
function rangeInputs(): { start: HTMLInputElement; end: HTMLInputElement } {
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
  expect(inputs).toHaveLength(2);
  return { start: inputs[0], end: inputs[1] };
}

/** React の制御された入力欄に、利用者が日付を打ったときと同じ変更を送る */
function typeDate(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('HTMLInputElement の value の setter が無い');
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function renderRangeMode() {
  const today = deviceToday();
  act(() => {
    root.render(
      h(V4GenerateModal, {
        isOpen: true,
        onClose: () => {},
        mealPlanDays: [],
        weekStartDate: today,
        weekEndDate: addDaysToDate(today, 6),
        onGenerate: vi.fn().mockResolvedValue(undefined),
        isGenerating: false,
      }),
    );
  });
  act(() => {
    findButtonByText('期間を指定').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  return today;
}

describe('V4GenerateModal: 「期間を指定」の入力欄の上限 (#1463)', () => {
  it('上限の日付: 開始日は今日の 30 日後、終了日は開始日の 30 日後 (期間は最大 31 日)', () => {
    const today = '2026-10-11';
    expect(generateRangeStartMax(today)).toBe(addDaysToDate(today, EXPECTED_START_MAX_DAYS_AHEAD));
    expect(generateRangeStartMax(today)).toBe('2026-11-10');
    expect(generateRangeEndMax('2026-12-15')).toBe(addDaysToDate('2026-12-15', EXPECTED_RANGE_MAX_DAYS - 1));
    expect(generateRangeEndMax('2026-12-15')).toBe('2027-01-14');
    // 開始日が日付でない (空欄など) ときは上限を付けない
    expect(generateRangeEndMax('')).toBeUndefined();
    expect(generateRangeEndMax('2026-02-30')).toBeUndefined();
  });

  it('開始日・終了日の入力欄に min (今日) と max (上限) が付いている', () => {
    const today = renderRangeMode();
    const { start, end } = rangeInputs();

    expect(start.min).toBe(today);
    expect(start.max).toBe(addDaysToDate(today, EXPECTED_START_MAX_DAYS_AHEAD));
    expect(end.min).toBe(today);
    expect(end.max).toBe(addDaysToDate(start.value, EXPECTED_RANGE_MAX_DAYS - 1));
  });

  it('上限より先の開始日を打つと上限に収め、終了日も開始日に合わせる', () => {
    const today = renderRangeMode();

    typeDate(rangeInputs().start, addDaysToDate(today, FAR_FUTURE_DAYS));

    const { start, end } = rangeInputs();
    const startMax = addDaysToDate(today, EXPECTED_START_MAX_DAYS_AHEAD);
    expect(start.value).toBe(startMax);
    // 終了日 (今日の 6 日後) は開始日より前になったので、開始日に合わせる
    expect(end.value).toBe(startMax);
    // 終了日の上限も、新しい開始日から数える
    expect(end.max).toBe(addDaysToDate(startMax, EXPECTED_RANGE_MAX_DAYS - 1));
  });

  it('期間の上限 (開始日を含む 31 日) より先の終了日を打つと、上限に収める', () => {
    const today = renderRangeMode();
    typeDate(rangeInputs().start, today);

    typeDate(rangeInputs().end, addDaysToDate(today, FAR_FUTURE_DAYS));

    const { start, end } = rangeInputs();
    expect(start.value).toBe(today);
    expect(end.value).toBe(addDaysToDate(today, EXPECTED_RANGE_MAX_DAYS - 1));
  });

  it('開始日を前に動かして期間が 31 日を超えるときは、終了日を期間の上限に縮める', () => {
    const today = renderRangeMode();
    const startMax = addDaysToDate(today, EXPECTED_START_MAX_DAYS_AHEAD);
    typeDate(rangeInputs().start, startMax);
    typeDate(rangeInputs().end, addDaysToDate(startMax, EXPECTED_RANGE_MAX_DAYS - 1));

    typeDate(rangeInputs().start, today);

    const { start, end } = rangeInputs();
    expect(start.value).toBe(today);
    expect(end.value).toBe(addDaysToDate(today, EXPECTED_RANGE_MAX_DAYS - 1));
  });

  it('前回の保存 (今日からの日数) が上限より先でも、開いたときに上限に収める', () => {
    localStorage.setItem(
      STORAGE_KEY_RANGE_DAYS,
      JSON.stringify({ startDays: FAR_FUTURE_DAYS, endDays: FAR_FUTURE_DAYS + EXPECTED_RANGE_MAX_DAYS * 2 }),
    );
    const today = renderRangeMode();

    const { start, end } = rangeInputs();
    const startMax = addDaysToDate(today, EXPECTED_START_MAX_DAYS_AHEAD);
    expect(start.value).toBe(startMax);
    expect(end.value).toBe(addDaysToDate(startMax, EXPECTED_RANGE_MAX_DAYS - 1));
  });
});
