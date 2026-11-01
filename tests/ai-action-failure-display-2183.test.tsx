/**
 * #2183 Z1 AI 相談の提案の実行が失敗しても「実行しました」と出ていた (既存の欠陥)
 *
 *   - 実行の API (POST /api/ai/consultation/actions/[actionId]/execute) は、アクションが失敗したときも 200 で
 *     { success: false, result } を返す。画面 (src/components/AIChatBubble.tsx の executeAction) は res.ok だけを見て
 *     『✅ …を実行しました！』と出し、提案も消していた
 *   - 会話の続きの POST (SSE) の自動実行は、失敗 (actionResult.success が偽) のときに何も出さず、無言で失敗していた。
 *     おすすめの質問のボタンから送ったときは、成功しても失敗しても何も出していなかった
 *
 * 直したあと:
 *   - success が true のときだけ『✅ …を実行しました！』。それ以外は result.error (空でない文字列) か固定の文
 *     (AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE) を出し、提案は消さずに残す。データの更新の通知 (mealPlanUpdated) もしない
 *   - 実行の通信が失敗したときも、黙らずに固定の文を出す
 *   - SSE の自動実行の結果は、送信欄から送ったときも、おすすめの質問から送ったときも同じく出す
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const {
  AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE,
  consultationActionFailureMessageOf,
  consultationActionOutcomeOf,
} = await import('@/lib/ai/consultation-action-outcome');

const SESSION_ID = 'session-1';
const MESSAGE_ID = 'message-1';
const ACTION_TYPE = 'add_to_shopping_list';
/** ACTION_LABELS の add_to_shopping_list の名前 (手で書いた期待値) */
const ACTION_LABEL = '買い物リストに追加';
const EXECUTED_TEXT = `✅ ${ACTION_LABEL}を実行しました！`;
/** 手で書いた期待値 (定数の文が変わったらこのテストも直す) */
const FALLBACK_TEXT = 'アクションを実行できませんでした';
const EXECUTE_BUTTON_TEXT = '実行する';
const QUICK_PROMPT = '献立を提案してほしい';
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

function sseFinalData(actionResult: { success: boolean; result: unknown } | null) {
  return {
    userMessage: { id: 'user-2', content: '足して', isImportant: false, createdAt: '2026-11-01T00:00:00.000Z' },
    aiMessage: {
      id: 'ai-2',
      content: '買い物リストに足します',
      proposedActions: { type: ACTION_TYPE, params: { items: [{ name: 'にんじん' }] } },
      createdAt: '2026-11-01T00:00:00.000Z',
    },
    actionExecuted: actionResult?.success || false,
    actionResult,
  };
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
            proposedActions: { type: ACTION_TYPE, params: { items: [{ name: 'にんじん' }] } },
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

/** 文が出るのを待つときの 1 回の待ち (ミリ秒) と回数の上限 (合わせて 2 秒。結果の文の遅らせ 300 ミリ秒より十分長い) */
const WAIT_POLL_MS = 50;
const WAIT_MAX_POLLS = 40;

/**
 * 文が出るまで待つ (自動実行の結果の文は少し遅れて足される)。
 * 待つ間に起きる更新を act の中で受けて、act を抜けるたびに画面へ反映させてから確かめる
 */
async function waitForText(expected: string) {
  for (let i = 0; i < WAIT_MAX_POLLS && !text().includes(expected); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    });
  }
  expect(text()).toContain(expected);
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
}

describe('consultationActionOutcomeOf / consultationActionFailureMessageOf (#2183 Z1)', () => {
  it('success が true のときだけ『✅ …を実行しました！』', () => {
    expect(consultationActionOutcomeOf({ success: true, result: { itemsAdded: 1 }, label: ACTION_LABEL })).toEqual({
      kind: 'executed',
      content: EXECUTED_TEXT,
    });
  });

  it('success が false: result.error の文を出す', () => {
    expect(consultationActionOutcomeOf({ success: false, result: { error: '権限がありません' }, label: ACTION_LABEL })).toEqual({
      kind: 'failed',
      content: '権限がありません',
    });
  });

  it('success が false で result.error が無い・空・文字列でない・result が null: 固定の文', () => {
    expect(AI_CONSULTATION_ACTION_FAILED_FALLBACK_MESSAGE).toBe(FALLBACK_TEXT);
    for (const result of [{ collectionId: 'c1', added: false }, { error: '' }, { error: '  ' }, { error: 1 }, null, undefined, 'x']) {
      expect(consultationActionFailureMessageOf(result)).toBe(FALLBACK_TEXT);
      expect(consultationActionOutcomeOf({ success: false, result, label: ACTION_LABEL })).toEqual({
        kind: 'failed',
        content: FALLBACK_TEXT,
      });
    }
  });

  it('success が欠けている・true でない値: 実行できたとは出さない', () => {
    for (const success of [undefined, null, 'true', 1]) {
      expect(consultationActionOutcomeOf({ success, result: {}, label: ACTION_LABEL }).kind).toBe('failed');
    }
  });
});

