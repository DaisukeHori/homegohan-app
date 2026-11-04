/**
 * #2227 H1 Web の AI 相談 (src/components/AIChatBubble.tsx) の取り直しの残りの縁 (回帰テスト)。
 *
 * 直す前:
 *   1. 本文を途中まで流したあとサーバーが失敗し、error つきの finalData (失敗の行を保存したもの) を送ると、流れてきた本文の断片を
 *      完全な返答として出し、失敗だと分からなかった (開き直すと失敗の文に変わった)
 *   2. 取り直せなかった・届いたか確かめられなかったときに入力欄に戻した文を、あとで開き直して届いていたと分かっても消さなかった
 *      (そのまま送ると二重に届く)
 *   3. 同じ文を続けて送り、前の送信が確かめられず今回の送信も届いていないと、前の送信の保存行を今回の送信と取り違え、前の返答を
 *      今回の結果として出した
 *   4. 記録の直読みだけが失敗し、会話の GET は「実行する」を出すとした (pending) 返答を、実行中の印と同じに扱い、カードの「実行する」を
 *      隠した。また、読み直しても記録の行が無い (サーバーが行を作れずに実行しなかった) と『結果をまだ確かめられません』のまま残った
 *   5. 取り直しのあとの提案の記録の直読み (readReplyActionStateOf) に上限が無く、返らないと送信中のまま入力が止まった
 *   6. (#2235 I1) 相談の開き直し (切り替えて戻る・チャットを閉じて開く) の読み込みが、その GET を待つ間に取り直しが積んだ確かめられ
 *      なかった送信まで、写しに無いからと忘れた。あとで保存行が見つかっても入力欄の文が消えず、そのまま送ると同じ文が二重に届いた
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollUntil, sleepRealTime } from './helpers/act-wait';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// 文が出るまでの待ち (tests/helpers/act-wait.ts) は最大 10 秒まで伸びうるので、1 件のテストの時間切れを延ばす
// (根拠と環境変数での上書きは tests/helpers/heavy-unit-test-timeout.ts)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

/** 読み直しまでの待ち (テストでは短くする。本物は PREVIOUS_REQUEST_RECHECK_DELAY_MS) */
const TEST_RECHECK_DELAY_MS = 30;

