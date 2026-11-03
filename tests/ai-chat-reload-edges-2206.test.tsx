/**
 * #2206 G2 Web の AI 相談 (src/components/AIChatBubble.tsx) で、送信の応答 (finalData) を受け取れなかったあとの取り直しの縁。
 *
 * 直す前:
 *   - 返答の保存と提案の記録の行の作成の間に取り直しが当たると、行の無いカード (GET の failed『もう一度 AI に頼んでください』) を写し、
 *     頼み直しを勧めていた (二重に作りうる)
 *   - 記録を読み直して実行を待つ・失敗した行になっても、一文 (『実行中か実行済み』) とカード (『確かめられませんでした』) が残った
 *   - 同じ文を送り直すと、前の送信 (時間切れで確かめられず、画面に保存行の id が無い) を今回の送信と取り違え、前の返答の結果を出した
 *   - 返答がまだ無い (DELIVERED_NO_REPLY) ときに読み直しの予約が無く、あとで実行が済んでも mealPlanUpdated が出なかった。
 *     読み直しは送った文の保存行の id で返答を探す (本文で探すと、待つ間に同じ文を送り直したとき後の送信の返答を前の送信に入れ、
 *     同じ返答が 2 つ並んで前の送信の返答が出なかった)
 *   - GET が実行できた (カードを出さない) 返答で、記録の直読みだけが失敗すると、通知が出なかった
 *   - サーバーが失敗を知らせた (SSE の error だけ) のに、取り直すと『返答を作っているところかもしれません』に上書きした
 *   - 取り直しの GET に上限が無く、返らないと送信中のまま止まった
 *   - 取り直しの最中に相談を切り替えると、別の相談の入力欄に送った文が戻りえた
 *   - 時間切れのあと取り直しにも失敗すると、送った文を入力欄に戻さなかった
 *   - 応答を受ける前に通信が切れた (TypeError) ときは、取り直さずに『再試行してください』を出した
 *   - おすすめの質問のボタンには送信の流れの写しがあり、取り直しで届いていない・確かめられない・取り直せないときに、送った文を
 *     入力欄に戻さなかった (『入力欄の文をもう一度送ってください』が空の入力欄を指し、ボタンも消えていて押し直せなかった)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollUntil, sleepRealTime } from './helpers/act-wait';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// 文が出るまでの待ち (tests/helpers/act-wait.ts) は最大 10 秒まで伸びうるので、1 件のテストの時間切れを延ばす
// (根拠と環境変数での上書きは tests/helpers/heavy-unit-test-timeout.ts)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

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
const DELIVERY_UNCONFIRMED_TEXT =
  '相談がサーバーに届いたかを確かめられませんでした。少し待ってから相談を開き直し、送った文が無ければ、入力欄の文をもう一度送ってください。';
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
  consent.answer = 'consented';
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

function occurrences(needle: string): number {
  return text().split(needle).length - 1;
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
    holdRecheck();
    await sendFromInput(timesOutAfterSaving(savedMessages(savedReply(NO_ROW_YET_CARD))));

    await waitFor(() => text().includes(RUNNING_NOTE));
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    // 行が無いときの GET の『もう一度 AI に頼んでください』を写さない
    expect(text()).not.toContain(RETRY_GUIDE);
    expectNoteRightAfter(SAVED_REPLY, RUNNING_NOTE);

    await releaseRecheck();
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
    holdRecheck();
    await sendFromInput(timesOutAfterSaving(savedMessages(savedReply(RUNNING_CARD))));

    await waitFor(() => text().includes(RUNNING_NOTE));
    expect(executeButtonShown()).toBe(false);
    await releaseRecheck();
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

  it('待つ間に同じ文を送り直しても、前の送信の仮のメッセージには前の送信の返答を入れる (同じ返答を 2 つ並べない)', async () => {
    const earlierReply = { id: 'ai-earlier', role: 'assistant', content: '前の送信への返答です', proposedActions: null, createdAt: '2026-11-02T00:00:01.000Z' };
    const laterUser = { id: 'user-later', role: 'user', content: SENT_TEXT, createdAt: '2026-11-02T00:00:05.000Z' };
    const laterReply = { id: 'ai-later', role: 'assistant', content: '送り直しへの返答です', proposedActions: null, createdAt: '2026-11-02T00:00:06.000Z' };
    await openChat();
    // 1 回目の取り直し (2 回目の GET) では前の送信 (SAVED_USER) の返答がまだ無い。その後は、前の送信の返答と、
    // 同じ文の送り直しとその返答がサーバーに保存されている
    handlers[MESSAGES_KEY] = async () => {
      messagesGets += 1;
      return json(200, {
        messages: messagesGets <= 2 ? [...OLD_MESSAGES, SAVED_USER] : [...OLD_MESSAGES, SAVED_USER, earlierReply, laterUser, laterReply],
      });
    };
    holdRecheck();
    await sendFromInput(async () => {
      throw abortError();
    });
    await waitFor(() => text().includes(DELIVERED_NO_REPLY_TEXT));

    // 返答を待つ間に同じ文を送り直す (これも時間切れ。取り直しで送り直しの返答が出る)
    await sendFromInput(async () => {
      throw abortError();
    });

    await releaseRecheck();
    await waitFor(() => text().includes('前の送信への返答です') && text().includes('送り直しへの返答です'));
    await waitPastRecheck();
    expect(occurrences('前の送信への返答です')).toBe(1);
    expect(occurrences('送り直しへの返答です')).toBe(1);
    expect(occurrences(SENT_TEXT)).toBe(2);
    expect(text()).not.toContain(DELIVERED_NO_REPLY_TEXT);
    // 前の送信の返答が先、送り直しの返答が後 (送った順)
    const texts = aiBubbleTexts();
    expect(texts.findIndex((t) => t.includes('前の送信への返答です'))).toBeLessThan(texts.findIndex((t) => t.includes('送り直しへの返答です')));
    // 同じ id (React の key) の吹き出しを 2 つ並べない
    const errorTexts = vi.mocked(console.error).mock.calls.map((call) => call.map(String).join(' '));
    expect(errorTexts.filter((t) => t.includes('same key'))).toEqual([]);
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

describe('#2206 G2 返答を待つ取り直しの予約は、部品を外すときに取り消す (#2201 X1 の予約の関数で予約する)', () => {
  it('取り直しの前に外したら、外さなければ取り直す時刻を過ぎても取り直さず、通知もしない', async () => {
    logs.results = [{ data: [{ status: 'executed', action_type: 'generate_single_meal' }], error: null }];
    await openChat();
    // 1 回目の取り直し (2 回目の GET) では返答がまだ無く、その後の取り直しなら返答と実行の結果が見える
    handlers[MESSAGES_KEY] = async () => {
      messagesGets += 1;
      return json(200, { messages: messagesGets <= 2 ? [...OLD_MESSAGES, SAVED_USER] : savedMessages() });
    };
    holdRecheck();
    await sendFromInput(async () => {
      throw abortError();
    });
    await waitFor(() => text().includes(DELIVERED_NO_REPLY_TEXT));
    expect(messagesGets).toBe(2);

    act(() => root.unmount());
    root = createRoot(container);
    // 外さなければ取り直す時刻を過ぎても (偽の時刻を進めても)、取り直さない
    await releaseRecheck();
    await waitPastRecheck();
    expect(messagesGets).toBe(2);
    expect(logs.reads).toHaveLength(0);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
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
  it('取り直しの GET が返らなければ AI_CHAT_RELOAD_TIMEOUT_MS で打ち切り、開き直してもらう文を出して送信中を終える', async () => {
    await openChat();
    let reloadSignal: AbortSignal | null | undefined;
    handlers[MESSAGES_KEY] = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        reloadSignal = init?.signal;
        init?.signal?.addEventListener('abort', () => reject(abortError()));
      });
    // 取り直しの上限のタイマーだけを手で進める (React の描画の予定は setImmediate なので進めなくてよい)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await sendFromInput(async () => {
      throw abortError();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reloadSignal).toBeInstanceOf(AbortSignal);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_CHAT_RELOAD_TIMEOUT_MS - 1);
    });
    expect(reloadSignal?.aborted).toBe(false);
    expect(text()).not.toContain(TIMEOUT_RELOAD_FAILED_TEXT);
    // 送信中の間は入力欄を使えない
    expect(inputElement().disabled).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(reloadSignal?.aborted).toBe(true);
    expect(text()).toContain(TIMEOUT_RELOAD_FAILED_TEXT);
    // 送信中を終え、送った文は入力欄に戻す (送り直せる)
    expect(inputElement().value).toBe(SENT_TEXT);
    expect(inputElement().disabled).toBe(false);
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

describe('#2206 G2 おすすめの質問から送ったときも、送信欄と同じ送信の流れを通り、送った文を入力欄に戻す', () => {
  /** 時間がかかる依頼のおすすめの質問 (献立の作成。時間切れになりやすい) */
  const QUICK_PROMPT = '来週の献立を作りたい';
  const SAVED_QUICK_USER = { id: 'user-saved-q', role: 'user', content: QUICK_PROMPT, createdAt: '2026-11-02T00:00:00.000Z' };

  /** 相談がまだ無い (新しく作る) ときだけ、ようこその一文とおすすめの質問が出る */
  async function openEmptyChat() {
    handlers['GET /api/ai/consultation/sessions?status=all'] = async () => json(200, { sessions: [] });
    handlers['POST /api/ai/consultation/sessions'] = async () => json(200, { session: { id: SESSION_ID } });
    await act(async () => {
      root.render(createElement(AIChatBubble));
    });
    const fab = container.querySelector('[data-testid="ai-chat-floating-button"]');
    expect(fab).not.toBeNull();
    await act(async () => {
      fab!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
      fab!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0 }));
    });
    await waitFor(() => quickPromptButton() !== undefined);
  }

  function quickPromptButton(): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === QUICK_PROMPT);
  }

  async function pressQuickPrompt(onSend: FetchHandler) {
    handlers[SEND_KEY] = onSend;
    const button = quickPromptButton();
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });
  }

  it.each<[string, () => Error]>([
    ['時間切れ', abortError],
    ['通信の切断 (TypeError)', () => new TypeError('Failed to fetch')],
  ])(
    '応答を受ける前に終わり (%s)、取り直した会話に送った文が無ければ『確かめられませんでした』を出し、送った文を入力欄に戻す',
    async (_label, failure) => {
      await openEmptyChat();
      serverMessages = [];
      await pressQuickPrompt(async () => {
        throw failure();
      });

      await waitFor(() => text().includes(DELIVERY_UNCONFIRMED_TEXT));
      expect(messagesGets).toBe(1);
      // 文が指す『入力欄の文』がある (おすすめの質問のボタンは、楽観的に出したメッセージで消えていて押し直せない)
      expect(inputElement().value).toBe(QUICK_PROMPT);
      expect(quickPromptButton()).toBeUndefined();
      expect(inputElement().disabled).toBe(false);
    },
  );

  it('時間切れのあと会話も取り直せなければ、開き直してもらう文を出し、送った文を入力欄に戻す', async () => {
    await openEmptyChat();
    handlers[MESSAGES_KEY] = async () => json(500, { error: 'サーバーでエラーが発生しました' });
    await pressQuickPrompt(async () => {
      throw abortError();
    });

    await waitFor(() => text().includes(TIMEOUT_RELOAD_FAILED_TEXT));
    expect(inputElement().value).toBe(QUICK_PROMPT);
    expect(quickPromptButton()).toBeUndefined();
  });

  it('届いていて返答があれば、入力欄には戻さない (上の対照。戻すと同じ依頼を二重に送りうる)', async () => {
    logs.results = [{ data: [{ status: 'executed', action_type: 'generate_single_meal' }], error: null }];
    await openEmptyChat();
    await pressQuickPrompt(async () => {
      serverMessages = [SAVED_QUICK_USER, savedReply()];
      throw abortError();
    });

    await waitFor(() => text().includes(EXECUTED_NOTE));
    expectNoteRightAfter(SAVED_REPLY, EXECUTED_NOTE);
    expect(inputElement().value).toBe('');
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
  });

  it('「同意しない」なら送らず、楽観的に出したメッセージを消し、送ろうとした文を入力欄に戻す (送信欄と同じ)', async () => {
    consent.answer = 'declined';
    await openEmptyChat();
    let sends = 0;
    await pressQuickPrompt(async () => {
      sends += 1;
      throw abortError();
    });

    await waitFor(() => inputElement().value === QUICK_PROMPT);
    expect(sends).toBe(0);
    // ようこその一文だけに戻るので、おすすめの質問のボタンも出る
    expect(quickPromptButton()).toBeDefined();
    expect(inputElement().disabled).toBe(false);
  });
});

