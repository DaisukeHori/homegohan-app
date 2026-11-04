/**
 * #2245 K1 Web の AI 相談 (src/components/AIChatBubble.tsx) の回帰テスト。モバイルの AIAdvisorSheet は
 * apps/mobile/__tests__/ai/advisor-sheet-session-races-2245.test.tsx が同じ決まりを確かめる。
 *
 * 直す前:
 *   1. 会話の読み込み (fetchMessages) は await のあと、今出している相談の応答かを確かめずに画面の会話を置き換えた。
 *      (a) 相談を A→B と切り替えたあとに遅れて返った A の会話が、B の画面に出た
 *      (b) 切り替えの直後に『相談を終了』を押すと、閉じたあとの新しい相談の画面に、遅れて返った閉じた相談の会話が出た
 *      (c) 閉じる応答待ちの間にチャットを閉じて開き直すと、開き直しの読み込み (openChat) が閉じる応答待ちを見ずに走り、
 *          遅れて返った閉じた相談の会話が、閉じたあとの新しい相談の画面に出た
 *   2. 閉じる応答待ちの間も『1日献立変更』を押せ (disabled も入口も閉じる応答待ちを見なかった)、チャットに足した
 *      『○月○日の献立を作成中...』が閉じる側の新しい相談の画面の置き換えで消えた
 *   3. 『相談を終了』の失敗の応答 (400 など) と通信の失敗で、何も知らせなかった
 *   4. 1 日分の献立の日付の欄を空にして作成を押すと『NaN月NaN日の献立を作成中...』を出し、date '' で依頼した
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_CHAT_DISABLED_CODE,
  AI_CHAT_DISABLED_MESSAGE,
  LEGAL_CONSENT_REQUIRED_CODE,
  LEGAL_CONSENT_REQUIRED_MESSAGE,
  MAINTENANCE_API_CODE,
  MAINTENANCE_MESSAGE,
} from '@homegohan/shared';
import { AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE } from '@/lib/ai/ai-api-messages';
import { CONSULTATION_CLOSE_FAILED_MESSAGE, consultationCloseFailureOf } from '@/lib/ai/consultation-close-failure';
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
/** 献立の生成の依頼 (beforeEach で呼ばれた記録を消す) */
const v4 = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('@/hooks/useV4MenuGeneration', () => ({
  useV4MenuGeneration: () => ({ isGenerating: false, generate: v4.generate, subscribeToProgress: vi.fn() }),
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
const OTHER_SESSION_ID = 'session-2';
const NEW_SESSION_ID = 'session-new';
const MAIN_SESSION_TITLE = 'いつもの相談';
const OTHER_SESSION_TITLE = '別の相談';
const SESSIONS_KEY = 'GET /api/ai/consultation/sessions?status=all';
const CREATE_SESSION_KEY = 'POST /api/ai/consultation/sessions';
const messagesKey = (sessionId: string) => `GET /api/ai/consultation/sessions/${sessionId}/messages`;
const closeKey = (sessionId: string) => `POST /api/ai/consultation/sessions/${sessionId}/close`;

/** 相談 A (SESSION_ID) の会話の返答の文 */
const MAIN_REPLY_TEXT = '野菜を足しましょう';
const MAIN_MESSAGES = [
  { id: 'old-user', role: 'user', content: '夕飯の相談です', createdAt: '2026-11-01T00:00:00.000Z' },
  { id: 'old-ai', role: 'assistant', content: MAIN_REPLY_TEXT, createdAt: '2026-11-01T00:00:01.000Z' },
];
/** 相談 B (OTHER_SESSION_ID) の会話の返答の文 */
const OTHER_REPLY_TEXT = '別の相談の返答です';
const OTHER_MESSAGES = [
  { id: 'other-ai', role: 'assistant', content: OTHER_REPLY_TEXT, createdAt: '2026-10-30T00:00:01.000Z' },
];
/** 新しい相談のようこその一文の書き出し (部品の文が変わったらこのテストも直す) */
const WELCOME_TEXT = 'ほめゴハンのAIアドバイザーです';
const DAY_MENU_STARTED_TEXT = 'の献立を作成中...';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let handlers: Record<string, FetchHandler>;
/** 部品が出した fetch の `METHOD url` (順に) */
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
          { id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 },
          { id: OTHER_SESSION_ID, title: OTHER_SESSION_TITLE, messageCount: 1 },
        ],
      }),
    [messagesKey(SESSION_ID)]: async () => json(200, { messages: MAIN_MESSAGES }),
    [messagesKey(OTHER_SESSION_ID)]: async () => json(200, { messages: OTHER_MESSAGES }),
    [CREATE_SESSION_KEY]: async () => json(200, { session: { id: NEW_SESSION_ID } }),
    [closeKey(SESSION_ID)]: async () => json(200, { summary: null }),
    [closeKey(OTHER_SESSION_ID)]: async () => json(200, { summary: null }),
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
  vi.useRealTimers();
});