const logs = vi.hoisted(() => ({
  /** ai_action_logs の読み取りの結果 (読むたびに先頭から使い、最後の 1 つは使い続ける。'hang' は返らない読み取り) */
  results: [] as Array<{ data: unknown; error: unknown } | Error | 'hang'>,
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
          // 返らない読み取り (#2227 H1 の上限の確かめ)
          if (result === 'hang') return new Promise<never>(() => {});
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
/** 同意の確認の答え (「同意しない」の縁を確かめるテストだけ差し替える。beforeEach で戻す) */
const consent = vi.hoisted(() => ({ answer: 'consented' as 'consented' | 'declined' }));
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: async () => consent.answer, consentModal: null }),
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
const { AI_CHAT_RELOAD_TIMEOUT_MS } = await import('@/lib/ai/consultation-reply-reload');

const SESSION_ID = 'session-1';
const OTHER_SESSION_ID = 'session-2';
const OTHER_SESSION_TITLE = '別の相談';
const MAIN_SESSION_TITLE = 'いつもの相談';
const MESSAGES_KEY = `GET /api/ai/consultation/sessions/${SESSION_ID}/messages`;
const OTHER_MESSAGES_KEY = `GET /api/ai/consultation/sessions/${OTHER_SESSION_ID}/messages`;
const SEND_KEY = `POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`;
/** 手で書いた期待値 (定数の文が変わったらこのテストも直す) */
const EXECUTED_NOTE = '前の依頼は実行されました';
const RUNNING_NOTE = '前の依頼の結果をまだ確かめられません。しばらくしてから相談を開き直してください。';
const NOT_EXECUTED_NOTE = '前の依頼は実行できませんでした';
const TIMEOUT_RELOAD_FAILED_TEXT =
  '応答に時間がかかっています。返答はサーバーで続いていることがあります。少し待ってから相談を開き直し、返答が無ければもう一度送ってください。';
const DELIVERY_UNCONFIRMED_TEXT =
  '相談がサーバーに届いたかを確かめられませんでした。少し待ってから相談を開き直し、送った文が無ければ、入力欄の文をもう一度送ってください。';
const UNCONFIRMED_GUIDE = 'この提案を実行できたかを確かめられませんでした。しばらくしてから相談を開き直してください。';
const RETRY_GUIDE = 'この提案はここからは実行できません。もう一度 AI に頼んでください。';

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
  consent.answer = 'consented';
  serverMessages = OLD_MESSAGES;
  messagesGets = 0;
  handlers = {
    'GET /api/ai/consultation/sessions?status=all': async () =>
      json(200, {
        sessions: [
          { id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 },
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
  // holdRecheck で偽にした setTimeout を戻す (外したあとに戻すので、外すときの取り消しも偽のタイマーに効く)
  vi.useRealTimers();
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

/** 条件が真になるまで待つ (実時間。1 回の待ちと上限は tests/helpers/act-wait.ts。偽のタイマーの間も進む) */
async function waitFor(condition: () => boolean) {
  await pollUntil(condition);
  expect(condition()).toBe(true);
}

/** 読み直しの待ちが過ぎるまで待つ (読み直しで何も起きないことを確かめるとき) */
async function waitPastRecheck() {
  await act(async () => {
    await sleepRealTime(TEST_RECHECK_DELAY_MS * 4);
  });
}

/**
 * 部品の setTimeout の予約 (読み直し・取り直しの予約など) を偽のタイマーにして、releaseRecheck で進めるまで動かさない。
 * 『結果をまだ確かめられません』や『返答を作っているところかもしれません』は、読み直し・取り直しで置き換わって消える途中の表示
 * なので、実時間の読み直し (TEST_RECHECK_DELAY_MS) と競って見に行くと、混雑で描画が止まっただけで見る前に消えて待ちが切れる
 * (tests/ai-chat-timeout-reload-2201.test.tsx の holdRecheck と同じ)。送る前に呼ぶ。文が出るまでの待ち (waitFor) は実時間のまま進む
 */
function holdRecheck() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true });
}

/** holdRecheck で止めた読み直し・取り直しの予約を動かす (読み直しの待ち TEST_RECHECK_DELAY_MS だけ偽の時刻を進める) */
async function releaseRecheck() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(TEST_RECHECK_DELAY_MS);
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

function executeButtonShown(): boolean {
  return Array.from(container.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === '実行する');
}


function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 相談の一覧を開いて、title の相談に切り替える (切り替え先の会話を取り直す) */
async function switchToSession(title: string) {
  const toggle = container.querySelector('svg.lucide-chevron-down')?.closest('button');
  expect(toggle).toBeTruthy();
  await act(async () => {
    toggle!.click();
  });
  const target = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(title));
  expect(target).toBeDefined();
  await act(async () => {
    target!.click();
  });
}

const PARTIAL = '鶏むね肉の照';
/** route が失敗のときに保存して送る文 (route の errorContent と同じ) */
const ROUTE_ERROR_ROW_CONTENT = 'すみません、応答の生成中にエラーが発生しました。しばらく待ってから再度お試しください。';

describe('#2227 H1 本文を途中まで流したあとサーバーが失敗した (error つきの finalData)', () => {
  it('流れてきた断片ではなく、サーバーが保存した失敗の文を出す', async () => {
    await openChat();
    await sendFromInput(async () => {
      const errorRow = { id: 'ai-error-1', role: 'assistant', content: ROUTE_ERROR_ROW_CONTENT, createdAt: '2026-11-02T00:00:30.000Z' };
      serverMessages = [...OLD_MESSAGES, SAVED_USER, errorRow];
      const body =
        sse({ choices: [{ delta: { content: PARTIAL } }] }) +
        sse({
          userMessage: { id: SAVED_USER.id, content: SENT_TEXT, isImportant: false, createdAt: SAVED_USER.createdAt },
          aiMessage: { id: errorRow.id, content: ROUTE_ERROR_ROW_CONTENT, proposedActions: null, createdAt: errorRow.createdAt },
          actionExecuted: false,
          actionResult: null,
          error: 'サーバーでエラーが発生しました',
          code: 'INTERNAL_ERROR',
        }) +
        'data: [DONE]\n\n';
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });

    await waitFor(() => text().includes(ROUTE_ERROR_ROW_CONTENT));
    expect(text()).not.toContain(PARTIAL);
    // finalData を受け取れたので取り直さない
    expect(messagesGets).toBe(1);
  });

  it('error の無い finalData では、今までどおり流れてきた本文を出す (上の対照)', async () => {
    await openChat();
    await sendFromInput(async () => {
      const body =
        sse({ choices: [{ delta: { content: SAVED_REPLY } }] }) +
        sse({
          userMessage: { id: SAVED_USER.id, content: SENT_TEXT, isImportant: false, createdAt: SAVED_USER.createdAt },
          aiMessage: { id: REPLY_ID, content: SAVED_REPLY, proposedActions: null, createdAt: '2026-11-02T00:00:01.000Z' },
          actionExecuted: false,
          actionResult: null,
        }) +
        'data: [DONE]\n\n';
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });

    await waitFor(() => text().includes(SAVED_REPLY));
    expect(text()).not.toContain(ROUTE_ERROR_ROW_CONTENT);
  });
});

describe('#2227 H1 入力欄に戻した文は、あとで届いていたと分かったら消す', () => {
  it('時間切れで取り直せずに戻した文は、相談を開き直して送った文の保存行が見つかったら消す', async () => {
    await openChat();
    handlers[MESSAGES_KEY] = async () => json(500, { error: 'サーバーでエラーが発生しました' });
    await sendFromInput(async () => {
      throw abortError();
    });
    await waitFor(() => text().includes(TIMEOUT_RELOAD_FAILED_TEXT));
    expect(inputElement().value).toBe(SENT_TEXT);

    // 送った文はサーバーに届いていた (保存が取り直しより後だった)
    handlers[MESSAGES_KEY] = async () => json(200, { messages: savedMessages() });
    await switchToSession(MAIN_SESSION_TITLE);

    await waitFor(() => text().includes(SAVED_REPLY));
    await waitFor(() => inputElement().value === '');
  });

  it('戻した文を書き換えていたら、届いていたと分かっても消さない', async () => {
    await openChat();
    handlers[MESSAGES_KEY] = async () => json(500, { error: 'サーバーでエラーが発生しました' });
    await sendFromInput(async () => {
      throw abortError();
    });
    await waitFor(() => inputElement().value === SENT_TEXT);
    const edited = `${SENT_TEXT}。量は少なめで`;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(inputElement(), edited);
      inputElement().dispatchEvent(new Event('input', { bubbles: true }));
    });

    handlers[MESSAGES_KEY] = async () => json(200, { messages: savedMessages() });
    await switchToSession(MAIN_SESSION_TITLE);

    await waitFor(() => text().includes(SAVED_REPLY));
    expect(inputElement().value).toBe(edited);
  });

  it('開き直しても送った文が無ければ、戻した文は残す', async () => {
    await openChat();
    handlers[MESSAGES_KEY] = async () => json(500, { error: 'サーバーでエラーが発生しました' });
    await sendFromInput(async () => {
      throw abortError();
    });
    await waitFor(() => inputElement().value === SENT_TEXT);

    handlers[MESSAGES_KEY] = async () => json(200, { messages: OLD_MESSAGES });
    await switchToSession(MAIN_SESSION_TITLE);

    await waitFor(() => text().includes('野菜を足しましょう'));
    await waitPastRecheck();
    expect(inputElement().value).toBe(SENT_TEXT);
  });
});

