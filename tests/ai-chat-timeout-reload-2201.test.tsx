/**
 * #2201 U3 Web の AI 相談 (src/components/AIChatBubble.tsx) が、送信の応答 (SSE の最後の finalData) を受け取れなかったあと、
 * 会話を取り直して前の依頼の結果を出す (モバイルの #2195 V3 と同じ直し。決まりは packages/shared/src/consultation-reply-reload.ts)。
 *
 * 問題 (直す前):
 *   - 送信が時間切れになると「しばらく待ってから再度お試しください」だけを出し、サーバーで返答の保存と自動実行 (献立の生成など) が
 *     済んでいるかを確かめなかった。頼み直すと献立を二重に作りうる。データの更新の通知 (mealPlanUpdated) も投げなかった
 *   - finalData が欠けたとき (流れが途中で切れた) と、応答を受けたあとの例外のあとも、失敗の文だけを出していた
 *   - おすすめの質問から送ったときも同じ
 *
 * 直したあと:
 *   - 会話の GET を取り直し、送った文が届いていれば保存された送った文と返答に置き換える。返答の提案の記録 (ai_action_logs) が
 *     実行できていれば『前の依頼は実行されました』を足して通知を 1 回投げる
 *   - 記録が実行中の印 (approved) のままなら『前の依頼は実行中か実行済みです』を足し、少し待って 1 回だけ読み直す。
 *     実行できていれば一文を置き換えて通知を投げる。まだ実行中の印なら一文はそのまま (通知しない)
 *   - 届いていない: 頼み直してもらう文を出し、送った文を入力欄に戻す / 返答がまだ無い: 開き直してもらう文
 *   - 取り直せない時間切れ: 頼み直しの前に開き直してもらう文 (「再度お試しください」だけを出さない)
 *   - 受け付けられなかった送信 (2xx でない応答) は、これまでどおり失敗の文だけ (取り直さない)
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 読み直しまでの待ち (テストでは短くする。本物は PREVIOUS_REQUEST_RECHECK_DELAY_MS) */
const TEST_RECHECK_DELAY_MS = 30;

const logs = vi.hoisted(() => ({
  /** ai_action_logs の読み取りの結果 (読むたびに先頭から使い、最後の 1 つは使い続ける) */
  results: [] as Array<{ data: unknown; error: unknown } | Error>,
  reads: [] as Array<{ table: string; columns: string; filters: Array<[string, unknown]> }>,
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: async (column: string, value: unknown) => {
          logs.reads.push({ table, columns, filters: [[column, value]] });
          const result = logs.results.length > 1 ? logs.results.shift()! : logs.results[0];
          if (result instanceof Error) throw result;
          return result;
        },
      }),
    }),
  }),
}));
vi.mock('@homegohan/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@homegohan/shared')>()),
  PREVIOUS_REQUEST_RECHECK_DELAY_MS: TEST_RECHECK_DELAY_MS,
}));
// 同意画面は出さない (同意済みとして進める)
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: async () => 'consented' as const, consentModal: null }),
}));
vi.mock('@/hooks/useV4MenuGeneration', () => ({
  useV4MenuGeneration: () => ({ isGenerating: false, generate: vi.fn(), subscribeToProgress: vi.fn() }),
}));
vi.mock('@/hooks/useNativeAppMode', () => ({ useNativeAppMode: () => false }));
vi.mock('@/lib/local-notification', () => ({ notifyMenuGenerated: vi.fn() }));
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
const MESSAGES_KEY = `GET /api/ai/consultation/sessions/${SESSION_ID}/messages`;
const SEND_KEY = `POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`;
/** 手で書いた期待値 (定数の文が変わったらこのテストも直す) */
const EXECUTED_NOTE = '前の依頼は実行されました';
const RUNNING_NOTE = '前の依頼は実行中か実行済みです';
const NOT_DELIVERED_TEXT = '相談はサーバーに届いていませんでした。もう一度送ってください。';
const DELIVERED_NO_REPLY_TEXT = '相談はサーバーに届いています。返答を作っているところかもしれません。少し待ってから相談を開き直してください。';
const TIMEOUT_RELOAD_FAILED_TEXT =
  '応答に時間がかかっています。返答はサーバーで続いていることがあります。少し待ってから相談を開き直し、返答が無ければもう一度送ってください。';