describe('#2206 G2 送信の流れ (会話の続きの POST) は画面の中で 1 か所だけ', () => {
  // 以前はおすすめの質問のボタンに送信の流れの写しがあり、取り直しの縁の直し (serverFailed・通信の切断・保存の遅れ・入力欄の戻し方)
  // を 2 か所に書く必要があって、写しのほうが食い違った。写しを作り直したら、ここで止める
  it('POST /api/ai/consultation/sessions/{id}/messages?stream=true を呼ぶのは sendMessage の 1 か所だけ', () => {
    const file = 'src/components/AIChatBubble.tsx';
    const source = ts.createSourceFile(file, readFileSync(join(process.cwd(), file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const owners: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.arguments.length > 0 &&
        (ts.isTemplateExpression(node.arguments[0]) || ts.isStringLiteralLike(node.arguments[0])) &&
        node.arguments[0].getText().includes('/messages?stream=true')
      ) {
        owners.push(ownerFunctionNameOf(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(owners).toEqual(['sendMessage']);
  });

  /** node を含む、名前のある (const f = (...) => ... の形の) いちばん内側の関数の名前 */
  function ownerFunctionNameOf(node: ts.Node): string {
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && ts.isVariableDeclaration(cur.parent) && ts.isIdentifier(cur.parent.name)) {
        return cur.parent.name.text;
      }
    }
    return '(無名)';
  }
});