describe('#2227 H1 同じ文を続けて送り、前の送信が確かめられなかったとき', () => {
  const earlierUser = { id: 'user-earlier', role: 'user', content: SENT_TEXT, createdAt: '2026-11-02T00:00:00.000Z' };
  const earlierReply = { id: 'ai-earlier', role: 'assistant', content: '前の返答です', proposedActions: null, createdAt: '2026-11-02T00:00:01.000Z' };

  /** 1 回目: 時間切れで、会話も取り直せない (前の送信は確かめられない。保存はあとで済む) */
  async function sendFirstUnconfirmed() {
    handlers[MESSAGES_KEY] = async () => json(500, { error: 'サーバーでエラーが発生しました' });
    await sendFromInput(async () => {
      throw abortError();
    });
    await waitFor(() => text().includes(TIMEOUT_RELOAD_FAILED_TEXT));
  }

  it('今回の送信が届いていなければ、前の送信の保存行と返答を今回の結果として出さない (届いたかを確かめられない文を出す)', async () => {
    await openChat();
    await sendFirstUnconfirmed();

    // 2 回目: 応答を受ける前に時間切れ。サーバーには前の送信 (遅れて保存された) と返答だけがある
    handlers[MESSAGES_KEY] = async () => json(200, { messages: [...OLD_MESSAGES, earlierUser, earlierReply] });
    logs.results = [{ data: [{ status: 'executed', action_type: 'update_meal' }], error: null }];
    await sendFromInput(async () => {
      throw abortError();
    });

    await waitFor(() => text().includes(DELIVERY_UNCONFIRMED_TEXT));
    expect(text()).not.toContain('前の返答です');
    expect(text()).not.toContain(EXECUTED_NOTE);
    // 前の返答の記録は読まない
    expect(logs.reads).toEqual([]);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
    expect(inputElement().value).toBe(SENT_TEXT);
  });

  it('今回の送信がサーバーに受け付けられていたら、一致のいちばん後ろは今回の保存行 (前の送信に当てない)', async () => {
    const thisUser = { id: 'user-this', role: 'user', content: SENT_TEXT, createdAt: '2026-11-02T00:01:00.000Z' };
    const thisReply = { id: 'ai-this', role: 'assistant', content: '今回の返答です', proposedActions: null, createdAt: '2026-11-02T00:01:01.000Z' };
    await openChat();
    await sendFirstUnconfirmed();

    // 2 回目: 受け付けられたが finalData の前に流れが切れた (前の送信は届いていなかった)。サーバーには今回の送信だけがある
    handlers[MESSAGES_KEY] = async () => json(200, { messages: [...OLD_MESSAGES, thisUser, thisReply] });
    await sendFromInput(async () => new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));

    await waitFor(() => text().includes('今回の返答です'));
    expect(text()).not.toContain(DELIVERY_UNCONFIRMED_TEXT);
    expect(logs.reads[0].filters).toEqual([['message_id', 'ai-this']]);
  });
});