const REPLY_FAILED_TEXT = '応答に失敗しました。再試行してください。';
/** 直す前の時間切れの文 (もう出さない) */
const OLD_TIMEOUT_TEXT = '応答に時間がかかりすぎました。しばらく待ってから再度お試しください。';

const SENT_TEXT = '今夜の夕食を1食作って';
const QUICK_PROMPT = '献立を提案してほしい';
const REPLY_ID = 'ai-saved-1';
const SAVED_REPLY = '鶏むね肉の照り焼きで1食作りますね';
const OLD_MESSAGES = [
  { id: 'old-user', role: 'user', content: '夕飯の相談です', createdAt: '2026-11-01T00:00:00.000Z' },
  { id: 'old-ai', role: 'assistant', content: '野菜を足しましょう', createdAt: '2026-11-01T00:00:01.000Z' },
];
function savedMessages(sent: string) {
  return [
    ...OLD_MESSAGES,
    { id: 'user-saved-1', role: 'user', content: sent, createdAt: '2026-11-02T00:00:00.000Z' },
    { id: REPLY_ID, role: 'assistant', content: SAVED_REPLY, proposedActions: null, createdAt: '2026-11-02T00:00:01.000Z' },
  ];
}

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

let container: HTMLDivElement;
let root: Root;
let handlers: Record<string, FetchHandler>;
let mealPlanUpdated: ReturnType<typeof vi.fn>;
/** 会話の GET が返すメッセージ (開いたとき・取り直したとき) */
let serverMessages: unknown[];
let messagesGets: number;
const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.cookie = 'aiChatBubblePosition=; max-age=0; path=/';
  localStorage.clear();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('alert', vi.fn());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mealPlanUpdated = vi.fn();
  window.addEventListener('mealPlanUpdated', mealPlanUpdated);
  logs.results = [{ data: [], error: null }];
  logs.reads = [];
  serverMessages = OLD_MESSAGES;
  messagesGets = 0;
  handlers = {
    'GET /api/ai/consultation/sessions?status=all': async () =>
      json(200, { sessions: [{ id: SESSION_ID, title: 'AI相談', messageCount: 2 }] }),
    [MESSAGES_KEY]: async () => {
      messagesGets += 1;
      return json(200, { messages: serverMessages });
    },
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function text(): string {
  return container.textContent ?? '';
}

/** AI の吹き出しの本文を上から順に (空は除く) */
function aiBubbleTexts(): string[] {
  return Array.from(container.querySelectorAll('[data-testid="ai-message-bubble"]'))
    .map((node) => (node.textContent ?? '').trim())
    .filter((t) => t !== '');
}

/** 画面に文が出ている回数 */
function occurrences(needle: string): number {
  return text().split(needle).length - 1;
}

/** AI の吹き出しで、一文 (note) が保存された返答のすぐ後にあるか */
function expectNoteRightAfterReply(note: string) {
  const texts = aiBubbleTexts();
  const replyIndex = texts.findIndex((t) => t.includes(SAVED_REPLY));
  expect(replyIndex).toBeGreaterThanOrEqual(0);
  expect(texts[replyIndex + 1]).toBe(note);
}

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
  await waitFor(() => text().includes('野菜を足しましょう'));
}

/** 文が出るまでの 1 回の待ち (ミリ秒) と回数の上限 (合わせて 2 秒。読み直しの待ち TEST_RECHECK_DELAY_MS より十分長い) */
const WAIT_POLL_MS = 20;
const WAIT_MAX_POLLS = 100;

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < WAIT_MAX_POLLS && !condition(); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    });
  }
  expect(condition()).toBe(true);
}

/** 読み直しの待ちが過ぎるまで待つ (読み直しで何も起きないことを確かめるとき) */
async function waitPastRecheck() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, TEST_RECHECK_DELAY_MS * 4));
  });
}

function inputElement(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  expect(input).not.toBeNull();
  return input!;
}

