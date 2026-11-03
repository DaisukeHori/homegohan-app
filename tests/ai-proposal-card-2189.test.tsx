/**
 * #2189 W1 AI 相談 (Web) の提案のカードの扱いと種類の名前 (src/components/AIChatBubble.tsx)
 *
 * 問題 (修正前):
 *   - SSE の自動実行が成功しても提案のカードが残り、押すと 404 で『アクションの実行に失敗しました』の alert が出た
 *   - 実行できない提案 (やり直せない失敗・記録が無い) にも「実行する」が出て、押すと 404
 *   - generate_single_meal が ACTION_LABELS に無く、カードの見出しに英字の種類名が出た。成功の文も『✅ アクションを実行しました！』
 *
 * 直したあと:
 *   - SSE の自動実行が成功したら、カードを出さない (サーバーが提案を返しても出さない)。成功の文の名前は actionResult.actionType から引く
 *   - サーバーが proposedActionExecutable: false を返した提案 (GET・SSE)、実行の API が retryable: false を返した提案、
 *     実行の API が 400 / 404 を返した提案は、「実行する」を出さずに案内を出す。400 / 404 は alert ではなくチャットに文を出す
 *   - generate_single_meal の見出しは『1食を作成』
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
const { AI_PROPOSED_ACTION_NOT_EXECUTABLE_GUIDE } = await import('@/lib/ai/consultation-action-lifecycle');

const SESSION_ID = 'session-1';
const MESSAGE_ID = 'message-1';
const EXECUTE_BUTTON_TEXT = '実行する';
const QUICK_PROMPT = '献立を提案してほしい';
/** ACTION_LABELS の名前 (手で書いた期待値) */
const SINGLE_MEAL_LABEL = '1食を作成';
const PANTRY_LABEL = '冷蔵庫に追加';
/** 手で書いた期待値 (定数の文が変わったらこのテストも直す) */
const GUIDE_TEXT = 'この提案はここからは実行できません。もう一度 AI に頼んでください。';
/** 自動実行の結果の文を出すまでの遅らせ (AIChatBubble の AUTO_ACTION_OUTCOME_MESSAGE_DELAY_MS = 300 ミリ秒) より長く待つ時間 */
const LONGER_THAN_AUTO_OUTCOME_DELAY_MS = 400;

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 会話の続きの POST (stream=true) の応答: 最後の finalData だけを流す */
function sse(finalData: unknown): Response {
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

/**
 * 文が出るまで待つ (自動実行の結果の文は少し遅れて足される)。
 * 待つ間に起きる更新を act の中で受けて、act を抜けるたびに画面へ反映させてから確かめる
 * (1 回の待ちと上限は tests/helpers/act-wait.ts。結果の文の遅らせ 300 ミリ秒より十分長い)
 */
async function waitForText(expected: string) {
  await pollUntil(() => text().includes(expected));
  expect(text()).toContain(expected);
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
}


function sseFinalData(aiMessage: Record<string, unknown>, actionResult: Record<string, unknown> | null) {
  return {
    userMessage: { id: 'user-2', content: '作って', isImportant: false, createdAt: '2026-11-01T00:00:00.000Z' },
    aiMessage: { id: 'ai-2', content: '作りますね', createdAt: '2026-11-01T00:00:00.000Z', ...aiMessage },
    actionExecuted: actionResult?.success === true,
    actionResult,
  };
}

async function sendFromInput() {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  expect(input).not.toBeNull();
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(input, '作って');
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const send = container.querySelector<HTMLButtonElement>('button[aria-label="メッセージを送信"]');
  expect(send).not.toBeNull();
  await click(send!);
}

function guideShown(): boolean {
  return container.querySelector('[data-testid="ai-proposed-action-not-executable"]') !== null;
}

function getMessagesWith(message: Record<string, unknown>) {
  handlers[`GET /api/ai/consultation/sessions/${SESSION_ID}/messages`] = async () =>
    json(200, {
      messages: [{ id: MESSAGE_ID, role: 'assistant', content: '提案です', createdAt: '2026-11-01T00:00:00.000Z', ...message }],
    });
}

describe('W1-b 種類の名前', () => {
  it('generate_single_meal の見出しは『1食を作成』(英字の種類名を出さない)', async () => {
    getMessagesWith({ proposedActions: { type: 'generate_single_meal', params: { date: '2026-11-02', mealType: 'dinner' } } });
    await openChat();
    expect(text()).toContain(SINGLE_MEAL_LABEL);
    expect(text()).not.toContain('generate_single_meal');
  });

  it('案内の文は手で書いた期待値と同じ', () => {
    expect(AI_PROPOSED_ACTION_NOT_EXECUTABLE_GUIDE).toBe(GUIDE_TEXT);
  });
});

describe('W1-a 相談を開き直したとき (GET の proposedActionExecutable)', () => {
  it('false: 「実行する」を出さず案内を出す。閉じるとカードが消え、断る API は呼ばない', async () => {
    getMessagesWith({ proposedActions: { type: 'generate_single_meal', params: {} }, proposedActionExecutable: false });
    await openChat();
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(text()).toContain(GUIDE_TEXT);
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="提案を閉じる"]');
    expect(close).not.toBeNull();
    await click(close!);
    expect(guideShown()).toBe(false);
    expect(text()).not.toContain(SINGLE_MEAL_LABEL);
    // 想定していない fetch (DELETE) は handlers に無いので、呼べば例外になる
  });

  it('true: 「実行する」を出す (案内は出さない)', async () => {
    getMessagesWith({ proposedActions: { type: 'add_pantry_item', params: {} }, proposedActionExecutable: true });
    await openChat();
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeDefined();
    expect(guideShown()).toBe(false);
  });
});

