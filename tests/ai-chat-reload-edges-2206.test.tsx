/**
 * #2206 G2 Web の AI 相談 (src/components/AIChatBubble.tsx) で、送信の応答 (finalData) を受け取れなかったあとの取り直しの縁。
 *
 * 直す前:
 *   - 返答の保存と提案の記録の行の作成の間に取り直しが当たると、行の無いカード (GET の failed『もう一度 AI に頼んでください』) を写し、
 *     頼み直しを勧めていた (二重に作りうる)
 *   - 記録を読み直して実行を待つ・失敗した行になっても、一文 (『実行中か実行済み』) とカード (『確かめられませんでした』) が残った
 *   - 同じ文を送り直すと、前の送信 (時間切れで確かめられず、画面に保存行の id が無い) を今回の送信と取り違え、前の返答の結果を出した
 *   - 返答がまだ無い (DELIVERED_NO_REPLY) ときに読み直しの予約が無く、あとで実行が済んでも mealPlanUpdated が出なかった
 *   - GET が実行できた (カードを出さない) 返答で、記録の直読みだけが失敗すると、通知が出なかった
 *   - サーバーが失敗を知らせた (SSE の error だけ) のに、取り直すと『返答を作っているところかもしれません』に上書きした
 *   - 取り直しの GET に上限が無く、返らないと送信中のまま止まった
 *   - 取り直しの最中に相談を切り替えると、別の相談の入力欄に送った文が戻りえた
 *   - 時間切れのあと取り直しにも失敗すると、送った文を入力欄に戻さなかった
 *   - 応答を受ける前に通信が切れた (TypeError) ときは、取り直さずに『再試行してください』を出した
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
const { AI_CHAT_RELOAD_TIMEOUT_MS, fetchConversationForReload } = await import('@/lib/ai/consultation-reply-reload');

const SESSION_ID = 'session-1';
const OTHER_SESSION_ID = 'session-2';
const OTHER_SESSION_TITLE = '別の相談';
const MESSAGES_KEY = `GET /api/ai/consultation/sessions/${SESSION_ID}/messages`;
const OTHER_MESSAGES_KEY = `GET /api/ai/consultation/sessions/${OTHER_SESSION_ID}/messages`;
const SEND_KEY = `POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`;
/** 手で書いた期待値 (定数の文が変わったらこのテストも直す) */
const EXECUTED_NOTE = '前の依頼は実行されました';
const RUNNING_NOTE = '前の依頼の結果をまだ確かめられません。しばらくしてから相談を開き直してください。';
const NOT_EXECUTED_NOTE = '前の依頼は実行できませんでした';
const DELIVERED_NO_REPLY_TEXT = '相談はサーバーに届いています。返答を作っているところかもしれません。少し待ってから相談を開き直してください。';
const TIMEOUT_RELOAD_FAILED_TEXT =
  '応答に時間がかかっています。返答はサーバーで続いていることがあります。少し待ってから相談を開き直し、返答が無ければもう一度送ってください。';
const REPLY_FAILED_TEXT = '応答に失敗しました。再試行してください。';
const UNCONFIRMED_GUIDE = 'この提案を実行できたかを確かめられませんでした。しばらくしてから相談を開き直してください。';
const RETRY_GUIDE = 'この提案はここからは実行できません。もう一度 AI に頼んでください。';
const NOT_EXECUTABLE_CARD = '[data-testid="ai-proposed-action-not-executable"]';

