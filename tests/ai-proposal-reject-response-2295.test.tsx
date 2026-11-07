/**
 * #2295 AI 相談 (Web) の提案のカードの「断る」(rejectAction。src/components/AIChatBubble.tsx) が応答の status を見る
 *
 * 問題 (修正前): DELETE /api/ai/consultation/actions/[actionId]/execute の応答の status を見ずに、いつもカードを閉じた。
 *   - 500 (DB の失敗): 断れていないのにカードが消え、開き直すと pending のカードがまた出た
 *   - 404 (別の画面・自動実行が先に実行を始めた・実行済み。#2294): 提案が実行中・実行済みであることが伝わらなかった
 *   - 断るの応答待ちの間も「断る」「実行する」を押せた
 *
 * 直したあと:
 *   - 2xx: カードを閉じる
 *   - 404: カードを閉じず「この提案は実行中か実行済みです。」の案内にする (既存の文)
 *   - それ以外 (500・401・通信の失敗): カードを残し (「実行する」「断る」は押せるまま)、固定の失敗の文を会話に 1 つ足す
 *     (応答の本文 error の文面は出さない)
 *   - 断るの応答待ちの間は、そのカードの「実行する」「断る」を止める
 */
import { act, createElement } from 'react';
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
// 献立の生成 (V4) は本題ではない
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
const { AI_PROPOSED_ACTION_REJECT_FAILED_MESSAGE } = await import('@/lib/ai/consultation-action-lifecycle');

const SESSION_ID = 'session-1';
const MESSAGE_ID = 'message-1';
const EXECUTE_BUTTON_TEXT = '実行する';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
        messages: [
          {
            id: MESSAGE_ID,
            role: 'assistant',
            content: '買い物リストに足しますか',
            proposedActions: { type: 'add_pantry_item', params: { name: '卵' } },
            createdAt: '2026-11-01T00:00:00.000Z',
          },
        ],
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  container.remove();
  window.removeEventListener('mealPlanUpdated', mealPlanUpdated);
  HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
  vi.unstubAllGlobals();
});

function text(): string {
  return container.textContent ?? '';
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(label));
}

/** 画面を描いて、FAB をタップしてチャットを開く (セッションとメッセージを読み込むまで待つ) */
async function openChat() {
  await act(async () => {
    root.render(createElement(AIChatBubble));
  });
  const fab = container.querySelector('[data-testid="ai-chat-floating-button"]');
  expect(fab).not.toBeNull();
  await act(async () => {
    fab!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    fab!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0 }));
  });
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
}

/** 手で書いた期待値 (定数の文が変わったらこのテストも直す) */
const REJECT_FAILED_TEXT = '提案を断れませんでした。時間をおいてもう一度お試しください。';
const RUNNING_OR_DONE_GUIDE_TEXT = 'この提案は実行中か実行済みです。';
/** 提案の見出し (ACTION_LABELS の add_pantry_item の名前。手で書いた期待値) */
const PANTRY_LABEL = '冷蔵庫に追加';
/** 画面に出してはいけない応答の本文の文面 */
const RAW_SERVER_ERROR = 'raw server error text 2295';
const DELETE_KEY = `DELETE /api/ai/consultation/actions/${MESSAGE_ID}/execute`;
const EXECUTE_KEY = `POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`;

function rejectButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label="提案を断る"]');
}

function guideShown(): boolean {
  return container.querySelector('[data-testid="ai-proposed-action-not-executable"]') !== null;
}

/** 提案のカードが出ているか (見出し・ボタン・案内のどれかがある) */
function cardShown(): boolean {
  return text().includes(PANTRY_LABEL) || rejectButton() !== null || buttonByText(EXECUTE_BUTTON_TEXT) !== undefined || guideShown();
}

/** 失敗の文が会話に出ている数 */
function rejectFailedCount(): number {
  return text().split(REJECT_FAILED_TEXT).length - 1;
}