function text(): string {
  return container.textContent ?? '';
}

/** 条件が真になるまで待つ (実時間。1 回の待ちと上限は tests/helpers/act-wait.ts) */
async function waitFor(condition: () => boolean) {
  await pollUntil(condition);
  expect(condition()).toBe(true);
}

/**
 * 押下・応答のあとに何も起きないことを確かめるときに待つ実時間 (ミリ秒)。続き (fetch は mock) はマイクロタスクで進むので、
 * 待ちの 1 回 (tests/helpers/act-wait.ts の ACT_WAIT_POLL_MS = 20) より少し長く取る
 */
const SETTLE_MS = 50;

async function settle() {
  await act(async () => {
    await sleepRealTime(SETTLE_MS);
  });
}

function requestCount(key: string): number {
  return requests.filter((r) => r === key).length;
}

function hold(key: string): Deferred<Response> {
  const pending = deferred<Response>();
  handlers[key] = () => pending.promise;
  return pending;
}

function fab(): HTMLElement {
  const button = container.querySelector<HTMLElement>('[data-testid="ai-chat-floating-button"]');
  expect(button).not.toBeNull();
  return button!;
}

/** 浮かんでいるボタンを押してチャットを開く (開いたあとの読み込みは待たない) */
async function pressFab() {
  await act(async () => {
    fab().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    fab().dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0 }));
  });
}

async function render() {
  await act(async () => {
    root.render(createElement(AIChatBubble));
  });
}

/** チャットを開き、shownText (会話の文) が出るまで待つ */
async function openChat(shownText = MAIN_REPLY_TEXT) {
  await render();
  await pressFab();
  await waitFor(() => text().includes(shownText));
}

/** チャットを閉じる (×)。開閉の連続クリック防止 (CHAT_OPEN_TOGGLE_LOCK_MS) は × が下ろす */
async function closeChatWindow() {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="AIチャットを閉じる"]');
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
  });
  await waitFor(() => container.querySelector('[data-testid="ai-chat-floating-button"]') !== null);
}

function closeButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[title="相談を終了して要約を保存"]');
  expect(button).not.toBeNull();
  return button!;
}

function buttonWithText(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent ?? '').includes(label));
}

function dayMenuButton(): HTMLButtonElement {
  const button = buttonWithText('1日献立変更');
  expect(button).toBeDefined();
  return button!;
}

function createDayMenuButton(): HTMLButtonElement {
  const button = buttonWithText('作成する');
  expect(button).toBeDefined();
  return button!;
}

async function openSessionList() {
  const toggle = container.querySelector('svg.lucide-chevron-down')?.closest('button');
  expect(toggle).toBeTruthy();
  await act(async () => {
    toggle!.click();
  });
  await waitFor(() => buttonWithText('新しい相談を始める') !== undefined);
}

async function pressSessionRow(title: string) {
  const row = buttonWithText(title);
  expect(row).toBeDefined();
  await act(async () => {
    row!.click();
  });
}

async function clickClose(sessionId = SESSION_ID) {
  const before = requestCount(closeKey(sessionId));
  await act(async () => {
    closeButton().click();
  });
  await waitFor(() => requestCount(closeKey(sessionId)) === before + 1);
}