const SENT_TEXT = '今夜の夕食を1食作って';
const REPLY_ID = 'ai-saved-1';
const SAVED_REPLY = '鶏むね肉の照り焼きで1食作りますね';
const OLD_MESSAGES = [
  { id: 'old-user', role: 'user', content: '夕飯の相談です', createdAt: '2026-11-01T00:00:00.000Z' },
  { id: 'old-ai', role: 'assistant', content: '野菜を足しましょう', createdAt: '2026-11-01T00:00:01.000Z' },
];
const SAVED_USER = { id: 'user-saved-1', role: 'user', content: SENT_TEXT, createdAt: '2026-11-02T00:00:00.000Z' };
const PROPOSAL = { type: 'generate_single_meal', params: { date: '2026-11-02', mealType: 'dinner' } };
function savedReply(fields: Record<string, unknown> = {}) {
  return { id: REPLY_ID, role: 'assistant', content: SAVED_REPLY, proposedActions: null, createdAt: '2026-11-02T00:00:01.000Z', ...fields };
}
function savedMessages(reply: Record<string, unknown> = savedReply()) {
  return [...OLD_MESSAGES, SAVED_USER, reply];
}
/** 返答を保存した直後で、提案の記録の行がまだ無いときに GET が返す形 (行が無いので failed。lifecycle の proposedActionViewOf([])) */
const NO_ROW_YET_CARD = { proposedActions: PROPOSAL, proposedActionExecutable: false, proposedActionNotExecutableReason: 'failed' };
/** 記録が実行中の印 (approved) のときに GET が返す形 */
const RUNNING_CARD = { proposedActions: PROPOSAL, proposedActionExecutable: false, proposedActionNotExecutableReason: 'unconfirmed' };

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
      json(200, {
        sessions: [
          { id: SESSION_ID, title: 'AI相談', messageCount: 2 },
          { id: OTHER_SESSION_ID, title: OTHER_SESSION_TITLE, messageCount: 0 },
        ],
      }),
    [MESSAGES_KEY]: async () => {
      messagesGets += 1;
      return json(200, { messages: serverMessages });
    },
    [OTHER_MESSAGES_KEY]: async () => json(200, { messages: [] }),
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
  vi.useRealTimers();
});

function text(): string {
  return container.textContent ?? '';
}

function aiBubbleTexts(): string[] {
  return Array.from(container.querySelectorAll('[data-testid="ai-message-bubble"]'))
    .map((node) => (node.textContent ?? '').trim())
    .filter((t) => t !== '');
}

function expectNoteRightAfter(replyText: string, note: string) {
  const texts = aiBubbleTexts();
  const replyIndex = texts.findIndex((t) => t.includes(replyText));
  expect(replyIndex).toBeGreaterThanOrEqual(0);
  expect(texts[replyIndex + 1]).toBe(note);
}

function occurrences(needle: string): number {
  return text().split(needle).length - 1;
}

/** 文が出るまでの 1 回の待ち (ミリ秒) と回数の上限 (合わせて 5 秒) */
const WAIT_POLL_MS = 20;
const WAIT_MAX_POLLS = 250;

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < WAIT_MAX_POLLS && !condition(); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    });
  }
  expect(condition()).toBe(true);
}

async function waitPastRecheck() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, TEST_RECHECK_DELAY_MS * 4));
  });
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

function inputElement(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  expect(input).not.toBeNull();
  return input!;
}

async function sendFromInput(onSend: FetchHandler, sentText = SENT_TEXT) {
  handlers[SEND_KEY] = onSend;
  const input = inputElement();
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(input, sentText);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const send = container.querySelector<HTMLButtonElement>('button[aria-label="メッセージを送信"]');
  expect(send).not.toBeNull();
  await act(async () => {
    send!.click();
  });
}

function timesOutAfterSaving(messages: unknown[]): FetchHandler {
  return async () => {
    serverMessages = messages;
    throw abortError();
  };
}

function notExecutableCardShown(): boolean {
  return container.querySelector(NOT_EXECUTABLE_CARD) !== null;
}

function executeButtonShown(): boolean {
  return Array.from(container.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === '実行する');
}