describe('AIChatBubble: 提案の「実行する」(executeAction) の結果 (#2183 Z1)', () => {
  it('応答が 200 で { success: false, result: { error } }: ✅ を出さず、その文を出し、提案は残す。更新の通知はしない', async () => {
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () =>
      json(200, { success: false, result: { error: '権限がありません' }, actionType: ACTION_TYPE });
    await openChat();
    const execute = buttonByText(EXECUTE_BUTTON_TEXT);
    expect(execute).toBeDefined();
    await click(execute!);

    expect(text()).not.toContain('✅');
    expect(text()).not.toContain('を実行しました');
    expect(text()).toContain('権限がありません');
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeDefined();
    expect(mealPlanUpdated).not.toHaveBeenCalled();
  });

  it('応答が 200 で { success: false } で result.error が無い (例: 読み直しの失敗): 固定の文', async () => {
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () =>
      json(200, { success: false, result: { collectionId: 'c1', added: false }, actionType: 'add_recipe_to_collection' });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);

    expect(text()).not.toContain('✅');
    expect(text()).toContain(FALLBACK_TEXT);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeDefined();
  });

  it('応答が 200 で { success: true }: ✅ を出し、提案を消し、更新を通知する (これまでどおり)', async () => {
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () =>
      json(200, { success: true, result: { itemsAdded: 1 }, actionType: ACTION_TYPE });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);

    expect(text()).toContain(EXECUTED_TEXT);
    expect(text()).not.toContain(FALLBACK_TEXT);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
  });

  it('実行の通信が失敗した: 黙らずに固定の文を出し、提案は残す', async () => {
    handlers[`POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`] = async () => {
      throw new TypeError('Failed to fetch');
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);

    expect(text()).not.toContain('✅');
    expect(text()).toContain(FALLBACK_TEXT);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeDefined();
    consoleError.mockRestore();
  });
});

describe('AIChatBubble: 会話の続きの POST (SSE) の自動実行の結果 (#2183 Z1)', () => {
  async function sendFromInput() {
    const input = container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(input).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, '足して');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="メッセージを送信"]');
    expect(send).not.toBeNull();
    await click(send!);
  }

  it('送信欄から: actionResult.success が偽なら、無言にせず失敗の文を出す (✅ は出さない)', async () => {
    handlers[`POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`] = async () =>
      sse(sseFinalData({ success: false, result: { error: '買い物リストの作成に失敗しました' } }));
    await openChat();
    await sendFromInput();

    await waitForText('買い物リストの作成に失敗しました');
    expect(text()).not.toContain('✅');
    expect(mealPlanUpdated).not.toHaveBeenCalled();
  });

  it('送信欄から: 自動実行が例外で result が null でも、固定の文を出す', async () => {
    handlers[`POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`] = async () =>
      sse(sseFinalData({ success: false, result: null }));
    await openChat();
    await sendFromInput();

    await waitForText(FALLBACK_TEXT);
    expect(text()).not.toContain('✅');
  });

  it('送信欄から: 成功なら提案の種類の名前で『✅ …を実行しました！』と出し、更新を通知する', async () => {
    handlers[`POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`] = async () =>
      sse(sseFinalData({ success: true, result: { itemsAdded: 1 } }));
    await openChat();
    await sendFromInput();

    await waitForText(EXECUTED_TEXT);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
  });

  it('自動実行が無い (actionResult が null): 結果の文は何も出さない', async () => {
    handlers[`POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`] = async () => sse(sseFinalData(null));
    await openChat();
    await sendFromInput();

    await waitForText('買い物リストに足します');
    // 結果の文を出すまでの遅らせより長く待っても出ない
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, LONGER_THAN_AUTO_OUTCOME_DELAY_MS));
    });
    expect(text()).not.toContain('✅');
    expect(text()).not.toContain(FALLBACK_TEXT);
  });

  it('おすすめの質問のボタンから: 自動実行の失敗も同じく失敗の文を出す', async () => {
    handlers['GET /api/ai/consultation/sessions?status=all'] = async () => json(200, { sessions: [] });
    handlers['POST /api/ai/consultation/sessions'] = async () => json(200, { session: { id: SESSION_ID } });
    handlers[`POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`] = async () =>
      sse(sseFinalData({ success: false, result: { error: '権限がありません' } }));
    await openChat();
    const quick = buttonByText(QUICK_PROMPT);
    expect(quick).toBeDefined();
    await click(quick!);

    await waitForText('権限がありません');
    expect(text()).not.toContain('✅');
  });

  it('おすすめの質問のボタンから: 成功も『✅ …を実行しました！』と出す', async () => {
    handlers['GET /api/ai/consultation/sessions?status=all'] = async () => json(200, { sessions: [] });
    handlers['POST /api/ai/consultation/sessions'] = async () => json(200, { session: { id: SESSION_ID } });
    handlers[`POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`] = async () =>
      sse(sseFinalData({ success: true, result: { itemsAdded: 1 } }));
    await openChat();
    await click(buttonByText(QUICK_PROMPT)!);

    await waitForText(EXECUTED_TEXT);
  });
});
