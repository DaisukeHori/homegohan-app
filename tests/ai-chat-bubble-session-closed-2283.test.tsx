/**
 * #2283 (A) Web の AI 相談 (src/components/AIChatBubble.tsx): 終了した相談への入力と送信を止め、次の手を出す。
 * モバイルの AIAdvisorSheet は apps/mobile/__tests__/ai/advisor-sheet-session-closed-2283.test.tsx が同じ決まりを確かめる。
 *
 * 直す前:
 *   『相談を終了』を受け付けたあとに新しい相談の作成が失敗すると、閉じた相談が今の相談のまま画面に残る。一覧の status は先の
 *   読み直しで終了になるが、入力欄・送信・おすすめの質問・提案の実行・1日献立の作成は止まらず、閉じた相談に会話が足されていった
 *   (サーバーも status を見なかった。サーバーの側は tests/ai-consultation-closed-session-route-2283.test.ts)。
 *
 * いま:
 *   1. 出している相談が終了したと分かっていれば (一覧の status・閉じるの応答)、入力欄・送信・提案の実行・1日献立の作成を止め、
 *      『この相談は終了しています。新しい相談を始めてください』の一文 (1 つだけ) と『新しい相談を始める』を出す
 *   2. 送信が 409 (終了した相談の code) で返ったときも同じ一文と操作を出し、送った文を入力欄に戻し、一覧を読み直す
 *   3. 『新しい相談を始める』で新しい相談を出すと、止めが外れて一文が消え、戻した文をそのまま送れる
 *   4. 409 でも code が違う応答は、ふだんの失敗の扱いのまま (終了とは扱わない)
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_CONSULTATION_SESSION_CLOSED_CODE, AI_CONSULTATION_SESSION_CLOSED_MESSAGE } from '@/lib/ai/ai-api-messages';
import { CONSULTATION_SESSION_CLOSED_STATUS } from '@/lib/ai/consultation-session-closed';
import { AI_CHAT_REPLY_FAILED_MESSAGE } from '@/lib/ai/consultation-reply-reload';
import { pollUntil, sleepRealTime } from './helpers/act-wait';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// 文が出るまでの待ち (tests/helpers/act-wait.ts) は最大 10 秒まで伸びうるので、1 件のテストの時間切れを延ばす
applyHeavyUnitTestTimeout();

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: async () => ({ data: [], error: null }),
      }),
    }),
  }),
}));
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: async () => 'consented', consentModal: null }),
}));
const v4 = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('@/hooks/useV4MenuGeneration', () => ({
  useV4MenuGeneration: () => ({
    isGenerating: false,
    generate: v4.generate,
    subscribeToProgress: vi.fn(() => () => {}),
    cancelGeneration: vi.fn(),
  }),
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

const { default: AIChatBubble, SESSION_CREATE_FAILED_MESSAGE } = await import('@/components/AIChatBubble');

const SESSION_ID = 'session-1';
const OTHER_SESSION_ID = 'session-2';
const NEW_SESSION_ID = 'session-new';
const MAIN_SESSION_TITLE = 'いつもの相談';
const OTHER_SESSION_TITLE = '前に終了した相談';
const SESSIONS_KEY = 'GET /api/ai/consultation/sessions?status=all';
const CREATE_SESSION_KEY = 'POST /api/ai/consultation/sessions';
const messagesKey = (sessionId: string) => `GET /api/ai/consultation/sessions/${sessionId}/messages`;
const sendKey = (sessionId: string) => `POST /api/ai/consultation/sessions/${sessionId}/messages?stream=true`;
const closeKey = (sessionId: string) => `POST /api/ai/consultation/sessions/${sessionId}/close`;

/** 相談 A (SESSION_ID) の会話。AI の返答に実行を待つ提案が付いている */
const MAIN_REPLY_TEXT = '野菜を足しましょう';
const MAIN_MESSAGES = [
  { id: 'old-user', role: 'user', content: '夕飯の相談です', createdAt: '2026-11-01T00:00:00.000Z' },
  {
    id: 'old-ai',
    role: 'assistant',
    content: MAIN_REPLY_TEXT,
    createdAt: '2026-11-01T00:00:01.000Z',
    proposedActions: { type: 'generate_single_meal', params: { date: '2026-11-07', mealType: 'dinner' } },
  },
];
/** 相談 B (OTHER_SESSION_ID。一覧で終了) の会話 */
const OTHER_REPLY_TEXT = '前の相談の返答です';
const OTHER_MESSAGES = [{ id: 'other-ai', role: 'assistant', content: OTHER_REPLY_TEXT, createdAt: '2026-10-30T00:00:01.000Z' }];
/** 新しい相談のようこその一文の書き出し */
const WELCOME_TEXT = 'ほめゴハンのAIアドバイザーです';
/** 送る文 */
const SENT_TEXT = '明日の朝ごはんは?';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 一覧の行 */
function sessionRow(id: string, title: string, messageCount: number, status: string) {
  return { id, title, messageCount, status };
}