describe('#2206 G2 返答の保存と提案の記録の行の作成の間に取り直しが当たる', () => {
  it('GET が行の無いカード (failed) を返し、記録の行もまだ無ければ、頼み直しを勧めず『確かめられませんでした』と一文を出し、読み直して実行できていれば置き換える', async () => {
    logs.results = [
      { data: [], error: null },
      { data: [{ status: 'executed', action_type: 'generate_single_meal' }], error: null },
    ];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages(savedReply(NO_ROW_YET_CARD))));

    await waitFor(() => text().includes(RUNNING_NOTE));
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    // 行が無いときの GET の『もう一度 AI に頼んでください』を写さない
    expect(text()).not.toContain(RETRY_GUIDE);
    expectNoteRightAfter(SAVED_REPLY, RUNNING_NOTE);

    await waitFor(() => text().includes(EXECUTED_NOTE));
    expect(text()).not.toContain(RUNNING_NOTE);
    expect(notExecutableCardShown()).toBe(false);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
    expect(logs.reads).toHaveLength(2);
  });

  it('記録が実行中の印でも GET が行の無いカード (failed) を返していたら、『確かめられませんでした』のカードにする', async () => {
    logs.results = [{ data: [{ status: 'approved' }], error: null }];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages(savedReply(NO_ROW_YET_CARD))));

    await waitFor(() => text().includes(RUNNING_NOTE));
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    expect(text()).not.toContain(RETRY_GUIDE);
  });
});

describe('#2206 G2 読み直しで実行を待つ・失敗した行になっていたら、一文とカードを差し替える', () => {
  it('実行を待つ (pending): 一文を『実行できませんでした』に置き換え、カードは「実行する」を出す (GET と同じ)', async () => {
    logs.results = [{ data: [{ status: 'approved' }], error: null }, { data: [{ status: 'pending' }], error: null }];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages(savedReply(RUNNING_CARD))));

    await waitFor(() => text().includes(RUNNING_NOTE));
    expect(executeButtonShown()).toBe(false);
    await waitFor(() => text().includes(NOT_EXECUTED_NOTE));
    expect(text()).not.toContain(RUNNING_NOTE);
    expectNoteRightAfter(SAVED_REPLY, NOT_EXECUTED_NOTE);
    expect(text()).not.toContain(UNCONFIRMED_GUIDE);
    expect(executeButtonShown()).toBe(true);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
  });

  it('失敗 (failed): 一文を『実行できませんでした』に置き換え、カードは GET の failed と同じ案内にする', async () => {
    logs.results = [{ data: [{ status: 'approved' }], error: null }, { data: [{ status: 'failed' }], error: null }];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages(savedReply(RUNNING_CARD))));

    await waitFor(() => text().includes(NOT_EXECUTED_NOTE));
    expect(text()).not.toContain(RUNNING_NOTE);
    expect(text()).not.toContain(UNCONFIRMED_GUIDE);
    expect(text()).toContain(RETRY_GUIDE);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
  });

  it('最初の読み取りで実行を待つ行なら、『実行できませんでした』を出し、カードは記録の行から作る (読み直さない)', async () => {
    logs.results = [{ data: [{ status: 'pending' }], error: null }];
    await openChat();
    // GET を読んだときは実行中の印 (unconfirmed) でも、記録を読むまでに pending に戻っていた
    await sendFromInput(timesOutAfterSaving(savedMessages(savedReply(RUNNING_CARD))));

    await waitFor(() => text().includes(NOT_EXECUTED_NOTE));
    expect(executeButtonShown()).toBe(true);
    expect(text()).not.toContain(UNCONFIRMED_GUIDE);
    await waitPastRecheck();
    expect(logs.reads).toHaveLength(1);
  });
});

describe('#2206 G2 同じ文を送り直したとき、前の送信と取り違えない', () => {
  it('前の送信 (取り直せずに確かめられなかった) の返答ではなく、今回の返答の記録を読んで結果を出す', async () => {
    const earlierUser = { id: 'user-earlier', role: 'user', content: SENT_TEXT, createdAt: '2026-11-02T00:00:00.000Z' };
    const earlierReply = { id: 'ai-earlier', role: 'assistant', content: '前の返答です', proposedActions: null, createdAt: '2026-11-02T00:00:01.000Z' };
    const thisUser = { id: 'user-this', role: 'user', content: SENT_TEXT, createdAt: '2026-11-02T00:01:00.000Z' };
    const thisReply = { id: 'ai-this', role: 'assistant', content: '今回の返答です', proposedActions: null, createdAt: '2026-11-02T00:01:01.000Z' };
    await openChat();
    // 1 回目: 時間切れで、会話も取り直せない (楽観的に出した送った文 temp- が残る)
    handlers[MESSAGES_KEY] = async () => json(500, { error: 'サーバーでエラーが発生しました' });
    await sendFromInput(async () => {
      throw abortError();
    });
    await waitFor(() => text().includes(TIMEOUT_RELOAD_FAILED_TEXT));

    // 2 回目: 同じ文を送り直して、また時間切れ。サーバーには前の送信と今回の送信の両方が保存されていた
    handlers[MESSAGES_KEY] = async () => json(200, { messages: [...OLD_MESSAGES, earlierUser, earlierReply, thisUser, thisReply] });
    logs.results = [{ data: [{ status: 'executed', action_type: 'update_meal' }], error: null }];
    await sendFromInput(async () => {
      throw abortError();
    });

    await waitFor(() => text().includes('今回の返答です'));
    expect(logs.reads[0].filters).toEqual([['message_id', 'ai-this']]);
    expectNoteRightAfter('今回の返答です', EXECUTED_NOTE);
  });
});

