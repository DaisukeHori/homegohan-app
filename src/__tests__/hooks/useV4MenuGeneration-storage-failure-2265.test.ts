// src/__tests__/hooks/useV4MenuGeneration-storage-failure-2265.test.ts
// #2265 Q2: 依頼が受け付けられたあとの、生成中の印 (localStorage の v4MenuGenerating) の保存が失敗しても (容量の超過・保存の禁止)、
// useV4MenuGeneration は依頼の成功として進める。以前は保存の例外が依頼の失敗と同じ catch に入り、作成はサーバーで進むのに
// 失敗の一文 (onError) を出し、呼び出し側は進捗を購読しなかった。印は再読み込みのときに進捗を戻すためだけのもの。
// #2272 S2: 印を下ろす removeItem (進捗の完了・失敗と cancelGeneration) が投げても (保存の禁止)、完了の反映 (onGenerationComplete)・
// 失敗の通知 (onError)・購読の解除 (unsubscribe)・作成中の印 (isGenerating) を下ろすことは必ず走る。

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

type RealtimeHandler = (payload: { new: Record<string, unknown> }) => void;

/** 進捗の購読 (subscribeToProgress) が登録した Realtime の受け口と、購読の解除の回数 */
const realtime = vi.hoisted(() => ({
  handler: null as null | ((payload: { new: Record<string, unknown> }) => void),
  unsubscribeCount: 0,
}));

vi.mock('@/lib/supabase/client', () => ({
  // 依頼 (generate) は Supabase に繋がない。進捗の購読だけが channel を使う
  createClient: () => {
    const channel = {
      on: (_event: string, _filter: unknown, handler: RealtimeHandler) => {
        realtime.handler = handler;
        return channel;
      },
      subscribe: () => channel,
      unsubscribe: () => {
        realtime.unsubscribeCount += 1;
      },
    };
    return { channel: () => channel };
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
const onGenerationComplete = vi.fn();
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function Harness() {
  hook = useV4MenuGeneration({ onError, onGenerationStart, onGenerationComplete });
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
  onGenerationComplete.mockReset();
  realtime.handler = null;
  realtime.unsubscribeCount = 0;
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

/** 保存が禁止された環境の例外 (localStorage への参照・removeItem が投げる) */
const SECURITY_ERROR = new DOMException('The operation is insecure.', 'SecurityError');

/** removeItem が投げる形 2 つ: removeItem だけが投げる / localStorage への参照そのものが投げる */
const REMOVE_FAILURES = [
  {
    failure: 'removeItem が投げる',
    install: (): (() => void) => {
      const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw SECURITY_ERROR;
      });
      return () => removeItem.mockRestore();
    },
  },
  {
    failure: 'localStorage への参照そのものが投げる',
    install: (): (() => void) => {
      const own = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => {
          throw SECURITY_ERROR;
        },
      });
      return () => {
        if (own) {
          Object.defineProperty(globalThis, 'localStorage', own);
        } else {
          delete (globalThis as { localStorage?: Storage }).localStorage;
        }
      };
    },
  },
];

/** 依頼を受け付けさせ、進捗を購読する (作成中の印は真) */
async function startAndSubscribe(onProgress: (progress: unknown) => void): Promise<void> {
  await act(async () => {
    await hook!.generate(PARAMS);
  });
  act(() => {
    hook!.subscribeToProgress(REQUEST_ID, onProgress);
  });
  expect(hook!.isGenerating).toBe(true);
  expect(realtime.handler).not.toBeNull();
}

describe('useV4MenuGeneration: 印を下ろす removeItem が投げても、完了・失敗・取り消しは最後まで走る (#2272 S2)', () => {
  it.each(REMOVE_FAILURES)('$failure: 完了の通知で、onGenerationComplete を呼び、購読を解き、作成中の印を下ろす', async ({ install }) => {
    const onProgress = vi.fn();
    await startAndSubscribe(onProgress);
    const restore = install();
    let thrown: unknown = null;
    try {
      act(() => {
        try {
          realtime.handler!({ new: { id: REQUEST_ID, status: 'completed', progress: {}, error_message: null } });
        } catch (e: unknown) {
          thrown = e;
        }
      });
    } finally {
      restore();
    }
    // 直す前: removeItem の例外が受け口から投げ、onGenerationComplete と unsubscribe が呼ばれなかった
    expect(thrown).toBeNull();
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onGenerationComplete).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(realtime.unsubscribeCount).toBe(1);
    expect(hook!.isGenerating).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('生成中の印を消せませんでした'), SECURITY_ERROR);
  });

  it.each(REMOVE_FAILURES)('$failure: 失敗の通知で、onError に行の文を渡し、購読を解き、作成中の印を下ろす', async ({ install }) => {
    await startAndSubscribe(() => undefined);
    const restore = install();
    let thrown: unknown = null;
    try {
      act(() => {
        try {
          realtime.handler!({ new: { id: REQUEST_ID, status: 'failed', progress: {}, error_message: null } });
        } catch (e: unknown) {
          thrown = e;
        }
      });
    } finally {
      restore();
    }
    // 直す前: removeItem の例外が受け口から投げ、onError と unsubscribe が呼ばれなかった
    expect(thrown).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('生成に失敗しました');
    expect(onGenerationComplete).not.toHaveBeenCalled();
    expect(realtime.unsubscribeCount).toBe(1);
    expect(hook!.isGenerating).toBe(false);
  });

  it.each(REMOVE_FAILURES)('$failure: cancelGeneration は投げずに、作成中の印と requestId を下ろす', async ({ install }) => {
    await act(async () => {
      await hook!.generate(PARAMS);
    });
    expect(hook!.isGenerating).toBe(true);
    const restore = install();
    let thrown: unknown = null;
    try {
      act(() => {
        try {
          hook!.cancelGeneration();
        } catch (e: unknown) {
          thrown = e;
        }
      });
    } finally {
      restore();
    }
    // 直す前: cancelGeneration が removeItem の例外で投げた (取り消しを押したときの例外が画面の処理まで届く)
    expect(thrown).toBeNull();
    expect(hook!.isGenerating).toBe(false);
    expect(hook!.requestId).toBeNull();
  });

  it('対照: 保存できるときは、完了の通知で印を消す (以前のまま)', async () => {
    await startAndSubscribe(() => undefined);
    expect(localStorage.getItem('v4MenuGenerating')).not.toBeNull();
    act(() => {
      realtime.handler!({ new: { id: REQUEST_ID, status: 'completed', progress: {}, error_message: null } });
    });
    expect(localStorage.getItem('v4MenuGenerating')).toBeNull();
    expect(onGenerationComplete).toHaveBeenCalledTimes(1);
    expect(realtime.unsubscribeCount).toBe(1);
  });
});