let container: HTMLDivElement;
let root: Root;
let handlers: Record<string, FetchHandler>;
let requests: string[];
const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.cookie = 'aiChatBubblePosition=; max-age=0; path=/';
  localStorage.clear();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('alert', vi.fn());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete window.__weeklyCurrentDate;
  v4.generate.mockReset();
  requests = [];
  handlers = {
    [SESSIONS_KEY]: async () =>
      json(200, {
        sessions: [
          sessionRow(SESSION_ID, MAIN_SESSION_TITLE, MAIN_MESSAGES.length, 'active'),
          sessionRow(OTHER_SESSION_ID, OTHER_SESSION_TITLE, OTHER_MESSAGES.length, 'closed'),
        ],
      }),
    [messagesKey(SESSION_ID)]: async () => json(200, { messages: MAIN_MESSAGES }),
    [messagesKey(OTHER_SESSION_ID)]: async () => json(200, { messages: OTHER_MESSAGES }),
    [messagesKey(NEW_SESSION_ID)]: async () => json(200, { messages: [] }),
    [CREATE_SESSION_KEY]: async () => json(200, { session: { id: NEW_SESSION_ID } }),
    [closeKey(SESSION_ID)]: async () => json(200, { summary: null }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
      requests.push(key);
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
  HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function text(): string {
  return container.textContent ?? '';
}

/** 文 (needle) が画面に何回出ているか */
function occurrences(needle: string): number {
  return text().split(needle).length - 1;
}

async function waitFor(condition: () => boolean) {
  await pollUntil(condition);
  expect(condition()).toBe(true);
}

/** 何も起きないことを確かめるときに待つ実時間 (ミリ秒。待ちの 1 回 (ACT_WAIT_POLL_MS = 20) より少し長く) */
const SETTLE_MS = 50;

async function settle() {
  await act(async () => {
    await sleepRealTime(SETTLE_MS);
  });
}

function requestCount(key: string): number {
  return requests.filter((r) => r === key).length;
}

function buttonWithText(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent ?? '').includes(label));
}

async function render() {
  await act(async () => {
    root.render(createElement(AIChatBubble));
  });
}

async function openChat(shownText = MAIN_REPLY_TEXT) {
  await render();
  const fab = container.querySelector<HTMLElement>('[data-testid="ai-chat-floating-button"]');
  expect(fab).not.toBeNull();
  await act(async () => {
    fab!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    fab!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0 }));
  });
  await waitFor(() => text().includes(shownText));
}

function inputElement(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[placeholder="メッセージを入力..."]');
  expect(input).not.toBeNull();
  return input!;
}

function sendButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="メッセージを送信"]');
  expect(button).not.toBeNull();
  return button!;
}

async function typeText(value: string) {
  const input = inputElement();
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 入力欄で Enter を押す (disabled でも keydown の処理は呼ばれるので、送信の入口の止めを確かめられる) */
async function pressEnter() {
  await act(async () => {
    inputElement().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

function closedNotice(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="ai-chat-session-closed"]');
}

function closedNoticeNewSessionButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[data-testid="ai-chat-session-closed-new-session"]');
  expect(button).not.toBeNull();
  return button!;
}

/** 提案のカードの「実行する」 */
function executeButton(): HTMLButtonElement {
  const button = buttonWithText('実行する');
  expect(button).toBeDefined();
  return button!;
}

async function openSessionList() {
  const toggle = container.querySelector('svg.lucide-chevron-down')?.closest('button');
  expect(toggle).toBeTruthy();
  await act(async () => {
    toggle!.click();
  });
  await waitFor(() => buttonWithText(OTHER_SESSION_TITLE) !== undefined);
}

async function clickClose() {
  const button = container.querySelector<HTMLButtonElement>('button[title="相談を終了して要約を保存"]');
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
  });
}

