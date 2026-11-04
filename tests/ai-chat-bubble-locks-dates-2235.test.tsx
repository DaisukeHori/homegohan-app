/**
 * #2235 I8 Web の AI 相談 (src/components/AIChatBubble.tsx) の回帰テスト。
 *
 * 直す前 (相談を閉じる・送信の止め。モバイルの AIAdvisorSheet は #2235 I7 で同じ形に直した):
 *   1. 相談を閉じる (closeSession) の応答待ちの間も、送信 (入力欄・送信ボタン・クイック質問) を止めなかった。送った文は閉じる側の
 *      相談へ送られ、閉じたあとの新しい相談で、送った文と返答が今の画面から消えた
 *   2. 閉じる応答待ちの間も「新しい相談を始める」を止めなかった。閉じたあとの新しい相談と合わせて、相談が 2 つ作られた
 *   3. 閉じる応答待ちの間も相談の切り替えを止めなかった。選んだ相談が、閉じたあとの新しい相談で上書きされた
 *   4. 送信中も閉じるを止めなかった。送信の返答は閉じた相談にだけ保存され、閉じたあとの新しい相談の画面には出なかった
 *   5. 止めは state (isSending / isClosingSession) だけで、描画の前の同じ描画のうちの 2 度目の押下 (送信・閉じる) を止めなかった
 * 直す前 (日付):
 *   6. 1 日分の献立の既定の日 (明日) と日付の欄の上限 (+14 日) を、端末の 0 時の Date を setDate でずらしてから JST の日付にして
 *      いた。端末が JST より東 (Pacific/Kiritimati など) だと、端末の 0 時が JST の前の日なので、明日が今日になり、上限が 13 日後になった
 *   7. (#2235 I3) 1 日分の献立を作るときのチャットの文 (「○月○日の献立を作成中...」) と生成の依頼の note の月日を、選んだ暦日を
 *      new Date('YYYY-MM-DD') (UTC の 0 時の瞬間) にして端末のローカル時刻 (getMonth / getDate) で読んでいた。端末が UTC より西
 *      (America/Los_Angeles・Pacific/Pago_Pago) だと前の日になった (2026-11-06 を選んで「11月5日の献立を作成中...」)。
 *      同じ形の全域の表と見張りは tests/date-shift-inventory-2235.test.ts (DATE_PARSE_SITES・D-4〜D-6)
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollUntil, sleepRealTime } from './helpers/act-wait';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';
import { TEST_TIME_ZONES } from './helpers/time-zones';

// 文が出るまでの待ち (tests/helpers/act-wait.ts) は最大 10 秒まで伸びうるので、1 件のテストの時間切れを延ばす
// (根拠と環境変数での上書きは tests/helpers/heavy-unit-test-timeout.ts)。テストとフックを定義する前に置く
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
/** 同意の確認の答え (「同意しない」の縁を確かめるテストだけ差し替える。beforeEach で戻す) */
const consent = vi.hoisted(() => ({ answer: 'consented' as 'consented' | 'declined' }));
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: async () => consent.answer, consentModal: null }),
}));
/** 献立の生成の依頼 (1 日分の献立の note を確かめる。beforeEach で呼ばれた記録を消す) */
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
const sendKey = (sessionId: string) => `POST /api/ai/consultation/sessions/${sessionId}/messages?stream=true`;
const closeKey = (sessionId: string) => `POST /api/ai/consultation/sessions/${sessionId}/close`;