/** 入力欄から送る。送信の POST は onSend が返す (または投げる) */
async function sendFromInput(onSend: FetchHandler) {
  handlers[SEND_KEY] = onSend;
  const input = inputElement();
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(input, SENT_TEXT);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const send = container.querySelector<HTMLButtonElement>('button[aria-label="メッセージを送信"]');
  expect(send).not.toBeNull();
  await act(async () => {
    send!.click();
  });
}

/** 時間切れで終わる送信 (待ちを打ち切った)。その間にサーバーは messages まで保存していたことにする */
function timesOutAfterSaving(messages: unknown[]): FetchHandler {
  return async () => {
    serverMessages = messages;
    throw abortError();
  };
}

/** 本文の断片だけを流して、finalData を流さずに終わる応答 (流れが途中で切れた)。サーバーは messages まで保存していた */
function streamsWithoutFinalData(messages: unknown[], partial: string): FetchHandler {
  return async () => {
    serverMessages = messages;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: partial } }] })}\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
}

function expectReadLogsOfReply() {
  expect(logs.reads.length).toBeGreaterThan(0);
  expect(logs.reads[0]).toMatchObject({ table: 'ai_action_logs', filters: [['message_id', REPLY_ID]] });
  expect(logs.reads[0].columns.split(',').map((c) => c.trim())).toContain('status');
}