/** 出している相談が終了した画面: 一文 1 つと『新しい相談を始める』・入力欄と送信と提案の実行と 1日献立変更が止まっている */
function expectClosedScreen() {
  expect(closedNotice()).not.toBeNull();
  expect(closedNotice()!.textContent).toContain(AI_CONSULTATION_SESSION_CLOSED_MESSAGE);
  expect(occurrences(AI_CONSULTATION_SESSION_CLOSED_MESSAGE)).toBe(1);
  expect(closedNoticeNewSessionButton().textContent).toContain('新しい相談を始める');
  expect(inputElement().disabled).toBe(true);
  expect(sendButton().disabled).toBe(true);
  expect(buttonWithText('1日献立変更')?.disabled).toBe(true);
}

/** 『相談を終了』を受け付けたあと、新しい相談の作成が失敗して、閉じた相談が今の相談のまま残る順序 */
async function archiveThenCreateFails(options: { reloadedListFails: boolean }) {
  await openChat();
  // 閉じたあとの一覧の読み直し: 閉じた相談は終了 (または読めない)
  handlers[SESSIONS_KEY] = options.reloadedListFails
    ? async () => json(500, { error: '一覧を読めませんでした' })
    : async () => json(200, { sessions: [sessionRow(SESSION_ID, MAIN_SESSION_TITLE, MAIN_MESSAGES.length, 'closed')] });
  handlers[CREATE_SESSION_KEY] = async () => json(500, { error: '作れませんでした' });
  await clickClose();
  await waitFor(() => text().includes(SESSION_CREATE_FAILED_MESSAGE));
  await settle();
  // 閉じた相談が今の相談のまま (会話がそのまま)
  expect(text()).toContain(MAIN_REPLY_TEXT);
  expect(text()).not.toContain(WELCOME_TEXT);
}

describe('#2283 (A) 終了した相談が今の相談として残ったら、入力と送信を止めて次の手を出す', () => {
  it('アーカイブを受け付けたあとに作成が失敗して閉じた相談が残ると、入力欄・送信・提案の実行・1日献立を止め、一文と『新しい相談を始める』を出す', async () => {
    await archiveThenCreateFails({ reloadedListFails: false });

    expectClosedScreen();
    expect(executeButton().disabled).toBe(true);

    // 入力欄の Enter (入口の止め) でも、閉じた相談へ送らない
    await typeText(SENT_TEXT);
    await pressEnter();
    await settle();
    expect(requestCount(sendKey(SESSION_ID))).toBe(0);

    // 提案の「実行する」を押しても実行しない
    await act(async () => {
      executeButton().click();
    });
    await settle();
    expect(requests.some((r) => r.includes('/api/ai/consultation/actions/'))).toBe(false);
  });

  it('閉じたあとの一覧の読み直しも失敗しても、閉じるを受け付けた相談は終了として止める', async () => {
    await archiveThenCreateFails({ reloadedListFails: true });

    expectClosedScreen();
    await typeText(SENT_TEXT);
    await pressEnter();
    await settle();
    expect(requestCount(sendKey(SESSION_ID))).toBe(0);
  });

  it('『新しい相談を始める』で新しい相談を出すと、止めが外れて一文が消える', async () => {
    await archiveThenCreateFails({ reloadedListFails: false });
    handlers[CREATE_SESSION_KEY] = async () => json(200, { session: { id: NEW_SESSION_ID } });
    handlers[SESSIONS_KEY] = async () =>
      json(200, {
        sessions: [
          sessionRow(NEW_SESSION_ID, 'AI相談', 0, 'active'),
          sessionRow(SESSION_ID, MAIN_SESSION_TITLE, MAIN_MESSAGES.length, 'closed'),
        ],
      });

    await act(async () => {
      closedNoticeNewSessionButton().click();
    });
    await waitFor(() => text().includes(WELCOME_TEXT));

    expect(requestCount(CREATE_SESSION_KEY)).toBe(2);
    expect(closedNotice()).toBeNull();
    expect(occurrences(AI_CONSULTATION_SESSION_CLOSED_MESSAGE)).toBe(0);
    expect(inputElement().disabled).toBe(false);
  });

  it('一覧で終了の相談に切り替えても、入力と送信を止めて一文を出す', async () => {
    await openChat();
    expect(closedNotice()).toBeNull();
    await openSessionList();
    await act(async () => {
      buttonWithText(OTHER_SESSION_TITLE)!.click();
    });
    await waitFor(() => text().includes(OTHER_REPLY_TEXT));

    expectClosedScreen();
  });
});

