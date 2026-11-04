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
 *   - 記録が実行中の印 (approved) のままなら『前の依頼の結果をまだ確かめられません…』(#2206 G2。以前は『前の依頼は実行中か
 *     実行済みです』) を足し、少し待って 1 回だけ読み直す。
 *     実行できていれば一文を置き換えて通知を投げる。まだ実行中の印なら一文はそのまま (通知しない)
 *   - 実行できたと分かった返答 (最初の読み取り・読み直しのどちらでも) は、GET が返した提案のカード (実行中の印の
 *     『確かめられませんでした』) を外す (開き直したときの GET と同じ。一文とカードが食い違わない)
 *   - 届いていない: 頼み直してもらう文を出し、送った文を入力欄に戻す / 返答がまだ無い: 開き直してもらう文
 *   - 取り直せない時間切れ: 頼み直しの前に開き直してもらう文 (「再度お試しください」だけを出さない)
 *   - 流れてきた本文があっても、返答がまだ無い・取り直せないときに本文だけを出さない (切れたことが分からない)。
 *     #2206 G2 で、時間切れでないとき (流れが途中で切れた) も残さないようにした (以前は #126 の決めで残していた)
 *   - 受け付けられなかった送信 (2xx でない応答) は、これまでどおり失敗の文だけ (取り直さない)
 */
import { act, createElement, type ReactElement } from 'react';
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
const { useAiConsultationDataRefetch } = await import('@/hooks/useAiConsultationDataRefetch');
const { AI_CONSULTATION_CHAT_ROOT_PROPS } = await import('@/lib/ai/consultation-data-refetch');
const { AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS, aiConsultationGenerationStatusUrl } = await import(
  '@/lib/ai/consultation-generation-watch'
);

const SESSION_ID = 'session-1';
const MESSAGES_KEY = `GET /api/ai/consultation/sessions/${SESSION_ID}/messages`;
const SEND_KEY = `POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`;
/** 手で書いた期待値 (定数の文が変わったらこのテストも直す) */
const EXECUTED_NOTE = '前の依頼は実行されました';
const RUNNING_NOTE = '前の依頼の結果をまだ確かめられません。しばらくしてから相談を開き直してください。';
/** 実行を待つ・失敗した行の一文 (#2206 G2) */
const NOT_EXECUTED_NOTE = '前の依頼は実行できませんでした';
/** 応答を受ける前に時間切れになり、送った文が無かったとき (#2206 G2。『届いていません』と言い切らない) */
const DELIVERY_UNCONFIRMED_TEXT =
  '相談がサーバーに届いたかを確かめられませんでした。少し待ってから相談を開き直し、送った文が無ければ、入力欄の文をもう一度送ってください。';
/** 時間切れでないのに途中で切れ、会話も取り直せなかったとき (#2206 G2) */
const INTERRUPTED_RELOAD_FAILED_TEXT =
  '応答を最後まで受け取れませんでした。返答はサーバーで続いていることがあります。少し待ってから相談を開き直し、返答が無ければもう一度送ってください。';
const NOT_DELIVERED_TEXT = '相談はサーバーに届いていませんでした。もう一度送ってください。';
const DELIVERED_NO_REPLY_TEXT = '相談はサーバーに届いています。返答を作っているところかもしれません。少し待ってから相談を開き直してください。';
const TIMEOUT_RELOAD_FAILED_TEXT =
  '応答に時間がかかっています。返答はサーバーで続いていることがあります。少し待ってから相談を開き直し、返答が無ければもう一度送ってください。';
const REPLY_FAILED_TEXT = '応答に失敗しました。再試行してください。';
/** 提案の記録が実行中の印のままの返答のカードの案内 (GET の unconfirmed) */
const UNCONFIRMED_GUIDE = 'この提案を実行できたかを確かめられませんでした。しばらくしてから相談を開き直してください。';
const NOT_EXECUTABLE_CARD = '[data-testid="ai-proposed-action-not-executable"]';
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
/**
 * 返答の提案の記録が実行中の印 (approved) のときに GET が返す形 (messages/route.ts: カードは出し、「実行する」は出さず、
 * 理由は unconfirmed。lifecycle の proposedActionViewOf(['approved']) が unconfirmed)
 */