function deleteCalls(): number {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'DELETE').length;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('#2295 「断る」の応答で画面を分ける', () => {
  it('失敗の文は手で書いた期待値と同じ', () => {
    expect(AI_PROPOSED_ACTION_REJECT_FAILED_MESSAGE).toBe(REJECT_FAILED_TEXT);
  });

  it.each([200, 204])('%i: カードを閉じる (失敗の文・案内は出さない)', async (status) => {
    handlers[DELETE_KEY] = async () => (status === 204 ? new Response(null, { status }) : json(status, { success: true }));
    await openChat();
    expect(text()).toContain(PANTRY_LABEL);
    await click(rejectButton()!);
    await pollUntil(() => !cardShown());
    expect(cardShown()).toBe(false);
    expect(rejectFailedCount()).toBe(0);
    expect(deleteCalls()).toBe(1);
  });

  it('404: カードは閉じず「実行中か実行済み」の案内にする (「実行する」「断る」は出さない・失敗の文と本文は出さない)', async () => {
    handlers[DELETE_KEY] = async () => json(404, { error: RAW_SERVER_ERROR });
    await openChat();
    await click(rejectButton()!);
    await pollUntil(() => guideShown());
    expect(guideShown()).toBe(true);
    expect(text()).toContain(PANTRY_LABEL);
    expect(text()).toContain(RUNNING_OR_DONE_GUIDE_TEXT);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(rejectButton()).toBeNull();
    expect(rejectFailedCount()).toBe(0);
    expect(text()).not.toContain(RAW_SERVER_ERROR);
  });

  it.each([
    ['500', async () => json(500, { error: RAW_SERVER_ERROR })],
    ['401', async () => json(401, { error: RAW_SERVER_ERROR })],
    ['500 で本文が JSON でない', async () => new Response(RAW_SERVER_ERROR, { status: 500 })],
    ['通信の失敗 (fetch が投げる)', async (): Promise<Response> => {
      throw new TypeError(RAW_SERVER_ERROR);
    }],
  ])('%s: カードを残し (「実行する」「断る」は押せる)、固定の失敗の文を 1 つ足す。本文の文面は出さない', async (_label, handler) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    handlers[DELETE_KEY] = handler;
    await openChat();
    await click(rejectButton()!);
    await pollUntil(() => rejectFailedCount() > 0);
    expect(rejectFailedCount()).toBe(1);
    expect(text()).toContain(PANTRY_LABEL);
    expect(guideShown()).toBe(false);
    const execute = buttonByText(EXECUTE_BUTTON_TEXT);
    expect(execute).toBeDefined();
    expect(execute!.disabled).toBe(false);
    expect(rejectButton()).not.toBeNull();
    expect(rejectButton()!.disabled).toBe(false);
    expect(text()).not.toContain(RAW_SERVER_ERROR);

    // カードが残っているので、もう一度断れる (2 回目は断れた)
    handlers[DELETE_KEY] = async () => json(200, { success: true });
    await click(rejectButton()!);
    await pollUntil(() => !cardShown());
    expect(cardShown()).toBe(false);
    expect(deleteCalls()).toBe(2);
  });

  it('応答待ちの間は、そのカードの「断る」「実行する」を止める (同じ描画のうちの 2 度目の押下も断らない・実行しない)', async () => {
    const pending = deferred<Response>();
    handlers[DELETE_KEY] = () => pending.promise;
    const executeHandler = vi.fn(async () => json(200, { success: true, result: {}, actionType: 'add_pantry_item' }));
    handlers[EXECUTE_KEY] = executeHandler;
    await openChat();
    const reject = rejectButton()!;
    const execute = buttonByText(EXECUTE_BUTTON_TEXT)!;
    await act(async () => {
      reject.click();
      // 同じ描画のうちの 2 度目の押下 (ボタンの止めがまだ描かれていない)
      reject.click();
      execute.click();
    });
    expect(deleteCalls()).toBe(1);
    expect(executeHandler).not.toHaveBeenCalled();
    expect(rejectButton()!.disabled).toBe(true);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)!.disabled).toBe(true);

    await act(async () => {
      pending.resolve(json(500, { error: RAW_SERVER_ERROR }));
    });
    await pollUntil(() => rejectFailedCount() > 0);
    // 応答のあとは押せるように戻る
    expect(rejectButton()!.disabled).toBe(false);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)!.disabled).toBe(false);
    expect(deleteCalls()).toBe(1);
    expect(executeHandler).not.toHaveBeenCalled();
  });
});