describe('#2206 G2 返答がまだ無いとき (DELIVERED_NO_REPLY) も 1 回だけ取り直す', () => {
  it('少し待って取り直し、返答が保存されていれば返答に置き換え、実行できていれば一文と通知を出す', async () => {
    logs.results = [{ data: [{ status: 'executed', action_type: 'generate_single_meal' }], error: null }];
    await openChat();
    // 1 回目の取り直し (2 回目の GET) では返答がまだ無く、その後の取り直し (3 回目の GET) までにサーバーで返答の保存と自動実行が済んだ
    handlers[MESSAGES_KEY] = async () => {
      messagesGets += 1;
      return json(200, { messages: messagesGets <= 2 ? [...OLD_MESSAGES, SAVED_USER] : savedMessages() });
    };
    await sendFromInput(async () => {
      throw abortError();
    });

    await waitFor(() => messagesGets >= 2);
    await waitFor(() => text().includes(EXECUTED_NOTE));
    expect(messagesGets).toBe(3);
    expect(text()).not.toContain(DELIVERED_NO_REPLY_TEXT);
    expectNoteRightAfter(SAVED_REPLY, EXECUTED_NOTE);
    expect(occurrences(SAVED_REPLY)).toBe(1);
    expect(occurrences(SENT_TEXT)).toBe(1);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
    expect(logs.reads[0].filters).toEqual([['message_id', REPLY_ID]]);
  });

  it('取り直しても返答がまだ無ければ、文はそのまま (取り直しは 1 回だけ)', async () => {
    await openChat();
    await sendFromInput(timesOutAfterSaving([...OLD_MESSAGES, SAVED_USER]));

    await waitFor(() => text().includes(DELIVERED_NO_REPLY_TEXT));
    await waitFor(() => messagesGets === 3);
    await waitPastRecheck();
    expect(messagesGets).toBe(3);
    expect(text()).toContain(DELIVERED_NO_REPLY_TEXT);
    expect(logs.reads).toHaveLength(0);
  });
});

describe('#2206 G2 GET が実行できた返答 (カードを出さない) で、記録の直読みだけが失敗した', () => {
  it('一文を出さずに 1 回だけ読み直し、実行できていれば返答のすぐ後に一文を足して通知する', async () => {
    logs.results = [
      { data: null, error: { message: 'temporary failure' } },
      { data: [{ status: 'executed', action_type: 'update_meal' }], error: null },
    ];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages()));

    await waitFor(() => text().includes(SAVED_REPLY));
    expect(text()).not.toContain(RUNNING_NOTE);
    await waitFor(() => text().includes(EXECUTED_NOTE));
    expectNoteRightAfter(SAVED_REPLY, EXECUTED_NOTE);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
    expect((mealPlanUpdated.mock.calls[0][0] as CustomEvent).detail).toEqual({ actionType: 'update_meal', result: null });
  });
});