describe('#2245 K1 1 会話の読み込みは、返ったときに今出している相談のものだけを画面に置く', () => {
  it('(a) A→B と切り替えたあとに遅れて返った A の会話を、B の画面に出さない', async () => {
    const mainLoad = hold(messagesKey(SESSION_ID));
    await render();
    await pressFab();
    await waitFor(() => requestCount(messagesKey(SESSION_ID)) === 1);

    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => text().includes(OTHER_REPLY_TEXT));

    await act(async () => {
      mainLoad.resolve(json(200, { messages: MAIN_MESSAGES }));
    });
    await settle();

    expect(text()).toContain(OTHER_REPLY_TEXT);
    expect(text()).not.toContain(MAIN_REPLY_TEXT);
  });

  it('(b) 切り替えの直後に『相談を終了』を押すと、閉じたあとの新しい相談の画面に、遅れて返った閉じた相談の会話を出さない', async () => {
    await openChat();
    const otherLoad = hold(messagesKey(OTHER_SESSION_ID));
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await waitFor(() => requestCount(messagesKey(OTHER_SESSION_ID)) === 1);

    await clickClose(OTHER_SESSION_ID);
    await waitFor(() => requestCount(CREATE_SESSION_KEY) === 1 && text().includes(WELCOME_TEXT));

    await act(async () => {
      otherLoad.resolve(json(200, { messages: OTHER_MESSAGES }));
    });
    await settle();

    expect(text()).toContain(WELCOME_TEXT);
    expect(text()).not.toContain(OTHER_REPLY_TEXT);
  });

  it('(c) 閉じる応答待ちの間にチャットを閉じて開き直しても、開き直しは読み込まず、閉じたあとの新しい相談の画面のまま', async () => {
    await openChat();
    const close = hold(closeKey(SESSION_ID));
    await clickClose();
    // 開き直しの読み込みが走っても (直す前)、その会話は閉じる応答のあとまで返らないようにする
    const reopenLoad = hold(messagesKey(SESSION_ID));
    const sessionsBefore = requestCount(SESSIONS_KEY);
    const messagesBefore = requestCount(messagesKey(SESSION_ID));

    await closeChatWindow();
    await pressFab();
    await settle();
    expect(requestCount(SESSIONS_KEY)).toBe(sessionsBefore);
    expect(requestCount(messagesKey(SESSION_ID))).toBe(messagesBefore);

    await act(async () => {
      close.resolve(json(200, { summary: null }));
    });
    await waitFor(() => text().includes(WELCOME_TEXT));
    await act(async () => {
      reopenLoad.resolve(json(200, { messages: MAIN_MESSAGES }));
    });
    await settle();

    expect(text()).toContain(WELCOME_TEXT);
    expect(text()).not.toContain(MAIN_REPLY_TEXT);
  });

  it('(c) 開き直しの一覧を待つ間に『相談を終了』を押したら、一覧のあとも会話を読み込まない (閉じる側に任せる)', async () => {
    await openChat();
    await closeChatWindow();
    const sessionsLoad = hold(SESSIONS_KEY);
    await pressFab();
    await waitFor(() => requestCount(SESSIONS_KEY) === 2);
    const messagesBefore = requestCount(messagesKey(SESSION_ID));

    const close = hold(closeKey(SESSION_ID));
    await clickClose();
    await act(async () => {
      sessionsLoad.resolve(
        json(200, { sessions: [{ id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 }] }),
      );
    });
    await settle();
    expect(requestCount(messagesKey(SESSION_ID))).toBe(messagesBefore);

    handlers[SESSIONS_KEY] = async () => json(200, { sessions: [] });
    await act(async () => {
      close.resolve(json(200, { summary: null }));
    });
    await waitFor(() => text().includes(WELCOME_TEXT));
    expect(requestCount(messagesKey(SESSION_ID))).toBe(messagesBefore);
  });

  it('対照: 切り替えた相談の会話は、その相談を出している間に返れば画面に出る', async () => {
    await openChat();
    const otherLoad = hold(messagesKey(OTHER_SESSION_ID));
    await openSessionList();
    await pressSessionRow(OTHER_SESSION_TITLE);
    await act(async () => {
      otherLoad.resolve(json(200, { messages: OTHER_MESSAGES }));
    });
    await waitFor(() => text().includes(OTHER_REPLY_TEXT));
    expect(text()).not.toContain(MAIN_REPLY_TEXT);
  });
});