describe('W1-a 「実行する」の結果', () => {
  it('200 で { success: false, retryable: false }: 失敗の文を出し、カードは案内にする', async () => {
    getMessagesWith({ proposedActions: { type: 'generate_single_meal', params: {} } });
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () =>
      json(200, { success: false, result: { error: '献立生成の開始に失敗しました' }, actionType: 'generate_single_meal', retryable: false });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    expect(text()).toContain('献立生成の開始に失敗しました');
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(text()).toContain(GUIDE_TEXT);
  });

  it('200 で { success: false, retryable: true }: 「実行する」を残す (やり直せる)', async () => {
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () =>
      json(200, { success: false, result: { error: '冷蔵庫の食材の追加に失敗しました' }, actionType: 'add_pantry_item', retryable: true });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    expect(text()).toContain('冷蔵庫の食材の追加に失敗しました');
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeDefined();
    expect(guideShown()).toBe(false);
  });

  it.each([
    [404, '提案された操作が見つかりません'],
    [400, 'この操作はすでに処理されています'],
  ])('%i: alert を出さず、サーバーの文をチャットに出し、カードは案内にする', async (status, message) => {
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () => json(status, { error: message });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    expect(globalThis.alert).not.toHaveBeenCalled();
    expect(text()).toContain(message);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(text()).toContain(GUIDE_TEXT);
  });

  it('500: alert を出さず文をチャットに出し、「実行する」は残す (もう一度押せる)', async () => {
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () =>
      json(500, { error: 'サーバーでエラーが発生しました' });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    expect(globalThis.alert).not.toHaveBeenCalled();
    expect(text()).toContain('サーバーでエラーが発生しました');
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeDefined();
  });
});

