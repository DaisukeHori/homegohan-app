// src/__tests__/hooks/useV4MenuGeneration-storage-failure-2265.test.ts
// #2265 Q2: 依頼が受け付けられたあとの、生成中の印 (localStorage の v4MenuGenerating) の保存が失敗しても (容量の超過・保存の禁止)、
// useV4MenuGeneration は依頼の成功として進める。以前は保存の例外が依頼の失敗と同じ catch に入り、作成はサーバーで進むのに
// 失敗の一文 (onError) を出し、呼び出し側は進捗を購読しなかった。印は再読み込みのときに進捗を戻すためだけのもの。

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    throw new Error('この検査では Supabase に繋がない');
  },
}));

import { useV4MenuGeneration } from '@/hooks/useV4MenuGeneration';

type Hook = ReturnType<typeof useV4MenuGeneration>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REQUEST_ID = 'req-2265';
const TOTAL_SLOTS = 3;

let container: HTMLDivElement;
let root: Root;
let hook: Hook | null = null;
const onError = vi.fn();
const onGenerationStart = vi.fn();
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function Harness() {
  hook = useV4MenuGeneration({ onError, onGenerationStart });
  return null;
}

const PARAMS = {
  targetSlots: [{ date: '2026-11-06', mealType: 'breakfast' as const }],
  constraints: {},
  note: '',
};

beforeEach(() => {
  localStorage.clear();
  onError.mockReset();
  onGenerationStart.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ requestId: REQUEST_ID, totalSlots: TOTAL_SLOTS }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  hook = null;
});

describe('useV4MenuGeneration: 受け付けたあとの生成中の印の保存の失敗は、依頼の成功として進める (#2265 Q2)', () => {
  it.each([
    { failure: '容量の超過', error: new DOMException('The quota has been exceeded.', 'QuotaExceededError') },
    { failure: '保存の禁止', error: new DOMException('The operation is insecure.', 'SecurityError') },
  ])('$failure: 依頼の応答を返し、onGenerationStart を呼び、onError を呼ばず、作成中の印を真のまま持つ', async ({ error }) => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw error;
    });
    let result: unknown = null;
    let thrown: unknown = null;
    await act(async () => {
      result = await hook!.generate(PARAMS).catch((e: unknown) => {
        thrown = e;
        return null;
      });
    });

    expect(setItem).toHaveBeenCalledWith('v4MenuGenerating', expect.any(String));
    // 直す前: 保存の例外で失敗にし、onError に保存の例外の文を渡して投げ、作成中の印を下ろしていた
    expect(thrown).toBeNull();
    expect(result).toEqual({ requestId: REQUEST_ID, totalSlots: TOTAL_SLOTS });
    expect(onError).not.toHaveBeenCalled();
    expect(onGenerationStart).toHaveBeenCalledTimes(1);
    expect(onGenerationStart).toHaveBeenCalledWith(REQUEST_ID);
    expect(hook!.isGenerating).toBe(true);
    expect(hook!.error).toBeNull();
    expect(hook!.requestId).toBe(REQUEST_ID);
  });

  it('対照: 保存できるときは、印を保存する (以前のまま)', async () => {
    await act(async () => {
      await hook!.generate(PARAMS);
    });
    const stored = JSON.parse(localStorage.getItem('v4MenuGenerating') ?? 'null') as { requestId?: unknown } | null;
    expect(stored?.requestId).toBe(REQUEST_ID);
    expect(onGenerationStart).toHaveBeenCalledWith(REQUEST_ID);
  });
});