describe('#2245 K1 2 相談を閉じる応答待ちの間は『1日献立変更』を止める', () => {
  it('描画の側: 閉じる応答待ちの間はボタンが止まり、応答のあとまた押せる', async () => {
    await openChat();
    expect(dayMenuButton().disabled).toBe(false);
    const close = hold(closeKey(SESSION_ID));
    await clickClose();

    expect(dayMenuButton().disabled).toBe(true);

    await act(async () => {
      close.resolve(json(200, { summary: null }));
    });
    await waitFor(() => text().includes(WELCOME_TEXT));
    await waitFor(() => !dayMenuButton().disabled);
  });

  it('入口の側: 閉じると同じ描画のうちに開いたモーダルの「作成する」を押しても作らない (作成中の一文も出さない)', async () => {
    await openChat();
    const close = hold(closeKey(SESSION_ID));
    await act(async () => {
      closeButton().click();
      dayMenuButton().click();
    });
    await waitFor(() => requestCount(closeKey(SESSION_ID)) === 1);
    await act(async () => {
      createDayMenuButton().click();
    });
    await settle();

    expect(v4.generate).not.toHaveBeenCalled();
    expect(text()).not.toContain(DAY_MENU_STARTED_TEXT);

    await act(async () => {
      close.resolve(json(200, { summary: null }));
    });
    await waitFor(() => text().includes(WELCOME_TEXT));
    expect(v4.generate).not.toHaveBeenCalled();
  });
});

describe('#2245 K1 3 『相談を終了』の失敗を知らせる', () => {
  async function closeWith(response: () => Promise<Response>) {
    await openChat();
    handlers[closeKey(SESSION_ID)] = response;
    await clickClose();
    await waitFor(() => !closeButton().disabled);
  }

  it('400 (すでに終了している): 一覧を読み直し、『すでに終了しています』を出す', async () => {
    await openChat();
    const sessionsBefore = requestCount(SESSIONS_KEY);
    handlers[closeKey(SESSION_ID)] = async () => json(400, { error: AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE });
    await clickClose();
    await waitFor(() => text().includes(AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE));

    expect(requestCount(SESSIONS_KEY)).toBe(sessionsBefore + 1);
    // 閉じていないので、新しい相談は作らない
    expect(requestCount(CREATE_SESSION_KEY)).toBe(0);
  });

  it.each([
    ['403 規約の同意が必要', 403, { error: LEGAL_CONSENT_REQUIRED_MESSAGE, code: LEGAL_CONSENT_REQUIRED_CODE }, LEGAL_CONSENT_REQUIRED_MESSAGE],
    ['503 AI 相談の緊急停止', 503, { error: 'x', code: AI_CHAT_DISABLED_CODE }, AI_CHAT_DISABLED_MESSAGE],
    ['503 メンテナンス中', 503, { error: 'x', code: MAINTENANCE_API_CODE }, MAINTENANCE_MESSAGE],
    ['500', 500, { error: 'internal' }, CONSULTATION_CLOSE_FAILED_MESSAGE],
    ['429 回数の上限', 429, { error: 'rate limited' }, CONSULTATION_CLOSE_FAILED_MESSAGE],
  ])('%s: 固定の文を出し、一覧は読み直さない', async (_label, status, body, expected) => {
    await openChat();
    const sessionsBefore = requestCount(SESSIONS_KEY);
    handlers[closeKey(SESSION_ID)] = async () => json(status, body);
    await clickClose();
    await waitFor(() => text().includes(expected));

    expect(requestCount(SESSIONS_KEY)).toBe(sessionsBefore);
    expect(requestCount(CREATE_SESSION_KEY)).toBe(0);
    // 会話は消さない
    expect(text()).toContain(MAIN_REPLY_TEXT);
  });

  it('通信の失敗 (fetch が投げる): 固定の失敗の文を出す', async () => {
    await closeWith(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(text()).toContain(CONSULTATION_CLOSE_FAILED_MESSAGE);
  });

  it('対照: 成功のときは失敗の文を出さない', async () => {
    await openChat();
    await clickClose();
    await waitFor(() => text().includes(WELCOME_TEXT));
    expect(text()).not.toContain(CONSULTATION_CLOSE_FAILED_MESSAGE);
    expect(text()).not.toContain(AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE);
  });
});

describe('#2245 K1 3 consultationCloseFailureOf の出し分け', () => {
  it.each<[string, number, unknown, ReturnType<typeof consultationCloseFailureOf>]>([
    ['400', 400, { error: AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE }, { kind: 'already-closed', message: AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE }],
    ['403 同意', 403, { code: LEGAL_CONSENT_REQUIRED_CODE }, { kind: 'failed', message: LEGAL_CONSENT_REQUIRED_MESSAGE }],
    ['403 同意でない', 403, { code: 'AUTH_ACCOUNT_FROZEN' }, { kind: 'failed', message: CONSULTATION_CLOSE_FAILED_MESSAGE }],
    ['403 本文なし', 403, null, { kind: 'failed', message: CONSULTATION_CLOSE_FAILED_MESSAGE }],
    ['503 緊急停止', 503, { code: AI_CHAT_DISABLED_CODE }, { kind: 'failed', message: AI_CHAT_DISABLED_MESSAGE }],
    ['503 code なし', 503, {}, { kind: 'failed', message: CONSULTATION_CLOSE_FAILED_MESSAGE }],
    ['404', 404, { error: 'not found' }, { kind: 'failed', message: CONSULTATION_CLOSE_FAILED_MESSAGE }],
  ])('%s', (_label, status, body, expected) => {
    expect(consultationCloseFailureOf(status, body)).toEqual(expected);
  });
});

/** JST の 2026-11-05 10:00 (UTC の 01:00) */
const JST_NOV_5_MORNING = new Date('2026-11-05T01:00:00.000Z');

/** 時刻 now にチャットを開いて「1日献立変更」を開き、日付の欄を返す */
async function openDayMenuAt(now: Date): Promise<HTMLInputElement> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  await openChat();
  await act(async () => {
    dayMenuButton().click();
  });
  const input = container.querySelector<HTMLInputElement>('input[type="date"]');
  expect(input).not.toBeNull();
  return input!;
}