describe.each([
  ['送信欄から', false],
  ['おすすめの質問から', true],
])('W1-a 会話の続きの POST (SSE) の自動実行 (%s)', (_label, fromQuickPrompt) => {
  async function send(finalData: unknown) {
    if (fromQuickPrompt) {
      handlers['GET /api/ai/consultation/sessions?status=all'] = async () => json(200, { sessions: [] });
      handlers['POST /api/ai/consultation/sessions'] = async () => json(200, { session: { id: SESSION_ID } });
    } else {
      // 開き直したときのメッセージには提案を付けない (画面のボタンが、この送信の提案のものだけになるように)
      getMessagesWith({ proposedActions: null });
    }
    handlers[`POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`] = async () => sse(finalData);
    await openChat();
    if (fromQuickPrompt) {
      await click(buttonByText(QUICK_PROMPT)!);
    } else {
      await sendFromInput();
    }
  }

  it('成功: カードを出さない (サーバーが提案を返していても)。成功の文の名前は actionResult.actionType から引く', async () => {
    await send(
      sseFinalData(
        { proposedActions: { type: 'generate_single_meal', params: {} } },
        { success: true, result: { requestId: 'r1' }, actionType: 'generate_single_meal' },
      ),
    );
    await waitForText(`✅ ${SINGLE_MEAL_LABEL}を実行しました！`);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(guideShown()).toBe(false);
  });

  it('成功で提案が null (サーバーの返し方): 成功の文は actionResult.actionType の名前 (『アクション』にならない)', async () => {
    await send(sseFinalData({ proposedActions: null }, { success: true, result: { itemId: 'p1' }, actionType: 'add_pantry_item' }));
    await waitForText(`✅ ${PANTRY_LABEL}を実行しました！`);
    expect(text()).not.toContain('✅ アクションを実行しました');
  });

  it('失敗で proposedActionExecutable: false: 失敗の文を出し、カードは案内', async () => {
    await send(
      sseFinalData(
        { proposedActions: { type: 'generate_single_meal', params: {} }, proposedActionExecutable: false },
        { success: false, result: { error: '献立生成の開始に失敗しました' }, actionType: 'generate_single_meal' },
      ),
    );
    await waitForText('献立生成の開始に失敗しました');
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(text()).toContain(GUIDE_TEXT);
  });

  it('失敗で proposedActionExecutable: true: 「実行する」を出す', async () => {
    await send(
      sseFinalData(
        { proposedActions: { type: 'add_pantry_item', params: {} }, proposedActionExecutable: true },
        { success: false, result: { error: '冷蔵庫の食材の追加に失敗しました' }, actionType: 'add_pantry_item' },
      ),
    );
    await waitForText('冷蔵庫の食材の追加に失敗しました');
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeDefined();
    expect(guideShown()).toBe(false);
    // 結果の文を出すまでの遅らせより長く待っても変わらない
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, LONGER_THAN_AUTO_OUTCOME_DELAY_MS));
    });
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeDefined();
  });
});

// ═════════════════════════════════════════════
// #2195 V2 「実行する」を出さない理由で案内の文を分ける・例外 (500) と上限 (429) の retryable: false
// ═════════════════════════════════════════════
/** 手で書いた期待値 (実行中・実行済みの案内。頼み直しを勧めない) */
const RUNNING_OR_DONE_GUIDE_TEXT = 'この提案は実行中か実行済みです。';
/** 今日の上限の本文 (aiDailyLimitPayload の形) */
const DAILY_LIMIT_BODY = { error: '今日の AI の利用回数の上限に達しました', code: 'AI_DAILY_LIMIT', limit: 10, retryAfter: 3600 };

describe('#2195 V2 相談を開き直したとき (GET の proposedActionNotExecutableReason)', () => {
  it('runningOrDone: 『実行中か実行済み』の案内 (頼み直しの案内は出さない)', async () => {
    getMessagesWith({
      proposedActions: { type: 'generate_single_meal', params: {} },
      proposedActionExecutable: false,
      proposedActionNotExecutableReason: 'runningOrDone',
    });
    await openChat();
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(text()).toContain(RUNNING_OR_DONE_GUIDE_TEXT);
    expect(text()).not.toContain(GUIDE_TEXT);
  });

  it('failed: 『もう一度 AI に頼んでください』の案内', async () => {
    getMessagesWith({
      proposedActions: { type: 'generate_single_meal', params: {} },
      proposedActionExecutable: false,
      proposedActionNotExecutableReason: 'failed',
    });
    await openChat();
    expect(text()).toContain(GUIDE_TEXT);
    expect(text()).not.toContain(RUNNING_OR_DONE_GUIDE_TEXT);
  });
});

