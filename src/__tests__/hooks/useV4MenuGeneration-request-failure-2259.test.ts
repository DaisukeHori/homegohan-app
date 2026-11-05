// src/__tests__/hooks/useV4MenuGeneration-request-failure-2259.test.ts
// #2259 P1: 依頼の POST が受け付けられなかった (同意以外の失敗: HTTP の失敗・通信の失敗・時間切れ) ときも、useV4MenuGeneration は
// 作成中の印 (isGenerating) を下ろす。以前は同意で止められたときだけ下ろし、ほかの失敗では真のまま残ったので、AI 相談の
// 『1日献立変更』と『作成する』がページを読み込み直すまで押せなかった (下ろすのは進捗の完了・失敗と cancelGeneration だけで、
// 受け付けられなかった依頼の進捗は届かない)。依頼の POST に任意の時間の上限 (timeLimitMs) を付けられることも確かめる。

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    throw new Error('この検査では Supabase に繋がない');
  },
}));

import { useV4MenuGeneration } from '@/hooks/useV4MenuGeneration';
import {
  CONSULTATION_REQUEST_TIMEOUT_ERROR_MESSAGE,
  ConsultationRequestTimeoutError,
} from '@/lib/ai/consultation-request-time-limit';

type Hook = ReturnType<typeof useV4MenuGeneration>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 依頼の時間の上限 (テストの値。偽の時刻で進める) */
const TEST_TIME_LIMIT_MS = 5_000;

let container: HTMLDivElement;
let root: Root;
let hook: Hook | null = null;
const onError = vi.fn();
const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function Harness() {
  hook = useV4MenuGeneration({ onError });
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
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
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
  vi.useRealTimers();
  localStorage.clear();
  hook = null;
});

/** 依頼を出し、失敗 (投げた例外) を返す */
async function generateExpectingFailure(params: Parameters<Hook['generate']>[0] = PARAMS): Promise<unknown> {
  let thrown: unknown = null;
  await act(async () => {
    await hook!.generate(params).catch((e: unknown) => {
      thrown = e;
    });
  });
  return thrown;
}

describe('useV4MenuGeneration: 依頼が受け付けられなかったら作成中の印を下ろす (#2259 P1)', () => {
  it.each([
    { failure: '500', respond: async () => new Response(JSON.stringify({ error: 'internal' }), { status: 500 }), message: 'internal' },
    {
      failure: '通信の失敗 (fetch が投げる)',
      respond: async () => {
        throw new TypeError('Failed to fetch');
      },
      message: 'Failed to fetch',
    },
  ])('$failure: isGenerating を下ろし、onError に文を渡して投げる', async ({ respond, message }) => {
    fetchMock.mockImplementation(respond);
    const thrown = await generateExpectingFailure();

    expect(thrown).toBeInstanceOf(Error);
    expect(hook!.isGenerating).toBe(false);
    expect(hook!.error).toBe(message);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(message);
    expect(localStorage.getItem('v4MenuGenerating')).toBeNull();
  });

  it('受け付けた依頼は、進捗の完了・失敗まで isGenerating を真のまま持つ (以前のまま)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ requestId: 'req-2259', totalSlots: 1 }), { status: 200 }));
    await act(async () => {
      await hook!.generate(PARAMS);
    });
    expect(hook!.isGenerating).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('timeLimitMs を渡すと、上限までに応答が返らなければ打ち切り、時間切れの文で失敗にして印を下ろす', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let signal: AbortSignal | null = null;
    fetchMock.mockImplementation((_input, init) => {
      signal = init?.signal ?? null;
      return new Promise<Response>(() => {});
    });
    let thrown: unknown = null;
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = hook!.generate({ ...PARAMS, timeLimitMs: TEST_TIME_LIMIT_MS }).catch((e: unknown) => {
        thrown = e;
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEST_TIME_LIMIT_MS - 1);
    });
    expect(thrown).toBeNull();
    expect(hook!.isGenerating).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await pending;
    });
    expect(thrown).toBeInstanceOf(ConsultationRequestTimeoutError);
    expect(signal).not.toBeNull();
    expect(signal!.aborted).toBe(true);
    expect(hook!.isGenerating).toBe(false);
    expect(onError).toHaveBeenCalledWith(CONSULTATION_REQUEST_TIMEOUT_ERROR_MESSAGE);
  });

  it('timeLimitMs を渡さなければ、打ち切りの signal を付けない (週間献立の画面など、以前のまま)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ requestId: 'req-2259', totalSlots: 1 }), { status: 200 }));
    await act(async () => {
      await hook!.generate(PARAMS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal).toBeUndefined();
  });
});
