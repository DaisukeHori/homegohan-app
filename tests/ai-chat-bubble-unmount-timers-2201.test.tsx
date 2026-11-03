/**
 * #2201 AI 相談の吹き出し (src/components/AIChatBubble.tsx) の予約 (setTimeout) を、部品を外すときに取り消す。
 *
 * 問題 (直す前):
 *   - 自動実行の結果の一文 (AUTO_ACTION_OUTCOME_MESSAGE_DELAY_MS 後に setMessages して mealPlanUpdated を投げる) と、
 *     開閉のフラグの解除 (400ms 後) は、予約の戻り値を持たず、部品が外れたあとでも動いた。外れたあとに mealPlanUpdated が
 *     投げられると、受け手のページが取り直しを走らせる。テストでは環境の片付けの後に動いて「window is not defined」の
 *     未処理の例外になり、vitest が失敗 0 件のまま exit 1 になった (U4 の出荷の単体で 1 回・tests/ai-proposal-card-2189.test.tsx)
 *
 * 直したあと:
 *   - 予約はすべて、外すときに取り消す (前の依頼の読み直しの予約と同じ形)
 *   - 外す前に始めた送信が、外れたあとに終わっても、結果の一文の予約をしない
 *
 * 部品の setTimeout は偽のタイマーにして、外したあとに偽の時刻を進めても動かないことを確かめる (実時間に依らない)。
 * 文が出るまでの待ちは実時間 (tests/helpers/act-wait.ts)
 */
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollUntil } from './helpers/act-wait';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// 文が出るまでの待ち (tests/helpers/act-wait.ts) は最大 10 秒まで伸びうるので、1 件のテストの時間切れを延ばす
// (根拠と環境変数での上書きは tests/helpers/heavy-unit-test-timeout.ts)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

// 同意画面は出さない (同意済みとして進める)
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: async () => 'consented' as const, consentModal: null }),
}));
vi.mock('@/hooks/useV4MenuGeneration', () => ({
  useV4MenuGeneration: () => ({ isGenerating: false, generate: vi.fn(), subscribeToProgress: vi.fn() }),
}));
vi.mock('@/hooks/useNativeAppMode', () => ({ useNativeAppMode: () => false }));
vi.mock('@/lib/local-notification', () => ({ notifyMenuGenerated: vi.fn() }));
// アニメーションは本題ではないので、motion.* は同じタグの素の要素、AnimatePresence は子をそのまま返す
vi.mock('framer-motion', () => {
  const MOTION_ONLY_PROPS = ['initial', 'animate', 'exit', 'whileHover', 'whileTap', 'transition'];
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!cache.has(tag)) {
          cache.set(tag, (props: Record<string, unknown>) =>
            createElement(
              tag,
              Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'children' && !MOTION_ONLY_PROPS.includes(key))),
              props.children as React.ReactNode,
            ),
          );
        }
        return cache.get(tag);
      },
    },
  );
  return { motion, AnimatePresence: (props: { children?: React.ReactNode }) => props.children ?? null };
});

const { default: AIChatBubble } = await import('@/components/AIChatBubble');

const SESSION_ID = 'session-1';
const SEND_KEY = `POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`;
const LOADED_TEXT = '野菜を足しましょう';
const SENT_TEXT = '買い物リストに足して';
const REPLY_TEXT = '買い物リストに足します';
/** ACTION_LABELS の add_to_shopping_list の名前で出す一文 (手で書いた期待値) */
const EXECUTED_TEXT = '✅ 買い物リストに追加を実行しました！';
/**
 * 自動実行の結果の一文を出すまでの遅らせ (AIChatBubble の AUTO_ACTION_OUTCOME_MESSAGE_DELAY_MS = 300 ミリ秒) と、
 * 開閉のフラグの解除 (CHAT_OPEN_TOGGLE_LOCK_MS = 400 ミリ秒) のどちらよりも長く、偽の時刻を進める量 (手で書いた期待値)
 */