const RUNNING_CARD_FIELDS = {
  proposedActions: { type: 'generate_single_meal', params: { date: '2026-11-02', mealType: 'dinner' } },
  proposedActionExecutable: false,
  proposedActionNotExecutableReason: 'unconfirmed',
};
function savedMessagesWithRunningCard(sent: string) {
  return savedMessages(sent).map((m) => (m.id === REPLY_ID ? { ...m, ...RUNNING_CARD_FIELDS } : m));
}

/** 提案のカードの「実行する」を出さない案内が出ているか */
function notExecutableCardShown(): boolean {
  return container.querySelector(NOT_EXECUTABLE_CARD) !== null;
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
  // holdRecheck で偽にした setTimeout を戻す (外したあとに戻すので、外すときの取り消しも偽のタイマーに効く)
  vi.useRealTimers();
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

async function openChat(element: ReactElement = createElement(AIChatBubble)) {
  await act(async () => {
    root.render(element);
  });
  const fab = container.querySelector('[data-testid="ai-chat-floating-button"]');
  expect(fab).not.toBeNull();
  await act(async () => {
    fab!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    fab!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0 }));
  });
  await waitFor(() => text().includes('野菜を足しましょう'));
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
 * 部品の setTimeout の予約 (読み直しの予約など) を偽のタイマーにして、releaseRecheck で進めるまで動かさない。
 * 『結果をまだ確かめられません』の一文 (#2206 G2。以前は『実行中か実行済み』) は、読み直しで実行できていれば置き換わって消える途中の表示なので、実時間の読み直し
 * (TEST_RECHECK_DELAY_MS) と競って見に行くと、CI の混雑で 1 回の描画が止まっただけで、見る前に消えて待ちが切れる
 * (2026-11-03 の main の CI run 41659836380 で 2 件。描画のあとに 50ms 止める実験で、この型の 3 件が毎回赤になった)。
 * 送る前に呼ぶ。文が出るまでの待ち (waitFor) は実時間のまま進む
 */
function holdRecheck() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true });
}

/** holdRecheck で止めた読み直しの予約を動かす (読み直しの待ち TEST_RECHECK_DELAY_MS だけ偽の時刻を進める) */
async function releaseRecheck() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(TEST_RECHECK_DELAY_MS);
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

/**
 * 本文の断片を流したあと、次の読み取りで時間切れ (AbortError) になる応答。サーバーは messages まで保存していた
 * (本物では、送信の待ちの上限 AI_CHAT_SEND_TIMEOUT_MS が流れの途中で切れる)
 */