describe('#2195 V2 「実行する」の結果の理由', () => {
  it.each([
    [400, 'この操作はすでに処理されています'],
    [404, '提案された操作が見つかりません'],
  ])('%i で理由 runningOrDone: 『実行中か実行済み』の案内にする', async (status, message) => {
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () =>
      json(status, { error: message, notExecutableReason: 'runningOrDone' });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    expect(text()).toContain(message);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(text()).toContain(RUNNING_OR_DONE_GUIDE_TEXT);
    expect(text()).not.toContain(GUIDE_TEXT);
  });

  it('404 で理由が読めない値: 『もう一度 AI に頼んでください』の案内', async () => {
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () =>
      json(404, { error: '提案された操作が見つかりません', notExecutableReason: 'running' });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    expect(text()).toContain(GUIDE_TEXT);
  });

  it('500 で retryable: false (献立の生成の例外): 「実行する」を出さず案内にする (以前は残り、押すと 400 になった)', async () => {
    getMessagesWith({ proposedActions: { type: 'generate_single_meal', params: {} } });
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () =>
      json(500, { error: 'サーバーでエラーが発生しました', code: 'INTERNAL_ERROR', retryable: false, notExecutableReason: 'failed' });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    expect(globalThis.alert).not.toHaveBeenCalled();
    expect(text()).toContain('サーバーでエラーが発生しました');
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(text()).toContain(GUIDE_TEXT);
  });

  it('500 で retryable: true: 「実行する」を残す (もう一度押せる)', async () => {
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () =>
      json(500, { error: 'サーバーでエラーが発生しました', code: 'INTERNAL_ERROR', retryable: true });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeDefined();
    expect(guideShown()).toBe(false);
  });

  it('429 (今日の上限) で retryable: false (行を戻せなかった): チャットに重ねて文は出さず、カードは案内にする', async () => {
    getMessagesWith({ proposedActions: { type: 'generate_single_meal', params: {} } });
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () =>
      json(429, { ...DAILY_LIMIT_BODY, retryable: false, notExecutableReason: 'failed' });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    expect(text()).not.toContain(DAILY_LIMIT_BODY.error);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(text()).toContain(GUIDE_TEXT);
  });

  it('429 (今日の上限) で retryable が無い (戻せた): 「実行する」を残す (明日また実行できる)', async () => {
    getMessagesWith({ proposedActions: { type: 'generate_single_meal', params: {} } });
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () => json(429, DAILY_LIMIT_BODY);
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeDefined();
    expect(guideShown()).toBe(false);
  });
});

describe('#2195 V2 会話の続きの POST (SSE) の proposedActionNotExecutableReason', () => {
  async function send(finalData: unknown) {
    getMessagesWith({ proposedActions: null });
    handlers[`POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`] = async () => sse(finalData);
    await openChat();
    await sendFromInput();
  }

  it('理由 failed: 『もう一度 AI に頼んでください』の案内', async () => {
    await send(
      sseFinalData(
        {
          proposedActions: { type: 'add_pantry_item', params: {} },
          proposedActionExecutable: false,
          proposedActionNotExecutableReason: 'failed',
        },
        { success: false, result: { error: '権限がありません' }, actionType: 'add_pantry_item' },
      ),
    );
    await waitForText('権限がありません');
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(text()).toContain(GUIDE_TEXT);
  });

  it('理由 runningOrDone: 『実行中か実行済み』の案内', async () => {
    await send(
      sseFinalData(
        {
          proposedActions: { type: 'add_pantry_item', params: {} },
          proposedActionExecutable: false,
          proposedActionNotExecutableReason: 'runningOrDone',
        },
        { success: false, result: { error: '冷蔵庫の食材の追加に失敗しました' }, actionType: 'add_pantry_item' },
      ),
    );
    await waitForText('冷蔵庫の食材の追加に失敗しました');
    expect(text()).toContain(RUNNING_OR_DONE_GUIDE_TEXT);
    expect(text()).not.toContain(GUIDE_TEXT);
  });

  it('理由が読めない値は写さない (『もう一度 AI に頼んでください』の案内)', async () => {
    await send(
      sseFinalData(
        {
          proposedActions: { type: 'add_pantry_item', params: {} },
          proposedActionExecutable: false,
          proposedActionNotExecutableReason: 'unknown',
        },
        { success: false, result: { error: '冷蔵庫の食材の追加に失敗しました' }, actionType: 'add_pantry_item' },
      ),
    );
    await waitForText('冷蔵庫の食材の追加に失敗しました');
    expect(text()).toContain(GUIDE_TEXT);
    expect(text()).not.toContain(RUNNING_OR_DONE_GUIDE_TEXT);
  });
});

