// src/__tests__/hooks/useV4MenuGeneration-ultimate-mode-storage.test.ts
// Issue #1597: Web の週間献立は、再読み込みで進行中の生成を戻すとき (localStorage の v4MenuGenerating)、
// 進捗の段 (究極 / 通常) を「生成を始めたときの要求」で決める。そのため useV4MenuGeneration は、
// 生成を受け付けたときに ultimateMode (究極モードで始めたか) を v4MenuGenerating へ保存する。
// (以前は保存しておらず、画面は progress.totalSteps === 6 で見分けていた。行を作った時点の totalSteps は枠の数)

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    throw new Error('この検査では Supabase に繋がない');
  },
}));

import { useV4MenuGeneration } from '@/hooks/useV4MenuGeneration';

type Generate = ReturnType<typeof useV4MenuGeneration>['generate'];

// React の act() を使う検査であることを React に伝える (伝えないと act の警告が出る)
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let generate: Generate | null = null;

function Harness() {
  generate = useV4MenuGeneration().generate;
  return null;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ requestId: 'req-1597', totalSlots: 6 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(Harness));
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
  generate = null;
});

async function startGeneration(ultimateMode: boolean | undefined) {
  expect(generate).not.toBeNull();
  await act(async () => {
    await generate!({
      targetSlots: [{ date: '2026-10-15', mealType: 'breakfast' }],
      constraints: {},
      note: '',
      ...(ultimateMode === undefined ? {} : { ultimateMode }),
    });
  });
  const stored = localStorage.getItem('v4MenuGenerating');
  expect(stored).not.toBeNull();
  return JSON.parse(stored!) as { requestId: string; totalSlots: number; ultimateMode: unknown };
}

describe('useV4MenuGeneration: 生成を始めたときの要求 (究極モードか) を保存する (#1597)', () => {
  it('究極モードで始めた生成は ultimateMode: true を保存する', async () => {
    const stored = await startGeneration(true);
    expect(stored.requestId).toBe('req-1597');
    expect(stored.ultimateMode).toBe(true);
  });

  it('通常の生成 (枠 6) は ultimateMode: false を保存する', async () => {
    const stored = await startGeneration(false);
    expect(stored.totalSlots).toBe(6);
    expect(stored.ultimateMode).toBe(false);
  });

  it('ultimateMode を渡さない生成 (献立の改善など) は ultimateMode: false を保存する', async () => {
    const stored = await startGeneration(undefined);
    expect(stored.ultimateMode).toBe(false);
  });
});