const PAST_ALL_COMPONENT_TIMERS_MS = 1_000;

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 会話の続きの POST (stream=true) の応答: 自動実行が成功した finalData だけを流す */
function sseExecuted(): Response {
  const finalData = {
    userMessage: { id: 'user-2', content: SENT_TEXT, isImportant: false, createdAt: '2026-11-04T00:00:00.000Z' },
    aiMessage: {
      id: 'ai-2',
      content: REPLY_TEXT,
      proposedActions: { type: 'add_to_shopping_list', params: { items: [{ name: 'にんじん' }] } },
      createdAt: '2026-11-04T00:00:01.000Z',
    },
    actionExecuted: true,
    actionResult: { success: true, actionType: 'add_to_shopping_list', result: { itemsAdded: 1 } },
  };
  return new Response(`data: ${JSON.stringify(finalData)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

let container: HTMLDivElement;
let root: Root;
let handlers: Record<string, FetchHandler>;
let mealPlanUpdated: ReturnType<typeof vi.fn>;
const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.cookie = 'aiChatBubblePosition=; max-age=0; path=/';
  localStorage.clear();
  // jsdom に無い。FAB の onPointerDown が呼ぶ
  HTMLElement.prototype.setPointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('alert', vi.fn());
  mealPlanUpdated = vi.fn();
  window.addEventListener('mealPlanUpdated', mealPlanUpdated);
  handlers = {
    'GET /api/ai/consultation/sessions?status=all': async () =>
      json(200, { sessions: [{ id: SESSION_ID, title: 'AI相談', messageCount: 1 }] }),
    [`GET /api/ai/consultation/sessions/${SESSION_ID}/messages`]: async () =>
      json(200, {
        messages: [{ id: 'old-ai', role: 'assistant', content: LOADED_TEXT, createdAt: '2026-11-03T00:00:00.000Z' }],
      }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
      const handler = handlers[key];
      if (!handler) throw new Error(`想定していない fetch: ${key}`);
      return handler(url, init);
    }),
  );
  // 部品の予約 (開閉のフラグの解除・結果の一文・送信の待ちの上限) は、テストが偽の時刻を進めるまで動かさない
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove();
  window.removeEventListener('mealPlanUpdated', mealPlanUpdated);
  HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
  vi.unstubAllGlobals();
});

function text(): string {
  return container.textContent ?? '';
}

async function waitForText(expected: string) {
  await pollUntil(() => text().includes(expected));
  expect(text()).toContain(expected);
}

/**
 * 画面を描いて、FAB をタップしてチャットを開く (会話を読み込むまで待つ)。
 * strict が真なら StrictMode の中に描く (開発のときの Next と同じく、付けた直後に外して付け直す)
 */
async function openChat({ strict = false }: { strict?: boolean } = {}) {
  await act(async () => {
    root.render(strict ? createElement(StrictMode, null, createElement(AIChatBubble)) : createElement(AIChatBubble));
  });
  const fab = container.querySelector('[data-testid="ai-chat-floating-button"]');
  expect(fab).not.toBeNull();
  await act(async () => {
    fab!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    fab!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0 }));
  });
  await waitForText(LOADED_TEXT);
}

/** 入力欄から送る。送信の POST は onSend が返す */
async function sendFromInput(onSend: FetchHandler) {
  handlers[SEND_KEY] = onSend;
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  expect(input).not.toBeNull();
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(input, SENT_TEXT);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const send = container.querySelector<HTMLButtonElement>('button[aria-label="メッセージを送信"]');
  expect(send).not.toBeNull();
  await act(async () => {
    send!.click();
  });
}

/** 偽の時刻を、部品のどの予約よりも先まで進める */
async function advancePastAllComponentTimers() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PAST_ALL_COMPONENT_TIMERS_MS);
  });
}

describe('#2201 AI 相談の吹き出しの予約は、部品を外すときに取り消す', () => {
  it('外さなければ、結果の一文の待ちが過ぎると一文を出し、mealPlanUpdated を 1 回投げる (この検査が空振りしていない)', async () => {
    await openChat();
    await sendFromInput(async () => sseExecuted());
    await waitForText(REPLY_TEXT);
    expect(text()).not.toContain(EXECUTED_TEXT);
    expect(mealPlanUpdated).not.toHaveBeenCalled();

    await advancePastAllComponentTimers();
    expect(text()).toContain(EXECUTED_TEXT);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
  });

  it('StrictMode (付けた直後に外して付け直す) でも、付け直したあとは予約が動き、一文を出して mealPlanUpdated を 1 回投げる', async () => {
    await openChat({ strict: true });
    await sendFromInput(async () => sseExecuted());
    await waitForText(REPLY_TEXT);

    await advancePastAllComponentTimers();
    expect(text()).toContain(EXECUTED_TEXT);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
  });

  it('結果の一文の待ちの間に外したら、待ちが過ぎても一文を足さず、mealPlanUpdated も投げない。予約は 1 つも残らない', async () => {
    await openChat();
    await sendFromInput(async () => sseExecuted());
    await waitForText(REPLY_TEXT);
    // 開閉のフラグの解除と、結果の一文の予約が待っている
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
    await advancePastAllComponentTimers();
    expect(mealPlanUpdated).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('送信の応答を待つ間に外し、外れたあとに応答が届いても、結果の一文の予約をせず、mealPlanUpdated も投げない', async () => {
    let respond: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    await openChat();
    await sendFromInput(() => pending);

    act(() => root.unmount());
    root = createRoot(container);
    // 外したときに残る予約は、送信の待ちの上限 (送信の finally で取り消す) の 1 つだけ
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      respond(sseExecuted());
    });
    // 外れたあとに届いた応答の続き (読み取り → 結果の一文 → finally で送信の待ちの上限を取り消す) が流れきると、
    // 予約は 0 になる (外れたあとに結果の一文を予約していたら 1 つ残る)
    await pollUntil(() => vi.getTimerCount() === 0);
    expect(vi.getTimerCount()).toBe(0);
    await advancePastAllComponentTimers();
    expect(mealPlanUpdated).not.toHaveBeenCalled();
  });
});