describe('#2201 U3 送信が時間切れになったあと、会話を取り直して前の依頼の結果を出す', () => {
  it('返答の提案の記録が実行できていれば、保存された返答のすぐ後に一文を出し、通知を 1 回投げる', async () => {
    logs.results = [{ data: [{ status: 'executed', action_type: 'generate_single_meal' }], error: null }];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages(SENT_TEXT)));

    await waitFor(() => text().includes(EXECUTED_NOTE));
    expectReadLogsOfReply();
    expectNoteRightAfterReply(EXECUTED_NOTE);
    expect(text()).not.toContain(OLD_TIMEOUT_TEXT);
    expect(text()).not.toContain(TIMEOUT_RELOAD_FAILED_TEXT);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
    expect((mealPlanUpdated.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ actionType: 'generate_single_meal' });
    // 送った文・返答は保存された 1 件ずつ (楽観的に出した分と二重にならない)
    expect(occurrences(SENT_TEXT)).toBe(1);
    expect(occurrences(SAVED_REPLY)).toBe(1);
  });

  it('記録が実行中の印のままなら『実行中か実行済み』を出し、読み直して実行できていれば一文を置き換えて通知を投げる', async () => {
    logs.results = [
      { data: [{ status: 'approved', action_type: 'generate_single_meal' }], error: null },
      { data: [{ status: 'executed', action_type: 'generate_single_meal' }], error: null },
    ];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages(SENT_TEXT)));

    await waitFor(() => text().includes(RUNNING_NOTE));
    expect(mealPlanUpdated).not.toHaveBeenCalled();
    await waitFor(() => text().includes(EXECUTED_NOTE));
    expect(text()).not.toContain(RUNNING_NOTE);
    expect(logs.reads).toHaveLength(2);
    expect(logs.reads[1].filters).toEqual([['message_id', REPLY_ID]]);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
    expectNoteRightAfterReply(EXECUTED_NOTE);
  });

  it.each([
    ['まだ実行中の印のまま', { data: [{ status: 'approved' }], error: null }],
    ['読み直しが失敗を返した', { data: null, error: { message: 'permission denied' } }],
    ['読み直しが例外を投げた', new Error('Failed to fetch')],
  ])('読み直しで %s なら、一文はそのまま・通知もしない (読み直しは 1 回だけ)', async (_label, recheck) => {
    logs.results = [{ data: [{ status: 'approved' }], error: null }, recheck];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages(SENT_TEXT)));

    await waitFor(() => text().includes(RUNNING_NOTE));
    await waitFor(() => logs.reads.length === 2);
    await waitPastRecheck();
    expect(text()).toContain(RUNNING_NOTE);
    expect(text()).not.toContain(EXECUTED_NOTE);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
    expect(logs.reads).toHaveLength(2);
  });

  it.each([
    ['行が無い (提案が無い返答)', { data: [], error: null }],
    ['実行を待っている・失敗した行だけ', { data: [{ status: 'pending' }, { status: 'failed' }], error: null }],
    ['読み取りが失敗を返した', { data: null, error: { message: 'permission denied' } }],
    ['読み取りが例外を投げた', new Error('Failed to fetch')],
  ])('%s なら、保存された返答だけを出し、一文も通知も出さない', async (_label, result) => {
    logs.results = [result];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages(SENT_TEXT)));

    await waitFor(() => text().includes(SAVED_REPLY));
    expectReadLogsOfReply();
    await waitPastRecheck();
    expect(text()).not.toContain(EXECUTED_NOTE);
    expect(text()).not.toContain(RUNNING_NOTE);
    expect(text()).not.toContain(OLD_TIMEOUT_TEXT);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
    expect(logs.reads).toHaveLength(1);
  });

  it('送った文が届いていなければ、頼み直してもらう文を出し、送った文を入力欄に戻す (記録は読まない)', async () => {
    await openChat();
    await sendFromInput(timesOutAfterSaving(OLD_MESSAGES));

    await waitFor(() => text().includes(NOT_DELIVERED_TEXT));
    expect(inputElement().value).toBe(SENT_TEXT);
    expect(logs.reads).toHaveLength(0);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
  });

  it('届いているが返答がまだ無ければ、開き直してもらう文を出す (頼み直しを促さない。記録は読まない)', async () => {
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages(SENT_TEXT).slice(0, OLD_MESSAGES.length + 1)));

    await waitFor(() => text().includes(DELIVERED_NO_REPLY_TEXT));
    expect(inputElement().value).toBe('');
    expect(logs.reads).toHaveLength(0);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
  });

  it('会話を取り直せなければ、頼み直しの前に開き直してもらう文を出す (「再度お試しください」だけを出さない)', async () => {
    await openChat();
    handlers[MESSAGES_KEY] = async () => json(500, { error: 'サーバーでエラーが発生しました' });
    await sendFromInput(async () => {
      throw abortError();
    });

    await waitFor(() => text().includes(TIMEOUT_RELOAD_FAILED_TEXT));
    expect(text()).not.toContain(OLD_TIMEOUT_TEXT);
    expect(logs.reads).toHaveLength(0);
  });

  it('前に同じ文を送っていても、今回送った文 (送る前に無かった id) への返答だけを見る', async () => {
    const earlierSame = [
      { id: 'earlier-user', role: 'user', content: SENT_TEXT, createdAt: '2026-10-31T00:00:00.000Z' },
      { id: 'earlier-ai', role: 'assistant', content: '前の返答です', createdAt: '2026-10-31T00:00:01.000Z' },
    ];
    serverMessages = [...earlierSame, ...OLD_MESSAGES];
    logs.results = [{ data: [{ status: 'executed' }], error: null }];
    await openChat();
    await sendFromInput(timesOutAfterSaving([...earlierSame, ...OLD_MESSAGES]));

    await waitFor(() => text().includes(NOT_DELIVERED_TEXT));
    expect(logs.reads).toHaveLength(0);
    expect(text()).not.toContain(EXECUTED_NOTE);
  });
});

describe('#2201 U3 finalData が欠けた・受け付けたあとの例外のあとも、会話を取り直す', () => {
  it('finalData が無いまま流れが終わった: 取り直した返答と、実行できた一文を出し、通知を投げる', async () => {
    logs.results = [{ data: [{ status: 'executed' }], error: null }];
    await openChat();
    await sendFromInput(streamsWithoutFinalData(savedMessages(SENT_TEXT), '鶏むね肉の'));

    await waitFor(() => text().includes(EXECUTED_NOTE));
    expect(text()).toContain(SAVED_REPLY);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
    expect(messagesGets).toBe(2);
  });

  it('finalData が無く、返答もまだ保存されていない: 流れてきた本文を残す', async () => {
    const partial = '鶏むね肉の照り焼きで';
    await openChat();
    await sendFromInput(streamsWithoutFinalData(savedMessages(SENT_TEXT).slice(0, OLD_MESSAGES.length + 1), partial));

    await waitFor(() => messagesGets === 2);
    await waitFor(() => text().includes(partial));
    expect(text()).not.toContain(REPLY_FAILED_TEXT);
    expect(logs.reads).toHaveLength(0);
  });

  it('応答を受けたあとに読み取りが例外を投げた: 取り直して、実行できた一文を出す', async () => {
    logs.results = [{ data: [{ status: 'executed' }], error: null }];
    await openChat();
    await sendFromInput(async () => {
      serverMessages = savedMessages(SENT_TEXT);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new TypeError('network error'));
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });

    await waitFor(() => text().includes(EXECUTED_NOTE));
    expect(text()).not.toContain(REPLY_FAILED_TEXT);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
  });

  it('受け付けられなかった送信 (2xx でない応答): これまでどおり失敗の文だけを出し、取り直さない', async () => {
    await openChat();
    await sendFromInput(async () => json(500, { error: 'サーバーでエラーが発生しました' }));

    await waitFor(() => text().includes(REPLY_FAILED_TEXT));
    expect(messagesGets).toBe(1);
    expect(logs.reads).toHaveLength(0);
  });
});