describe('#2227 H1 前の依頼の一文: 記録を読めなかった・記録の行を作れなかった', () => {
  const EXECUTABLE_CARD = { proposedActions: PROPOSAL, proposedActionExecutable: true };

  it('記録の直読みだけが失敗し、GET は「実行する」を出すとした (pending) なら、『実行できませんでした』とカードの「実行する」を出す', async () => {
    logs.results = [{ data: null, error: { message: 'temporary failure' } }];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages(savedReply(EXECUTABLE_CARD))));

    await waitFor(() => text().includes(NOT_EXECUTED_NOTE));
    expectNoteRightAfter(SAVED_REPLY, NOT_EXECUTED_NOTE);
    expect(text()).not.toContain(RUNNING_NOTE);
    expect(executeButtonShown()).toBe(true);
    expect(text()).not.toContain(UNCONFIRMED_GUIDE);
    // 読み直さない (実行していないことは確か)
    await waitPastRecheck();
    expect(logs.reads).toHaveLength(1);
  });

  it('記録の直読みだけが失敗し、GET が実行中の印 (unconfirmed) としたなら、今までどおり実行中の印と同じ (上の対照)', async () => {
    logs.results = [{ data: null, error: { message: 'temporary failure' } }];
    await openChat();
    holdRecheck();
    await sendFromInput(timesOutAfterSaving(savedMessages(savedReply(RUNNING_CARD))));

    await waitFor(() => text().includes(RUNNING_NOTE));
    expect(executeButtonShown()).toBe(false);
  });

  it('読み直しても記録の行が無ければ (サーバーが行を作れずに実行しなかった)、『実行できませんでした』と GET と同じカードにする', async () => {
    logs.results = [{ data: [], error: null }];
    await openChat();
    holdRecheck();
    await sendFromInput(timesOutAfterSaving(savedMessages(savedReply(NO_ROW_YET_CARD))));

    await waitFor(() => text().includes(RUNNING_NOTE));
    await releaseRecheck();
    await waitFor(() => text().includes(NOT_EXECUTED_NOTE));
    expect(text()).not.toContain(RUNNING_NOTE);
    expectNoteRightAfter(SAVED_REPLY, NOT_EXECUTED_NOTE);
    expect(text()).toContain(RETRY_GUIDE);
    expect(text()).not.toContain(UNCONFIRMED_GUIDE);
    expect(logs.reads).toHaveLength(2);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
  });
});