const OLD_MESSAGES = [
  { id: 'old-user', role: 'user', content: '夕飯の相談です', createdAt: '2026-11-01T00:00:00.000Z' },
  { id: 'old-ai', role: 'assistant', content: '野菜を足しましょう', createdAt: '2026-11-01T00:00:01.000Z' },
];
const OLD_REPLY_TEXT = '野菜を足しましょう';
/** 新しい相談のようこその一文の書き出し (部品の文が変わったらこのテストも直す) */
const WELCOME_TEXT = 'ほめゴハンのAIアドバイザーです';
/** ようこその一文だけのときに出るクイック質問の 1 つ目 */
const QUICK_PROMPT = '献立を提案してほしい';
const SENT_TEXT = '今夜の夕食を1食作って';
const REPLY_TEXT = '鶏むね肉の照り焼きはいかがですか';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 送信の応答 (返答を 1 回で流し、最後に保存した行 (finalData: userMessage と aiMessage) を送る) */
function replyResponse(sessionId: string): Response {
  const body =
    sse({ choices: [{ delta: { content: REPLY_TEXT } }] }) +
    sse({
      userMessage: { id: `user-saved-${sessionId}`, role: 'user', content: SENT_TEXT, createdAt: '2026-11-02T00:00:00.000Z' },
      aiMessage: { id: `ai-saved-${sessionId}`, role: 'assistant', content: REPLY_TEXT, createdAt: '2026-11-02T00:00:01.000Z' },
    });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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
let sessionList: Array<{ id: string; title: string; messageCount: number }>;
const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;
const originalTz = process.env.TZ;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.cookie = 'aiChatBubblePosition=; max-age=0; path=/';
  localStorage.clear();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('alert', vi.fn());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete window.__weeklyCurrentDate;
  consent.answer = 'consented';
  v4.generate.mockReset();
  requests = [];
  sessionList = [
    { id: SESSION_ID, title: MAIN_SESSION_TITLE, messageCount: 2 },
    { id: OTHER_SESSION_ID, title: OTHER_SESSION_TITLE, messageCount: 0 },
  ];
  handlers = {
    [SESSIONS_KEY]: async () => json(200, { sessions: sessionList }),
    [messagesKey(SESSION_ID)]: async () => json(200, { messages: OLD_MESSAGES }),
    [messagesKey(OTHER_SESSION_ID)]: async () => json(200, { messages: [] }),
    [CREATE_SESSION_KEY]: async () => json(200, { session: { id: NEW_SESSION_ID } }),
    [sendKey(SESSION_ID)]: async () => replyResponse(SESSION_ID),
    [sendKey(NEW_SESSION_ID)]: async () => replyResponse(NEW_SESSION_ID),
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
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
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
 * 押下のあとに何も起きないことを確かめるときに待つ実時間 (ミリ秒)。押下の続き (同意の確認はすぐ返る mock・fetch は mock) は
 * マイクロタスクで進むので、待ちの 1 回 (tests/helpers/act-wait.ts の ACT_WAIT_POLL_MS = 20) より少し長く取る
 */
const SETTLE_MS = 50;

/** 押下のあとの非同期の続き (同意の確認・fetch) が走りきるだけの実時間を待つ (何も起きないことを確かめるとき) */
async function settle() {
  await act(async () => {
    await sleepRealTime(SETTLE_MS);
  });
}

function requestCount(key: string): number {
  return requests.filter((r) => r === key).length;
}

/** チャットを開き、shownText (会話の文) が出るまで待つ */
async function openChat(shownText = OLD_REPLY_TEXT) {
  await act(async () => {
    root.render(createElement(AIChatBubble));
  });
  const fab = container.querySelector('[data-testid="ai-chat-floating-button"]');
  expect(fab).not.toBeNull();
  await act(async () => {
    fab!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    fab!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0 }));
  });
  await waitFor(() => text().includes(shownText));
}

/** 相談が 1 つも無い利用者: チャットを開くと新しい相談 (ようこその一文とクイック質問) になる */
async function openChatWithNewSession() {
  sessionList = [];
  await openChat(WELCOME_TEXT);
  expect(quickPromptButton()).not.toBeNull();
  // 開いたときの作成の分を数えから外す
  requests = [];
}

function inputElement(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  expect(input).not.toBeNull();
  return input!;
}

function sendButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="メッセージを送信"]');
  expect(button).not.toBeNull();
  return button!;
}

function closeButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[title="相談を終了して要約を保存"]');
  expect(button).not.toBeNull();
  return button!;
}

function buttonWithText(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent ?? '').includes(label));
}

function quickPromptButton(): HTMLButtonElement | undefined {
  return buttonWithText(QUICK_PROMPT);
}

function newSessionButton(): HTMLButtonElement {
  const button = buttonWithText('新しい相談を始める');
  expect(button).toBeDefined();
  return button!;
}