/** 日付の欄の値を変える (利用者が欄を消した・選び直したとき) */
async function setDateField(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('#2245 K1 4 1 日分の献立は、日付が実在する暦日で欄の範囲の中のときだけ作る', () => {
  it('日付の欄を空にすると「作成する」が止まり、押しても NaN の一文を出さず、依頼もしない', async () => {
    const input = await openDayMenuAt(JST_NOV_5_MORNING);
    await setDateField(input, '');
    expect(input.value).toBe('');

    expect(createDayMenuButton().disabled).toBe(true);
    await act(async () => {
      createDayMenuButton().click();
    });
    await settle();

    expect(text()).not.toContain('NaN');
    expect(text()).not.toContain(DAY_MENU_STARTED_TEXT);
    expect(v4.generate).not.toHaveBeenCalled();
  });

  it.each([
    ['下限 (今日) の前の日', '2026-11-04'],
    ['上限 (14 日後) の次の日', '2026-11-20'],
  ])('%s (%s) は「作成する」が止まり、依頼しない', async (_label, value) => {
    const input = await openDayMenuAt(JST_NOV_5_MORNING);
    await setDateField(input, value);
    expect(input.value).toBe(value);

    expect(createDayMenuButton().disabled).toBe(true);
    await act(async () => {
      createDayMenuButton().click();
    });
    await settle();
    expect(v4.generate).not.toHaveBeenCalled();
  });

  it.each([
    ['下限 (今日)', '2026-11-05', '11月5日'],
    ['上限 (14 日後)', '2026-11-19', '11月19日'],
  ])('対照: %s (%s) は作れる', async (_label, value, monthDay) => {
    const input = await openDayMenuAt(JST_NOV_5_MORNING);
    await setDateField(input, value);

    expect(createDayMenuButton().disabled).toBe(false);
    await act(async () => {
      createDayMenuButton().click();
    });
    await waitFor(() => v4.generate.mock.calls.length === 1);
    expect(text()).toContain(`🍳 ${monthDay}${DAY_MENU_STARTED_TEXT}`);
    const [request] = v4.generate.mock.calls[0] as [{ targetSlots: Array<{ date: string }> }];
    expect(request.targetSlots.map((slot) => slot.date)).toEqual([value, value, value]);
  });
});