// ═════════════════════════════════════════════
// #2201 U3 行が実行中の印のまま (実行中か、実行のあとに書き戻せなかった) の理由 unconfirmed。
// その場 (実行の API・会話の続きの POST) と開き直したとき (GET) で同じ文を出す (以前はその場では『もう一度 AI に頼んでください』、
// 開き直すと『実行中か実行済みです』で食い違い、429 では全画面の『明日また』と並んでいた)
// ═════════════════════════════════════════════
/** 手で書いた期待値 (実行したとも言い切らず、頼み直しも勧めない) */
const UNCONFIRMED_GUIDE_TEXT = 'この提案を実行できたかを確かめられませんでした。しばらくしてから相談を開き直してください。';

describe('#2201 U3 理由 unconfirmed の案内', () => {
  it('開き直したとき (GET) の理由 unconfirmed: 「実行する」を出さず、確かめられない旨の案内', async () => {
    getMessagesWith({
      proposedActions: { type: 'generate_single_meal', params: {} },
      proposedActionExecutable: false,
      proposedActionNotExecutableReason: 'unconfirmed',
    });
    await openChat();
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(text()).toContain(UNCONFIRMED_GUIDE_TEXT);
    expect(text()).not.toContain(GUIDE_TEXT);
    expect(text()).not.toContain(RUNNING_OR_DONE_GUIDE_TEXT);
  });

  it.each([
    [500, { error: 'サーバーでエラーが発生しました', code: 'INTERNAL_ERROR', retryable: false, notExecutableReason: 'unconfirmed' }],
    [200, { success: false, result: { error: '冷蔵庫の食材の追加に失敗しました' }, actionType: 'add_pantry_item', retryable: false, notExecutableReason: 'unconfirmed' }],
  ])('「実行する」の結果 %i で理由 unconfirmed: 開き直したときと同じ案内にする', async (status, body) => {
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () => json(status, body);
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(text()).toContain(UNCONFIRMED_GUIDE_TEXT);
    expect(text()).not.toContain(GUIDE_TEXT);
  });

  it('429 (今日の上限) で理由 unconfirmed: 頼み直しの案内を出さない (全画面の『明日また』と並べない)', async () => {
    getMessagesWith({ proposedActions: { type: 'generate_single_meal', params: {} } });
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () =>
      json(429, { ...DAILY_LIMIT_BODY, retryable: false, notExecutableReason: 'unconfirmed' });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(text()).toContain(UNCONFIRMED_GUIDE_TEXT);
    expect(text()).not.toContain(GUIDE_TEXT);
  });

  it('会話の続きの POST (SSE) の理由 unconfirmed: 開き直したときと同じ案内', async () => {
    getMessagesWith({ proposedActions: null });
    handlers[`POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`] = async () =>
      sse(
        sseFinalData(
          {
            proposedActions: { type: 'add_pantry_item', params: {} },
            proposedActionExecutable: false,
            proposedActionNotExecutableReason: 'unconfirmed',
          },
          { success: false, result: { error: '冷蔵庫の食材の追加に失敗しました' }, actionType: 'add_pantry_item' },
        ),
      );
    await openChat();
    await sendFromInput();
    await waitForText('冷蔵庫の食材の追加に失敗しました');
    expect(text()).toContain(UNCONFIRMED_GUIDE_TEXT);
    expect(text()).not.toContain(GUIDE_TEXT);
  });
});