function sessionRow(title: string): HTMLButtonElement {
  const button = buttonWithText(title);
  expect(button).toBeDefined();
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

/** 入力欄で Enter を押す (入力欄の onKeyDown が送信の入口を呼ぶ。disabled でも keydown の処理は呼ばれる) */
async function pressEnter() {
  await act(async () => {
    inputElement().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

async function openSessionList() {
  const toggle = container.querySelector('svg.lucide-chevron-down')?.closest('button');
  expect(toggle).toBeTruthy();
  await act(async () => {
    toggle!.click();
  });
  newSessionButton();
}

/** 閉じる (/close) の応答を待たせる。返した deferred で応答を返す (resolve)・投げる (reject) */
function holdClose(sessionId = SESSION_ID): Deferred<Response> {
  const pending = deferred<Response>();
  handlers[closeKey(sessionId)] = () => pending.promise;
  return pending;
}

/** 送信の応答を待たせる */
function holdSend(sessionId = SESSION_ID): Deferred<Response> {
  const pending = deferred<Response>();
  handlers[sendKey(sessionId)] = () => pending.promise;
  return pending;
}

async function clickClose() {
  await act(async () => {
    closeButton().click();
  });
  await waitFor(() => requestCount(closeKey(SESSION_ID)) === 1);
}

/** 閉じる応答 (成功) を返し、閉じたあとの新しい相談が出るまで待つ */
async function finishCloseOk(pending: Deferred<Response>) {
  await act(async () => {
    pending.resolve(json(200, { summary: null }));
  });
  await waitFor(() => text().includes(WELCOME_TEXT));
}

describe('#2235 I8 相談を閉じる応答待ちの間は、送信を止める', () => {
  it('入力欄と送信ボタンを止める (描画)', async () => {
    await openChat();
    await typeText(SENT_TEXT);
    holdClose();
    await clickClose();

    expect(inputElement().disabled).toBe(true);
    expect(sendButton().disabled).toBe(true);
  });

  it('同じ描画のうちに閉じると送信を押しても、閉じる側の相談へ送らない (入口)', async () => {
    await openChat();
    await typeText(SENT_TEXT);
    holdClose();
    await act(async () => {
      closeButton().click();
      sendButton().click();
    });
    await settle();

    expect(requestCount(closeKey(SESSION_ID))).toBe(1);
    expect(requestCount(sendKey(SESSION_ID))).toBe(0);
  });

  it('閉じる応答待ちの間に入力欄で Enter を押しても送らない (入口)', async () => {
    await openChat();
    await typeText(SENT_TEXT);
    holdClose();
    await clickClose();
    await pressEnter();
    await settle();

    expect(requestCount(sendKey(SESSION_ID))).toBe(0);
  });

  it('クイック質問を止め (描画)、同じ描画のうちの押下も送らない (入口)', async () => {
    await openChatWithNewSession();
    const pending = deferred<Response>();
    handlers[closeKey(NEW_SESSION_ID)] = () => pending.promise;
    await act(async () => {
      closeButton().click();
      quickPromptButton()!.click();
    });
    await settle();

    expect(requestCount(closeKey(NEW_SESSION_ID))).toBe(1);
    expect(requestCount(sendKey(NEW_SESSION_ID))).toBe(0);
    expect(quickPromptButton()!.disabled).toBe(true);
  });
});

describe('#2235 I8 相談を閉じる応答待ちの間は、新しい相談を止める', () => {
  it('「新しい相談を始める」を止める (描画)', async () => {
    await openChat();
    await openSessionList();
    holdClose();
    await clickClose();

    expect(newSessionButton().disabled).toBe(true);
  });

  it('同じ描画のうちの押下でも作らず、閉じたあとの新しい相談 1 つだけになる (入口。閉じる側の作成は止めない)', async () => {
    await openChat();
    await openSessionList();
    const pending = holdClose();
    await act(async () => {
      closeButton().click();
      newSessionButton().click();
    });
    await settle();
    expect(requestCount(CREATE_SESSION_KEY)).toBe(0);

    await finishCloseOk(pending);
    expect(requestCount(CREATE_SESSION_KEY)).toBe(1);
  });
});

describe('#2235 I8 相談を閉じる応答待ちの間は、相談の切り替えを止める', () => {
  it('相談の行を止める (描画)', async () => {
    await openChat();
    await openSessionList();
    holdClose();
    await clickClose();

    expect(sessionRow(OTHER_SESSION_TITLE).disabled).toBe(true);
    expect(sessionRow(MAIN_SESSION_TITLE).disabled).toBe(true);
  });

  it('同じ描画のうちの押下でも切り替えない (入口)', async () => {
    await openChat();
    await openSessionList();
    const pending = holdClose();
    await act(async () => {
      closeButton().click();
      sessionRow(OTHER_SESSION_TITLE).click();
    });
    await settle();
    expect(requestCount(messagesKey(OTHER_SESSION_ID))).toBe(0);

    await finishCloseOk(pending);
    expect(requestCount(messagesKey(OTHER_SESSION_ID))).toBe(0);
  });
});

describe('#2235 I8 送信中は、相談を閉じるを止める', () => {
  it('閉じるボタンを止める (描画)', async () => {
    await openChat();
    await typeText(SENT_TEXT);
    holdSend();
    await act(async () => {
      sendButton().click();
    });
    await waitFor(() => requestCount(sendKey(SESSION_ID)) === 1);

    expect(closeButton().disabled).toBe(true);
  });

  it('同じ描画のうちに送ると閉じるを押しても、閉じない (入口)', async () => {
    await openChat();
    await typeText(SENT_TEXT);
    holdSend();
    holdClose();
    await act(async () => {
      sendButton().click();
      closeButton().click();
    });
    await settle();

    expect(requestCount(sendKey(SESSION_ID))).toBe(1);
    expect(requestCount(closeKey(SESSION_ID))).toBe(0);
  });
});

describe('#2235 I8 同じ描画のうちの 2 度目の押下', () => {
  it('送信を 2 度押しても 1 度だけ送る', async () => {
    await openChat();
    await typeText(SENT_TEXT);
    holdSend();
    await act(async () => {
      sendButton().click();
      sendButton().click();
    });
    await settle();

    expect(requestCount(sendKey(SESSION_ID))).toBe(1);
  });

  it('閉じるを 2 度押しても 1 度だけ閉じる', async () => {
    await openChat();
    holdClose();
    await act(async () => {
      closeButton().click();
      closeButton().click();
    });
    await settle();

    expect(requestCount(closeKey(SESSION_ID))).toBe(1);
  });
});

describe('#2235 I8 対照: 止めたまま残らない', () => {
  /** 送信・新しい相談・切り替えがまた使えること (止めが下りていること) を、描画と押下の両方で確かめる */
  async function expectUnlocked(sessionId: string) {
    expect(inputElement().disabled).toBe(false);
    expect(closeButton().disabled).toBe(false);
    await openSessionList();
    expect(newSessionButton().disabled).toBe(false);
    expect(sessionRow(OTHER_SESSION_TITLE).disabled).toBe(false);

    await typeText(SENT_TEXT);
    await act(async () => {
      sendButton().click();
    });
    await waitFor(() => text().includes(REPLY_TEXT));
    expect(requestCount(sendKey(sessionId))).toBe(1);
  }

  it('閉じる応答が成功したら、閉じたあとの新しい相談でまた使える', async () => {
    await openChat();
    const pending = holdClose();
    await clickClose();
    await finishCloseOk(pending);

    await expectUnlocked(NEW_SESSION_ID);
  });

  it('閉じる応答が失敗 (500) でも、今の相談でまた使える', async () => {
    await openChat();
    const pending = holdClose();
    await clickClose();
    await act(async () => {
      pending.resolve(json(500, { error: 'failed' }));
    });
    await waitFor(() => !inputElement().disabled);

    await expectUnlocked(SESSION_ID);
  });

  it('閉じるの fetch が投げても、今の相談でまた使える', async () => {
    await openChat();
    const pending = holdClose();
    await clickClose();
    await act(async () => {
      pending.reject(new TypeError('Failed to fetch'));
    });
    await waitFor(() => !inputElement().disabled);

    await expectUnlocked(SESSION_ID);
  });

  it('送信が終わったら、閉じるをまた押せる', async () => {
    await openChat();
    await typeText(SENT_TEXT);
    await act(async () => {
      sendButton().click();
    });
    await waitFor(() => text().includes(REPLY_TEXT));
    expect(closeButton().disabled).toBe(false);

    const pending = holdClose();
    await clickClose();
    await finishCloseOk(pending);
  });

  it('「同意しない」で送らなかったあとも、また送れる', async () => {
    await openChat();
    consent.answer = 'declined';
    await typeText(SENT_TEXT);
    await act(async () => {
      sendButton().click();
    });
    await settle();
    expect(requestCount(sendKey(SESSION_ID))).toBe(0);

    consent.answer = 'consented';
    await waitFor(() => inputElement().value === SENT_TEXT && !sendButton().disabled);
    await act(async () => {
      sendButton().click();
    });
    await waitFor(() => text().includes(REPLY_TEXT));
    expect(requestCount(sendKey(SESSION_ID))).toBe(1);
  });
});

/** JST の 2026-11-05 10:00 (UTC の 01:00) */
const JST_NOV_5_MORNING = new Date('2026-11-05T01:00:00.000Z');
/** JST の 2026-12-31 23:30 (UTC の 14:30。年をまたぐ) */
const JST_DEC_31_NIGHT = new Date('2026-12-31T14:30:00.000Z');
/** JST の 9999-12-31 12:00 (暦の計算で扱える最後の日。翌日・14 日後は addDaysToDate が RangeError) */
const JST_LAST_REPRESENTABLE_DAY = new Date('9999-12-31T03:00:00.000Z');

/** tz の端末で、時刻 now にチャットを開いて「1日献立変更」を開き、日付の欄 (既定の日・下限・上限) を返す */
async function openDayMenuAt(tz: string, now: Date) {
  process.env.TZ = tz;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  await openChat();
  const open = buttonWithText('1日献立変更');
  expect(open).toBeDefined();
  await act(async () => {
    open!.click();
  });
  const input = container.querySelector<HTMLInputElement>('input[type="date"]');
  expect(input).not.toBeNull();
  return { value: input!.value, min: input!.getAttribute('min'), max: input!.getAttribute('max') };
}

describe('#2235 I8 1 日分の献立の日付 (明日・上限 +14 日) は、端末のタイムゾーンによらず JST の暦で求める', () => {
  it.each(TEST_TIME_ZONES)('%s の端末: 既定の日は JST の明日・上限は JST の今日の 14 日後', async (tz) => {
    const field = await openDayMenuAt(tz, JST_NOV_5_MORNING);
    expect(field).toEqual({ value: '2026-11-06', min: '2026-11-05', max: '2026-11-19' });
  });

  it('JST の大みそかは、明日も上限も年をまたぐ (Pacific/Kiritimati の端末)', async () => {
    const field = await openDayMenuAt('Pacific/Kiritimati', JST_DEC_31_NIGHT);
    expect(field).toEqual({ value: '2027-01-01', min: '2026-12-31', max: '2027-01-14' });
  });

  it('翌日を暦の計算で扱えない日でも、描画中に投げない (既定の日は今日・上限は付けない)', async () => {
    const field = await openDayMenuAt('UTC', JST_LAST_REPRESENTABLE_DAY);
    expect(field).toEqual({ value: '9999-12-31', min: '9999-12-31', max: null });
  });
});

/** JST の 2026-11-30 10:00 (UTC の 01:00。既定の日 (明日) が月をまたぐ) */
const JST_NOV_30_MORNING = new Date('2026-11-30T01:00:00.000Z');

/** 「1日献立変更」の「作成する」を押し、チャットに作成中の文が出るまで待って、生成の依頼の note を返す */
async function createDayMenu(): Promise<string | undefined> {
  const create = buttonWithText('作成する');
  expect(create).toBeDefined();
  await act(async () => {
    create!.click();
  });
  await waitFor(() => text().includes('の献立を作成中...'));
  await waitFor(() => v4.generate.mock.calls.length === 1);
  const [request] = v4.generate.mock.calls[0] as [{ note?: string }];
  return request.note;
}

describe('#2235 I3 1 日分の献立を作るときのチャットの文と依頼の note は、選んだ暦日の月日のまま (端末のタイムゾーンによらない)', () => {
  it.each(TEST_TIME_ZONES)('%s の端末: JST の明日 (2026-11-06) を作ると「11月6日」', async (tz) => {
    const field = await openDayMenuAt(tz, JST_NOV_5_MORNING);
    expect(field.value).toBe('2026-11-06');
    const note = await createDayMenu();
    expect(text()).toContain('🍳 11月6日の献立を作成中...');
    expect(text()).not.toContain('11月5日の献立を作成中');
    expect(note).toBe('11月6日の献立を作成');
  });

  it('月をまたぐ明日 (2026-12-01) は「12月1日」(America/Los_Angeles の端末。直す前は前の日の「11月30日」)', async () => {
    const field = await openDayMenuAt('America/Los_Angeles', JST_NOV_30_MORNING);
    expect(field.value).toBe('2026-12-01');
    const note = await createDayMenu();
    expect(text()).toContain('🍳 12月1日の献立を作成中...');
    expect(note).toBe('12月1日の献立を作成');
  });

  it('年をまたぐ明日 (2027-01-01) は「1月1日」(Pacific/Pago_Pago の端末。直す前は前の日の「12月31日」)', async () => {
    const field = await openDayMenuAt('Pacific/Pago_Pago', JST_DEC_31_NIGHT);
    expect(field.value).toBe('2027-01-01');
    const note = await createDayMenu();
    expect(text()).toContain('🍳 1月1日の献立を作成中...');
    expect(note).toBe('1月1日の献立を作成');
  });
});