describe('#2201 U3 おすすめの質問から送ったときも同じ', () => {
  /** 相談がまだ無い (新しく作る) ときだけ、ようこその一文とおすすめの質問が出る */
  async function openEmptyChat() {
    handlers['GET /api/ai/consultation/sessions?status=all'] = async () => json(200, { sessions: [] });
    handlers['POST /api/ai/consultation/sessions'] = async () => json(200, { session: { id: SESSION_ID } });
    await act(async () => {
      root.render(createElement(AIChatBubble));
    });
    const fab = container.querySelector('[data-testid="ai-chat-floating-button"]');
    await act(async () => {
      fab!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
      fab!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0 }));
    });
    await waitFor(() => text().includes(QUICK_PROMPT));
  }

  async function pressQuickPrompt(onSend: FetchHandler) {
    handlers[SEND_KEY] = onSend;
    const button = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === QUICK_PROMPT);
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });
  }

  function savedQuick() {
    return [
      { id: 'user-saved-q', role: 'user', content: QUICK_PROMPT, createdAt: '2026-11-02T00:00:00.000Z' },
      { id: REPLY_ID, role: 'assistant', content: SAVED_REPLY, proposedActions: null, createdAt: '2026-11-02T00:00:01.000Z' },
    ];
  }

  it('時間切れ: 取り直した返答と、実行できた一文を出し、通知を投げる', async () => {
    logs.results = [{ data: [{ status: 'executed' }], error: null }];
    await openEmptyChat();
    await pressQuickPrompt(timesOutAfterSaving(savedQuick()));

    await waitFor(() => text().includes(EXECUTED_NOTE));
    expectNoteRightAfterReply(EXECUTED_NOTE);
    expect(text()).not.toContain(OLD_TIMEOUT_TEXT);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
  });

  it('時間切れで実行中の印のまま: 『実行中か実行済み』を出し、読み直して実行できていれば置き換える', async () => {
    logs.results = [{ data: [{ status: 'approved' }], error: null }, { data: [{ status: 'executed' }], error: null }];
    await openEmptyChat();
    await pressQuickPrompt(timesOutAfterSaving(savedQuick()));

    await waitFor(() => text().includes(RUNNING_NOTE));
    await waitFor(() => text().includes(EXECUTED_NOTE));
    expect(text()).not.toContain(RUNNING_NOTE);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
  });

  it('finalData が無いまま終わった: 取り直した返答を出す (以前は流れてきた本文のまま・空の吹き出し)', async () => {
    await openEmptyChat();
    await pressQuickPrompt(streamsWithoutFinalData(savedQuick(), ''));

    await waitFor(() => text().includes(SAVED_REPLY));
    expect(messagesGets).toBe(1);
  });
});

describe('#2201 U3 読み直しの予約は部品を外すときに取り消す', () => {
  it('読み直しの前に外したら、読み直さない', async () => {
    logs.results = [{ data: [{ status: 'approved' }], error: null }, { data: [{ status: 'executed' }], error: null }];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages(SENT_TEXT)));
    await waitFor(() => text().includes(RUNNING_NOTE));

    act(() => root.unmount());
    root = createRoot(container);
    await waitPastRecheck();
    expect(logs.reads).toHaveLength(1);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
  });
});