describe('#2227 H1 取り直しのあとの記録の直読みにも上限', () => {
  it('記録の読み取りが返らなければ AI_CHAT_RELOAD_TIMEOUT_MS で打ち切り、返答を出して送信中を終える', async () => {
    logs.results = ['hang'];
    await openChat();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await sendFromInput(timesOutAfterSaving(savedMessages()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(logs.reads).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_CHAT_RELOAD_TIMEOUT_MS - 1);
    });
    expect(text()).not.toContain(SAVED_REPLY);
    expect(inputElement().disabled).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(text()).toContain(SAVED_REPLY);
    expect(inputElement().disabled).toBe(false);
  });
});

describe('#2235 I1 開き直しの読み込みが忘れるのは、読み込みを始める前に積んであった送信だけ', () => {
  /**
   * 会話の GET (この相談) を、呼ばれた順に止める。返すときは respond(i, messages) で i 番目の GET に会話を返す。
   * 取り直しの GET は AI_CHAT_RELOAD_TIMEOUT_MS で打ち切られるので、テストはその前に返す
   */
  function holdMessagesGets() {
    const pending: Array<(messages: unknown[]) => void> = [];
    handlers[MESSAGES_KEY] = () =>
      new Promise<Response>((resolve) => {
        pending.push((messages) => resolve(json(200, { messages })));
      });
    return {
      count: () => pending.length,
      respond: async (index: number, messages: unknown[]) => {
        await act(async () => {
          pending[index](messages);
        });
      },
    };
  }

  /** チャットを閉じて、浮いているボタンから開き直す (開いていた相談の会話を取り直す) */
  async function closeAndReopenChat() {
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="AIチャットを閉じる"]');
    expect(close).not.toBeNull();
    await act(async () => {
      close!.click();
    });
    const fab = container.querySelector('[data-testid="ai-chat-floating-button"]');
    expect(fab).not.toBeNull();
    await act(async () => {
      fab!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
      fab!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0 }));
    });
  }

  /** 別の相談へ切り替えてから、元の相談へ戻る (戻った相談の会話を取り直す) */
  async function switchAwayAndBack() {
    await switchToSession(OTHER_SESSION_TITLE);
    await waitFor(() => !text().includes('野菜を足しましょう'));
    await switchToSession(MAIN_SESSION_TITLE);
  }

  const REOPEN_ROUTES = [
    { route: '別の相談へ切り替えて戻る', reopen: switchAwayAndBack },
    { route: 'チャットを閉じて開き直す', reopen: closeAndReopenChat },
  ];

  it.each(REOPEN_ROUTES)(
    '$route: 開き直しの GET を待つ間に取り直しが積んだ送信は、写しに無くても忘れず、あとで保存行が見つかったら入力欄の文を消す',
    async ({ reopen }) => {
      await openChat();
      const gets = holdMessagesGets();
      // 応答を受ける前に時間切れ。取り直しの GET (0 番目) を止める
      await sendFromInput(async () => {
        throw abortError();
      });
      await waitFor(() => gets.count() === 1);

      // 取り直しを待つ間に相談を開き直す。開き直しの GET (1 番目) も止める
      await reopen();
      await waitFor(() => gets.count() === 2);

      // 取り直しが先に返る: 送った文はまだ無い (届いたかを確かめられない送信として積み、入力欄に戻す)
      await gets.respond(0, OLD_MESSAGES);
      await waitFor(() => inputElement().value === SENT_TEXT);

      // 開き直しの GET が返る: 写しは取り直しより前のもので、送った文が無い
      await gets.respond(1, OLD_MESSAGES);
      await waitFor(() => text().includes('野菜を足しましょう'));
      expect(inputElement().value).toBe(SENT_TEXT);

      // 送った文の保存はあとで済んでいた。次に開き直すと見つかるので、入力欄に戻した文を消す (そのまま送ると二重に届く)
      handlers[MESSAGES_KEY] = async () => json(200, { messages: savedMessages() });
      await switchToSession(MAIN_SESSION_TITLE);
      await waitFor(() => text().includes(SAVED_REPLY));
      await waitFor(() => inputElement().value === '');
    },
  );

  it('別の相談を開き直したときは、その相談の送信ではないので、写しに無くても忘れない (戻ってから保存行が見つかったら入力欄の文を消す)', async () => {
    await openChat();
    handlers[MESSAGES_KEY] = async () => json(500, { error: 'サーバーでエラーが発生しました' });
    await sendFromInput(async () => {
      throw abortError();
    });
    await waitFor(() => text().includes(TIMEOUT_RELOAD_FAILED_TEXT));
    expect(inputElement().value).toBe(SENT_TEXT);

    // 別の相談を開き直す (その会話に送った文は無い)
    await switchToSession(OTHER_SESSION_TITLE);
    await waitFor(() => !text().includes('野菜を足しましょう'));

    // 元の相談へ戻ると、送った文の保存行が見つかる
    handlers[MESSAGES_KEY] = async () => json(200, { messages: savedMessages() });
    await switchToSession(MAIN_SESSION_TITLE);
    await waitFor(() => text().includes(SAVED_REPLY));
    await waitFor(() => inputElement().value === '');
  });

  it('開き直しの GET を始める前に積んであった送信は、写しに無ければ今までどおり忘れる (同じ文の次の送信の保存行を前の送信に当てない。上の対照)', async () => {
    const thisUser = { id: 'user-this', role: 'user', content: SENT_TEXT, createdAt: '2026-11-02T00:01:00.000Z' };
    const thisReply = { id: 'ai-this', role: 'assistant', content: '今回の返答です', proposedActions: null, createdAt: '2026-11-02T00:01:01.000Z' };
    await openChat();
    // 1 回目: 時間切れで、会話も取り直せない (確かめられない送信として積む)
    handlers[MESSAGES_KEY] = async () => json(500, { error: 'サーバーでエラーが発生しました' });
    await sendFromInput(async () => {
      throw abortError();
    });
    await waitFor(() => text().includes(TIMEOUT_RELOAD_FAILED_TEXT));
    expect(inputElement().value).toBe(SENT_TEXT);

    // 開き直すと送った文が無い (開き直しの前に積んであったので、届いていないとして忘れる)
    handlers[MESSAGES_KEY] = async () => json(200, { messages: OLD_MESSAGES });
    await switchToSession(MAIN_SESSION_TITLE);
    await waitFor(() => text().includes('野菜を足しましょう'));
    await waitFor(() => !text().includes(TIMEOUT_RELOAD_FAILED_TEXT));

    // 2 回目: 同じ文を送り、応答を受ける前に時間切れ。サーバーには今回の送信とその返答がある。
    // 1 回目を忘れていなければ、1 回目がこの保存行を自分のものとして当て、今回は届いたかを確かめられない文になる
    handlers[MESSAGES_KEY] = async () => json(200, { messages: [...OLD_MESSAGES, thisUser, thisReply] });
    await sendFromInput(async () => {
      throw abortError();
    });

    await waitFor(() => text().includes('今回の返答です'));
    expect(text()).not.toContain(DELIVERY_UNCONFIRMED_TEXT);
    expect(logs.reads[0].filters).toEqual([['message_id', 'ai-this']]);
  });
});