describe('#2206 G2 サーバーが失敗を知らせたら、返答を待つ文に上書きしない', () => {
  it('SSE で error だけが来て、取り直しても返答が無ければ、失敗の文のまま (取り直しの予約もしない)', async () => {
    await openChat();
    await sendFromInput(async () => {
      serverMessages = [...OLD_MESSAGES, SAVED_USER];
      return new Response(`data: ${JSON.stringify({ error: 'サーバーでエラーが発生しました', code: 'INTERNAL_ERROR' })}\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    await waitFor(() => messagesGets === 2);
    await waitFor(() => text().includes(REPLY_FAILED_TEXT));
    expect(text()).not.toContain(DELIVERED_NO_REPLY_TEXT);
    await waitPastRecheck();
    expect(messagesGets).toBe(2);
  });
});

describe('#2206 G2 取り直しの GET の上限・入力欄の戻し方', () => {
  it('fetchConversationForReload: GET が返らなければ AI_CHAT_RELOAD_TIMEOUT_MS で打ち切って null を返す', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init?.signal ?? undefined;
            signal?.addEventListener('abort', () => reject(abortError()));
          }),
      ),
    );
    let settled = false;
    const pending = fetchConversationForReload(SESSION_ID).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(AI_CHAT_RELOAD_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await expect(pending).resolves.toBeNull();
  });

  it('画面の取り直しの GET は上限つき (signal を渡す)', async () => {
    let reloadSignal: AbortSignal | null | undefined;
    await openChat();
    handlers[MESSAGES_KEY] = async (_url, init) => {
      reloadSignal = init?.signal;
      return json(200, { messages: savedMessages() });
    };
    await sendFromInput(async () => {
      throw abortError();
    });

    await waitFor(() => text().includes(SAVED_REPLY));
    expect(reloadSignal).toBeInstanceOf(AbortSignal);
  });

  it('時間切れのあと会話も取り直せなければ、送った文を入力欄に戻す', async () => {
    await openChat();
    handlers[MESSAGES_KEY] = async () => json(500, { error: 'サーバーでエラーが発生しました' });
    await sendFromInput(async () => {
      throw abortError();
    });

    await waitFor(() => text().includes(TIMEOUT_RELOAD_FAILED_TEXT));
    expect(inputElement().value).toBe(SENT_TEXT);
  });

  it('取り直しの最中に別の相談へ切り替えたら、送った文を入力欄に戻さない', async () => {
    await openChat();
    let releaseReload: () => void = () => {};
    const reloadGate = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    handlers[MESSAGES_KEY] = async () => {
      await reloadGate;
      // 届いていなかった (戻す分岐に入る)
      return json(200, { messages: OLD_MESSAGES });
    };
    await sendFromInput(async () => {
      throw abortError();
    });

    // 取り直しの GET を待っている間に、別の相談へ切り替える
    const toggle = container.querySelector('svg.lucide-chevron-down')?.closest('button');
    expect(toggle).toBeTruthy();
    await act(async () => {
      toggle!.click();
    });
    const other = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(OTHER_SESSION_TITLE));
    expect(other).toBeDefined();
    await act(async () => {
      other!.click();
    });
    await waitFor(() => !text().includes('野菜を足しましょう'));

    await act(async () => {
      releaseReload();
    });
    await waitPastRecheck();
    expect(inputElement().value).toBe('');
  });

  it('切り替えなければ、届いていなかったときに送った文を入力欄に戻す (上の対照)', async () => {
    await openChat();
    serverMessages = OLD_MESSAGES;
    await sendFromInput(async () => {
      serverMessages = OLD_MESSAGES;
      throw abortError();
    });

    await waitFor(() => inputElement().value === SENT_TEXT);
  });
});

describe('#2206 G2 応答を受ける前に通信が切れた (TypeError)', () => {
  it('『再試行してください』だけを出さず、会話を取り直して保存された返答と結果を出す', async () => {
    logs.results = [{ data: [{ status: 'executed', action_type: 'update_meal' }], error: null }];
    await openChat();
    await sendFromInput(async () => {
      serverMessages = savedMessages();
      throw new TypeError('Failed to fetch');
    });

    await waitFor(() => text().includes(EXECUTED_NOTE));
    expectNoteRightAfter(SAVED_REPLY, EXECUTED_NOTE);
    expect(text()).not.toContain(REPLY_FAILED_TEXT);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
  });
});