function streamsThenTimesOut(messages: unknown[], partial: string): FetchHandler {
  return async () => {
    serverMessages = messages;
    const chunk = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: partial } }] })}\n\n`);
    let streamed = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!streamed) {
          streamed = true;
          controller.enqueue(chunk);
          return;
        }
        controller.error(abortError());
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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

  it('記録が実行中の印のままなら『結果をまだ確かめられません』を出し、読み直して実行できていれば一文を置き換えてカードを外し、通知を投げる', async () => {
    logs.results = [
      { data: [{ status: 'approved', action_type: 'generate_single_meal' }], error: null },
      { data: [{ status: 'executed', action_type: 'generate_single_meal' }], error: null },
    ];
    await openChat();
    holdRecheck();
    await sendFromInput(timesOutAfterSaving(savedMessagesWithRunningCard(SENT_TEXT)));

    await waitFor(() => text().includes(RUNNING_NOTE));
    // 実行中の印の間は、GET のとおりのカード (確かめられませんでした) を出す
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    expect(notExecutableCardShown()).toBe(true);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
    await releaseRecheck();
    await waitFor(() => text().includes(EXECUTED_NOTE));
    expect(text()).not.toContain(RUNNING_NOTE);
    // 実行できたと分かったら、カードを外す (開き直したときの GET と同じ。一文とカードが食い違わない)
    expect(text()).not.toContain(UNCONFIRMED_GUIDE);
    expect(notExecutableCardShown()).toBe(false);
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
    await sendFromInput(timesOutAfterSaving(savedMessagesWithRunningCard(SENT_TEXT)));

    await waitFor(() => text().includes(RUNNING_NOTE));
    await waitFor(() => logs.reads.length === 2);
    await waitPastRecheck();
    expect(text()).toContain(RUNNING_NOTE);
    expect(text()).not.toContain(EXECUTED_NOTE);
    // 実行できたと分からないので、カード (確かめられませんでした) もそのまま
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
    expect(logs.reads).toHaveLength(2);
  });

  it('GET を読んだときは実行中の印 (カードあり) でも、記録を読んだら実行できていれば、カードを出さずに一文を出す', async () => {
    logs.results = [{ data: [{ status: 'executed', action_type: 'generate_single_meal' }], error: null }];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessagesWithRunningCard(SENT_TEXT)));

    await waitFor(() => text().includes(EXECUTED_NOTE));
    expectNoteRightAfterReply(EXECUTED_NOTE);
    expect(text()).not.toContain(UNCONFIRMED_GUIDE);
    expect(notExecutableCardShown()).toBe(false);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
    await waitPastRecheck();
    expect(logs.reads).toHaveLength(1);
  });

  it('記録を読めないときは、カード (確かめられませんでした) と『結果をまだ確かめられません』を出す (#2206 G2。提案があるので実行中の印と同じ)', async () => {
    logs.results = [{ data: null, error: { message: 'permission denied' } }];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessagesWithRunningCard(SENT_TEXT)));

    await waitFor(() => text().includes(SAVED_REPLY));
    await waitFor(() => notExecutableCardShown());
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    expect(text()).not.toContain(EXECUTED_NOTE);
    expectNoteRightAfterReply(RUNNING_NOTE);
  });

  it.each([
    // 行が無い (提案が無い返答) は読み直さない。読めないときは、提案が無くても (GET は実行できた提案のカードを出さない)
    // 実行できたかが分からないので、一文を出さずに 1 回だけ読み直す (#2206 G2)
    ['行が無い (提案が無い返答)', { data: [], error: null }, 1],
    ['読み取りが失敗を返した', { data: null, error: { message: 'permission denied' } }, 2],
    ['読み取りが例外を投げた', new Error('Failed to fetch'), 2],
  ] as const)('%s なら、保存された返答だけを出し、一文も通知も出さない', async (_label, result, reads) => {
    logs.results = [result];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages(SENT_TEXT)));

    await waitFor(() => text().includes(SAVED_REPLY));
    expectReadLogsOfReply();
    await waitFor(() => logs.reads.length === reads);
    await waitPastRecheck();
    expect(text()).not.toContain(EXECUTED_NOTE);
    expect(text()).not.toContain(RUNNING_NOTE);
    expect(text()).not.toContain(NOT_EXECUTED_NOTE);
    expect(text()).not.toContain(OLD_TIMEOUT_TEXT);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
    expect(logs.reads).toHaveLength(reads);
  });

  it('実行を待っている・失敗した行だけなら、返答のすぐ後に『実行できませんでした』を出し、通知しない (#2206 G2)', async () => {
    logs.results = [{ data: [{ status: 'pending' }, { status: 'failed' }], error: null }];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages(SENT_TEXT)));

    await waitFor(() => text().includes(NOT_EXECUTED_NOTE));
    expectNoteRightAfterReply(NOT_EXECUTED_NOTE);
    await waitPastRecheck();
    expect(text()).not.toContain(EXECUTED_NOTE);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
    expect(logs.reads).toHaveLength(1);
  });

  it('応答を受ける前に時間切れになり送った文が無ければ、届いたかを確かめられない文を出し、送った文を入力欄に戻す (記録は読まない。#2206 G2)', async () => {
    await openChat();
    await sendFromInput(timesOutAfterSaving(OLD_MESSAGES));

    await waitFor(() => text().includes(DELIVERY_UNCONFIRMED_TEXT));
    // 送った文の保存が時間切れより後になりうるので『届いていません』とは言い切らない
    expect(text()).not.toContain(NOT_DELIVERED_TEXT);
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

  it('本文の断片が流れてから時間切れになり、返答がまだ保存されていなければ、断片ではなく開き直してもらう文を出す', async () => {
    const partial = '鶏むね肉の照り焼きで';
    await openChat();
    await sendFromInput(streamsThenTimesOut(savedMessages(SENT_TEXT).slice(0, OLD_MESSAGES.length + 1), partial));

    await waitFor(() => text().includes(DELIVERED_NO_REPLY_TEXT));
    expect(text()).not.toContain(partial);
    expect(inputElement().value).toBe('');
    expect(logs.reads).toHaveLength(0);
  });

  it('本文の断片が流れてから時間切れになり、会話も取り直せなければ、断片ではなく頼み直しの前に開き直してもらう文を出す', async () => {
    const partial = '鶏むね肉の照り焼きで';
    await openChat();
    handlers[MESSAGES_KEY] = async () => json(500, { error: 'サーバーでエラーが発生しました' });
    await sendFromInput(streamsThenTimesOut(savedMessages(SENT_TEXT), partial));

    await waitFor(() => text().includes(TIMEOUT_RELOAD_FAILED_TEXT));
    expect(text()).not.toContain(partial);
    expect(text()).not.toContain(OLD_TIMEOUT_TEXT);
  });

  it('本文の断片が流れてから時間切れになっても、返答が保存されていれば保存された返答と一文を出す', async () => {
    logs.results = [{ data: [{ status: 'executed' }], error: null }];
    await openChat();
    await sendFromInput(streamsThenTimesOut(savedMessages(SENT_TEXT), '鶏むね肉の'));

    await waitFor(() => text().includes(EXECUTED_NOTE));
    expectNoteRightAfterReply(EXECUTED_NOTE);
    expect(occurrences(SAVED_REPLY)).toBe(1);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
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

    await waitFor(() => text().includes(DELIVERY_UNCONFIRMED_TEXT));
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

  it('finalData が無く、返答もまだ保存されていない: 流れてきた本文ではなく、開き直してもらう文を出す (#2206 G2)', async () => {
    const partial = '鶏むね肉の照り焼きで';
    await openChat();
    await sendFromInput(streamsWithoutFinalData(savedMessages(SENT_TEXT).slice(0, OLD_MESSAGES.length + 1), partial));

    await waitFor(() => messagesGets === 2);
    await waitFor(() => text().includes(DELIVERED_NO_REPLY_TEXT));
    expect(text()).not.toContain(partial);
    expect(text()).not.toContain(REPLY_FAILED_TEXT);
    expect(logs.reads).toHaveLength(0);
  });

  it('finalData が無く、会話も取り直せない: 流れてきた本文ではなく、頼み直しの前に開き直してもらう文を出す (#2206 G2。#126 の決めを変えた)', async () => {
    const partial = '鶏むね肉の照り焼きで';
    await openChat();
    handlers[MESSAGES_KEY] = async () => json(500, { error: 'サーバーでエラーが発生しました' });
    await sendFromInput(streamsWithoutFinalData(savedMessages(SENT_TEXT), partial));

    await waitFor(() => text().includes(INTERRUPTED_RELOAD_FAILED_TEXT));
    expect(text()).not.toContain(partial);
    expect(text()).not.toContain(REPLY_FAILED_TEXT);
    expect(text()).not.toContain(TIMEOUT_RELOAD_FAILED_TEXT);
    // 送った文を入力欄に戻す (返答が無ければもう一度送れる。#2206 G2)
    expect(inputElement().value).toBe(SENT_TEXT);
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
  function savedQuickWithRunningCard() {
    return savedQuick().map((m) => (m.id === REPLY_ID ? { ...m, ...RUNNING_CARD_FIELDS } : m));
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

  it('時間切れで実行中の印のまま: 『結果をまだ確かめられません』を出し、読み直して実行できていれば置き換えてカードを外す', async () => {
    logs.results = [{ data: [{ status: 'approved' }], error: null }, { data: [{ status: 'executed' }], error: null }];
    await openEmptyChat();
    holdRecheck();
    await pressQuickPrompt(timesOutAfterSaving(savedQuickWithRunningCard()));

    await waitFor(() => text().includes(RUNNING_NOTE));
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    await releaseRecheck();
    await waitFor(() => text().includes(EXECUTED_NOTE));
    expect(text()).not.toContain(RUNNING_NOTE);
    expect(text()).not.toContain(UNCONFIRMED_GUIDE);
    expect(notExecutableCardShown()).toBe(false);
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
  });

  it('時間切れで、GET は実行中の印のカードでも記録が実行できていれば、カードを出さずに一文を出す', async () => {
    logs.results = [{ data: [{ status: 'executed' }], error: null }];
    await openEmptyChat();
    await pressQuickPrompt(timesOutAfterSaving(savedQuickWithRunningCard()));

    await waitFor(() => text().includes(EXECUTED_NOTE));
    expect(text()).not.toContain(UNCONFIRMED_GUIDE);
    expect(notExecutableCardShown()).toBe(false);
  });

  it('本文の断片が流れてから時間切れになり、返答がまだ保存されていなければ、断片ではなく開き直してもらう文を出す', async () => {
    const partial = '鶏むね肉の照り焼きで';
    await openEmptyChat();
    await pressQuickPrompt(streamsThenTimesOut(savedQuick().slice(0, 1), partial));

    await waitFor(() => text().includes(DELIVERED_NO_REPLY_TEXT));
    expect(text()).not.toContain(partial);
  });

  it('本文の断片が流れてから時間切れになり、会話も取り直せなければ、断片ではなく頼み直しの前に開き直してもらう文を出す', async () => {
    const partial = '鶏むね肉の照り焼きで';
    await openEmptyChat();
    handlers[MESSAGES_KEY] = async () => json(500, { error: 'サーバーでエラーが発生しました' });
    await pressQuickPrompt(streamsThenTimesOut(savedQuick(), partial));

    await waitFor(() => text().includes(TIMEOUT_RELOAD_FAILED_TEXT));
    expect(text()).not.toContain(partial);
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
    holdRecheck();
    await sendFromInput(timesOutAfterSaving(savedMessagesWithRunningCard(SENT_TEXT)));
    await waitFor(() => text().includes(RUNNING_NOTE));

    act(() => root.unmount());
    root = createRoot(container);
    // 外さなければ読み直す時刻を過ぎても (偽の時刻を進めても)、読み直さない
    await releaseRecheck();
    await waitPastRecheck();
    expect(logs.reads).toHaveLength(1);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
  });
});

/**
 * 献立の生成 3 種類の記録の行 (サーバーの messages の route が ai_action_logs.result に保存した、生成の受付の結果)。
 * Web の取り直し (useAiConsultationDataRefetch) は、通知の detail.result がこの形のときだけ生成の完了まで見張る (#2202)
 */
const GENERATION_REQUEST_ID = 'req-1';
const ACCEPTED_GENERATION_RESULT = { requestId: GENERATION_REQUEST_ID, status: 'processing' };
const EXECUTED_GENERATION_ROW = { status: 'executed', action_type: 'generate_single_meal', result: ACCEPTED_GENERATION_RESULT };
const RUNNING_GENERATION_ROW = { status: 'approved', action_type: 'generate_single_meal', result: null };
const GENERATION_STATUS_KEY = `GET ${aiConsultationGenerationStatusUrl(GENERATION_REQUEST_ID)}`;

/** 時間切れの経路の 2 つ: 最初の読み取りで実行できていた / 実行中の印のあと読み直しで実行できていた */
const GENERATION_PATHS = [
  ['最初の読み取り', [{ data: [EXECUTED_GENERATION_ROW], error: null }], () => savedMessages(SENT_TEXT)],
  [
    '読み直し',
    [
      { data: [RUNNING_GENERATION_ROW], error: null },
      { data: [EXECUTED_GENERATION_ROW], error: null },
    ],
    () => savedMessagesWithRunningCard(SENT_TEXT),
  ],
] as const;

describe('#2201 U3 時間切れの経路の通知にも、記録の行の実行の結果を載せる (献立の生成の完了まで見張れるように)', () => {
  it.each(GENERATION_PATHS)('%s: 通知の detail.result が記録の行の result (生成の受付) になる', async (_label, results, saved) => {
    logs.results = [...results];
    await openChat();
    await sendFromInput(timesOutAfterSaving(saved()));

    await waitFor(() => text().includes(EXECUTED_NOTE));
    for (const read of logs.reads) expect(read.columns.split(',').map((c) => c.trim())).toContain('result');
    expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
    const detail = (mealPlanUpdated.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ actionType: 'generate_single_meal', result: ACCEPTED_GENERATION_RESULT });
    expect(detail.result.requestId).toBe(GENERATION_REQUEST_ID);
  });

  it('記録の行に result が無い (生成でない提案) ときは result: null を載せる', async () => {
    logs.results = [{ data: [{ status: 'executed', action_type: 'update_meal' }], error: null }];
    await openChat();
    await sendFromInput(timesOutAfterSaving(savedMessages(SENT_TEXT)));

    await waitFor(() => text().includes(EXECUTED_NOTE));
    expect((mealPlanUpdated.mock.calls[0][0] as CustomEvent).detail).toEqual({ actionType: 'update_meal', result: null });
  });

  describe('Web の取り直し (useAiConsultationDataRefetch) と組み合わせる', () => {
    let refetch: ReturnType<typeof vi.fn>;
    let statusChecks: number;

    /** ページの取り直しの hook を使う部品 (献立表のページの代わり) */
    function RefetchingPage() {
      useAiConsultationDataRefetch(refetch);
      return null;
    }

    beforeEach(() => {
      // 生成の見張りの間隔 (setInterval) だけを手で進める (文が出るまでの待ちは本物の setTimeout のまま)
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      refetch = vi.fn();
      statusChecks = 0;
      handlers[GENERATION_STATUS_KEY] = async () => {
        statusChecks += 1;
        return json(200, { status: 'completed' });
      };
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each(GENERATION_PATHS)(
      '%s: 実行できたと分かったらすぐ 1 回取り直し、生成の状態の確認の URL を見て、終わったらもう一度取り直す',
      async (_label, results, saved) => {
        logs.results = [...results];
        // AI 相談の吹き出しは、本物と同じく吹き出しを包む印の中に置く (吹き出しの入力欄は取り直しを止めない)
        await openChat(
          createElement(
            'div',
            null,
            createElement('div', AI_CONSULTATION_CHAT_ROOT_PROPS, createElement(AIChatBubble)),
            createElement(RefetchingPage),
          ),
        );
        await sendFromInput(timesOutAfterSaving(saved()));

        await waitFor(() => text().includes(EXECUTED_NOTE));
        expect(mealPlanUpdated).toHaveBeenCalledTimes(1);
        expect(refetch).toHaveBeenCalledTimes(1);
        expect(statusChecks).toBe(0);

        await act(async () => {
          vi.advanceTimersByTime(AI_CONSULTATION_GENERATION_WATCH_INTERVAL_MS);
        });
        await waitFor(() => statusChecks === 1 && refetch.mock.calls.length === 2);
      },
    );
  });
});