describe('#2283 (A) 送信が 409 (終了した相談) で返ったとき', () => {
  /** 送信を 409 で返す (code を変えられる) */
  function rejectSendWith(code: string) {
    handlers[sendKey(SESSION_ID)] = async () =>
      json(CONSULTATION_SESSION_CLOSED_STATUS, { error: AI_CONSULTATION_SESSION_CLOSED_MESSAGE, code });
  }

  it('同じ一文と『新しい相談を始める』を出し、送った文を入力欄に戻し、一覧を読み直して終了に合わせる', async () => {
    await openChat();
    rejectSendWith(AI_CONSULTATION_SESSION_CLOSED_CODE);
    // 読み直した一覧では、ほかの画面で閉じた相談が終了
    const sessionsBefore = requestCount(SESSIONS_KEY);
    handlers[SESSIONS_KEY] = async () =>
      json(200, { sessions: [sessionRow(SESSION_ID, MAIN_SESSION_TITLE, MAIN_MESSAGES.length, 'closed')] });

    await typeText(SENT_TEXT);
    await act(async () => {
      sendButton().click();
    });
    await waitFor(() => closedNotice() !== null);
    await waitFor(() => requestCount(SESSIONS_KEY) === sessionsBefore + 1);
    await settle();

    expect(requestCount(sendKey(SESSION_ID))).toBe(1);
    expectClosedScreen();
    // 送った文は失われない (入力欄に戻す)。送っていないので、仮の吹き出しも失敗の文も残さない
    expect(inputElement().value).toBe(SENT_TEXT);
    expect(occurrences(SENT_TEXT)).toBe(0);
    expect(text()).not.toContain(AI_CHAT_REPLY_FAILED_MESSAGE);
    expect(executeButton().disabled).toBe(true);

    // 二度目の送信も止まる
    await pressEnter();
    await settle();
    expect(requestCount(sendKey(SESSION_ID))).toBe(1);
  });

  it('一覧の読み直しが失敗しても、終了した相談として止める (一覧の失敗の一文も出す)', async () => {
    await openChat();
    rejectSendWith(AI_CONSULTATION_SESSION_CLOSED_CODE);
    handlers[SESSIONS_KEY] = async () => json(500, { error: '一覧を読めませんでした' });

    await typeText(SENT_TEXT);
    await act(async () => {
      sendButton().click();
    });
    await waitFor(() => closedNotice() !== null);
    await settle();

    expectClosedScreen();
    expect(inputElement().value).toBe(SENT_TEXT);
  });

  it('戻した文は、『新しい相談を始める』のあとの新しい相談からそのまま送れる', async () => {
    await openChat();
    rejectSendWith(AI_CONSULTATION_SESSION_CLOSED_CODE);
    await typeText(SENT_TEXT);
    await act(async () => {
      sendButton().click();
    });
    await waitFor(() => closedNotice() !== null);
    await settle();

    await act(async () => {
      closedNoticeNewSessionButton().click();
    });
    await waitFor(() => text().includes(WELCOME_TEXT));

    expect(closedNotice()).toBeNull();
    expect(inputElement().value).toBe(SENT_TEXT);
    expect(sendButton().disabled).toBe(false);
  });

  it('409 でも code が違う応答は、終了した相談として扱わない (ふだんの送信の失敗のまま)', async () => {
    await openChat();
    rejectSendWith('SOMETHING_ELSE');

    await typeText(SENT_TEXT);
    await act(async () => {
      sendButton().click();
    });
    await waitFor(() => text().includes(AI_CHAT_REPLY_FAILED_MESSAGE));
    await settle();

    expect(closedNotice()).toBeNull();
    expect(inputElement().disabled).toBe(false);
  });
});
