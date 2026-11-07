/**
 * #2295 AI 相談 (Web) の提案のカードの「断る」(rejectAction。src/components/AIChatBubble.tsx) が応答の status を見る
 *
 * 問題 (修正前): DELETE /api/ai/consultation/actions/[actionId]/execute の応答の status を見ずに、いつもカードを閉じた。
 *   - 500 (DB の失敗): 断れていないのにカードが消え、開き直すと pending のカードがまた出た
 *   - 404 (断れる pending の行が無い: 別の画面で断った・別の画面や自動実行が先に実行を始めた・実行済み・間に pending に戻った など):
 *     何が起きたのかが伝わらなかった (#2296 では 404 をいつも「実行中か実行済み」としていたが、断ったあとの行も 404 になる)
 *   - 断るの応答待ちの間も「断る」「実行する」を押せた
 *   - 「実行する」の応答待ちの間も「断る」を押せた (integrity-1107d)。行が approved なので DELETE が 404 + unconfirmed を返し、
 *     実行中のカードに『確かめられませんでした』が出た。そのあと実行がやり直せる失敗で終わる (行が pending に戻る) と、
 *     「実行する」が出ないまま残った (開き直すと GET は「実行する」のカードを出す)
 *
 * 直したあと:
 *   - 2xx: カードを閉じる
 *   - 404: 本文に添えられたカードの見え方 (相談を開き直したときの GET と同じ) で分ける (integrity-1107c の是正):
 *       proposedActionHidden: true (断った・実行済み) はカードを閉じる / notExecutableReason は「実行する」を出さずに理由の案内
 *       (既存の文) / 何も添えられていない・本文が JSON でない はカードを残し、固定の失敗の文を 1 つ足す。
 *       以前は 404 をいつも「この提案は実行中か実行済みです。」にしていたので、2 つのタブで同じ相談を開いてタブ A で断ったあと、
 *       タブ B で断ると (行は rejected で 404)、実行していないのに「実行中か実行済み」と出ていた
 *   - それ以外 (500・401・通信の失敗): カードを残し (「実行する」「断る」は押せるまま)、固定の失敗の文を会話に 1 つ足す
 *     (応答の本文 error の文面は出さない)
 *   - 断るの応答待ちの間は、そのカードの「実行する」「断る」を止める
 *   - 「実行する」の応答待ちの間・相談を閉じる途中・終了した相談では、「断る」も「実行する」と同じく止める (ボタンの disabled と
 *     rejectAction の入口の両方。integrity-1107d)。実行がやり直せる失敗で終わったら、どちらも押せるように戻る
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
const { AI_PROPOSED_ACTION_REJECT_FAILED_MESSAGE } = await import('@/lib/ai/consultation-action-lifecycle');
const { CONSULTATION_SESSION_CLOSED_STATUS, consultationSessionClosedBody } = await import('@/lib/ai/consultation-session-closed');

const SESSION_ID = 'session-1';
const MESSAGE_ID = 'message-1';
const EXECUTE_BUTTON_TEXT = '実行する';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
  vi.restoreAllMocks();
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

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
}

/** 手で書いた期待値 (定数の文が変わったらこのテストも直す) */
const REJECT_FAILED_TEXT = '提案を断れませんでした。時間をおいてもう一度お試しください。';
const RUNNING_OR_DONE_GUIDE_TEXT = 'この提案は実行中か実行済みです。';
const UNCONFIRMED_GUIDE_TEXT = 'この提案を実行できたかを確かめられませんでした。しばらくしてから相談を開き直してください。';
const NOT_EXECUTABLE_GUIDE_TEXT = 'この提案はここからは実行できません。もう一度 AI に頼んでください。';
/** 断る API の 404 の本文の error (AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE と同じ扱い。画面には出さない) */
const NOT_FOUND_ERROR = 'not found error text 2295';
/** 提案の見出し (ACTION_LABELS の add_pantry_item の名前。手で書いた期待値) */
const PANTRY_LABEL = '冷蔵庫に追加';
/** 画面に出してはいけない応答の本文の文面 */
const RAW_SERVER_ERROR = 'raw server error text 2295';
const DELETE_KEY = `DELETE /api/ai/consultation/actions/${MESSAGE_ID}/execute`;
const EXECUTE_KEY = `POST /api/ai/consultation/actions/${MESSAGE_ID}/execute`;

function rejectButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label="提案を断る"]');
}

function guideShown(): boolean {
  return container.querySelector('[data-testid="ai-proposed-action-not-executable"]') !== null;
}

/** 提案のカードが出ているか (見出し・ボタン・案内のどれかがある) */
function cardShown(): boolean {
  return text().includes(PANTRY_LABEL) || rejectButton() !== null || buttonByText(EXECUTE_BUTTON_TEXT) !== undefined || guideShown();
}

/** 失敗の文が会話に出ている数 */
function rejectFailedCount(): number {
  return text().split(REJECT_FAILED_TEXT).length - 1;
}

function deleteCalls(): number {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'DELETE').length;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('#2295 「断る」の応答で画面を分ける', () => {
  it('失敗の文は手で書いた期待値と同じ', () => {
    expect(AI_PROPOSED_ACTION_REJECT_FAILED_MESSAGE).toBe(REJECT_FAILED_TEXT);
  });

  it.each([200, 204])('%i: カードを閉じる (失敗の文・案内は出さない)', async (status) => {
    handlers[DELETE_KEY] = async () => (status === 204 ? new Response(null, { status }) : json(status, { success: true }));
    await openChat();
    expect(text()).toContain(PANTRY_LABEL);
    await click(rejectButton()!);
    await pollUntil(() => !cardShown());
    expect(cardShown()).toBe(false);
    expect(rejectFailedCount()).toBe(0);
    expect(deleteCalls()).toBe(1);
  });

  it('2 つのタブの再現: タブ A で断ったあと、タブ B で断る (行は rejected で 404・proposedActionHidden): カードを閉じる。「実行中か実行済み」と出さない', async () => {
    handlers[DELETE_KEY] = async () => json(404, { error: NOT_FOUND_ERROR, proposedActionHidden: true });
    await openChat();
    expect(text()).toContain(PANTRY_LABEL);
    await click(rejectButton()!);
    await pollUntil(() => !cardShown());
    expect(cardShown()).toBe(false);
    expect(text()).not.toContain(RUNNING_OR_DONE_GUIDE_TEXT);
    expect(rejectFailedCount()).toBe(0);
    expect(text()).not.toContain(NOT_FOUND_ERROR);
    expect(deleteCalls()).toBe(1);
  });

  it.each([
    ['unconfirmed (実行中の印のまま)', 'unconfirmed', UNCONFIRMED_GUIDE_TEXT],
    ['failed (失敗・行が無い)', 'failed', NOT_EXECUTABLE_GUIDE_TEXT],
    ['runningOrDone', 'runningOrDone', RUNNING_OR_DONE_GUIDE_TEXT],
  ])('404 で notExecutableReason が %s: カードは閉じず理由の案内にする (「実行する」「断る」は出さない・失敗の文と本文は出さない)', async (_label, reason, guide) => {
    handlers[DELETE_KEY] = async () => json(404, { error: NOT_FOUND_ERROR, notExecutableReason: reason });
    await openChat();
    await click(rejectButton()!);
    await pollUntil(() => guideShown());
    expect(guideShown()).toBe(true);
    expect(text()).toContain(PANTRY_LABEL);
    expect(text()).toContain(guide);
    for (const other of [UNCONFIRMED_GUIDE_TEXT, NOT_EXECUTABLE_GUIDE_TEXT, RUNNING_OR_DONE_GUIDE_TEXT].filter((g) => g !== guide)) {
      expect(text()).not.toContain(other);
    }
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
    expect(rejectButton()).toBeNull();
    expect(rejectFailedCount()).toBe(0);
    expect(text()).not.toContain(NOT_FOUND_ERROR);
  });

  it.each([
    ['何も添えない (間に pending に戻った・行の状態を読めなかった)', async () => json(404, { error: RAW_SERVER_ERROR })],
    ['許していない値 (notExecutableReason が理由のどれでもない・proposedActionHidden が true でない)', async () =>
      json(404, { error: RAW_SERVER_ERROR, notExecutableReason: 'executed', proposedActionHidden: 'true' })],
    ['本文が JSON でない', async () => new Response(RAW_SERVER_ERROR, { status: 404 })],
  ])('404 で %s: カードを残し (「実行する」「断る」は押せる)、固定の失敗の文を 1 つ足す。「実行中か実行済み」と出さない', async (_label, handler) => {
    handlers[DELETE_KEY] = handler;
    await openChat();
    await click(rejectButton()!);
    await pollUntil(() => rejectFailedCount() > 0);
    expect(rejectFailedCount()).toBe(1);
    expect(text()).toContain(PANTRY_LABEL);
    expect(guideShown()).toBe(false);
    expect(text()).not.toContain(RUNNING_OR_DONE_GUIDE_TEXT);
    const execute = buttonByText(EXECUTE_BUTTON_TEXT);
    expect(execute).toBeDefined();
    expect(execute!.disabled).toBe(false);
    expect(rejectButton()).not.toBeNull();
    expect(rejectButton()!.disabled).toBe(false);
    expect(text()).not.toContain(RAW_SERVER_ERROR);
  });

  it.each([
    ['500', async () => json(500, { error: RAW_SERVER_ERROR })],
    ['401', async () => json(401, { error: RAW_SERVER_ERROR })],
    ['500 で本文が JSON でない', async () => new Response(RAW_SERVER_ERROR, { status: 500 })],
    ['通信の失敗 (fetch が投げる)', async (): Promise<Response> => {
      throw new TypeError(RAW_SERVER_ERROR);
    }],
  ])('%s: カードを残し (「実行する」「断る」は押せる)、固定の失敗の文を 1 つ足す。本文の文面は出さない', async (_label, handler) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    handlers[DELETE_KEY] = handler;
    await openChat();
    await click(rejectButton()!);
    await pollUntil(() => rejectFailedCount() > 0);
    expect(rejectFailedCount()).toBe(1);
    expect(text()).toContain(PANTRY_LABEL);
    expect(guideShown()).toBe(false);
    const execute = buttonByText(EXECUTE_BUTTON_TEXT);
    expect(execute).toBeDefined();
    expect(execute!.disabled).toBe(false);
    expect(rejectButton()).not.toBeNull();
    expect(rejectButton()!.disabled).toBe(false);
    expect(text()).not.toContain(RAW_SERVER_ERROR);

    // カードが残っているので、もう一度断れる (2 回目は断れた)
    handlers[DELETE_KEY] = async () => json(200, { success: true });
    await click(rejectButton()!);
    await pollUntil(() => !cardShown());
    expect(cardShown()).toBe(false);
    expect(deleteCalls()).toBe(2);
  });

  it('応答待ちの間は、そのカードの「断る」「実行する」を止める (同じ描画のうちの 2 度目の押下も断らない・実行しない)', async () => {
    const pending = deferred<Response>();
    handlers[DELETE_KEY] = () => pending.promise;
    const executeHandler = vi.fn(async () => json(200, { success: true, result: {}, actionType: 'add_pantry_item' }));
    handlers[EXECUTE_KEY] = executeHandler;
    await openChat();
    const reject = rejectButton()!;
    const execute = buttonByText(EXECUTE_BUTTON_TEXT)!;
    await act(async () => {
      reject.click();
      // 同じ描画のうちの 2 度目の押下 (ボタンの止めがまだ描かれていない)
      reject.click();
      execute.click();
    });
    expect(deleteCalls()).toBe(1);
    expect(executeHandler).not.toHaveBeenCalled();
    expect(rejectButton()!.disabled).toBe(true);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)!.disabled).toBe(true);

    await act(async () => {
      pending.resolve(json(500, { error: RAW_SERVER_ERROR }));
    });
    await pollUntil(() => rejectFailedCount() > 0);
    // 応答のあとは押せるように戻る
    expect(rejectButton()!.disabled).toBe(false);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)!.disabled).toBe(false);
    expect(deleteCalls()).toBe(1);
    expect(executeHandler).not.toHaveBeenCalled();
  });
});

/** 実行の API の、やり直せる失敗の応答 (200 で success: false。retryable を添えない = やり直せる。行は pending に戻る) */
const RETRYABLE_EXECUTE_FAILED_ERROR = 'retryable execute failed 2295';
function retryableExecuteFailedResponse(): Response {
  return json(200, { success: false, result: { error: RETRYABLE_EXECUTE_FAILED_ERROR }, actionType: 'add_pantry_item' });
}

function executeButton(): HTMLButtonElement {
  const button = buttonByText(EXECUTE_BUTTON_TEXT);
  expect(button).toBeDefined();
  return button!;
}

function executeCalls(): number {
  return vi.mocked(fetch).mock.calls.filter(
    ([input, init]) => (init?.method ?? 'GET').toUpperCase() === 'POST' && String(input).endsWith(`/actions/${MESSAGE_ID}/execute`),
  ).length;
}

describe('#2295 integrity-1107d 「実行する」の応答待ち・閉じる途中・終了した相談では「断る」も止める', () => {
  it('「実行する」の応答待ちの間は「断る」を止める (同じ描画のうちの押下も DELETE を出さない)。やり直せる失敗で終わると、どちらも押せるように戻る', async () => {
    const pendingExecute = deferred<Response>();
    handlers[EXECUTE_KEY] = () => pendingExecute.promise;
    const deleteHandler = vi.fn(async () => json(200, { success: true }));
    handlers[DELETE_KEY] = deleteHandler;
    await openChat();
    const execute = executeButton();
    const reject = rejectButton()!;
    await act(async () => {
      execute.click();
      // 同じ描画のうちの「断る」の押下 (ボタンの止めがまだ描かれていない): rejectAction の入口で止める
      reject.click();
    });
    await pollUntil(() => executeCalls() === 1);
    expect(executeCalls()).toBe(1);
    expect(deleteCalls()).toBe(0);
    // 実行の応答待ちの間は、「実行する」も「断る」も押せない
    expect(executeButton().disabled).toBe(true);
    expect(rejectButton()!.disabled).toBe(true);
    // 描かれたあとの押下も断らない
    await click(rejectButton()!);
    expect(deleteCalls()).toBe(0);
    expect(deleteHandler).not.toHaveBeenCalled();
    expect(guideShown()).toBe(false);
    expect(text()).not.toContain(UNCONFIRMED_GUIDE_TEXT);

    // 実行がやり直せる失敗で終わる (行は pending に戻る): カードは「実行する」のまま残り、どちらも押せるように戻る
    await act(async () => {
      pendingExecute.resolve(retryableExecuteFailedResponse());
    });
    await pollUntil(() => text().includes(RETRYABLE_EXECUTE_FAILED_ERROR));
    expect(text()).toContain(RETRYABLE_EXECUTE_FAILED_ERROR);
    await pollUntil(() => !executeButton().disabled);
    expect(guideShown()).toBe(false);
    expect(text()).not.toContain(UNCONFIRMED_GUIDE_TEXT);
    expect(executeButton().disabled).toBe(false);
    expect(rejectButton()!.disabled).toBe(false);

    // 戻ったあとは断れる (DELETE は 1 回だけ・カードを閉じる)
    await click(rejectButton()!);
    await pollUntil(() => !cardShown());
    expect(cardShown()).toBe(false);
    expect(deleteCalls()).toBe(1);
    expect(executeCalls()).toBe(1);
  });

  it('相談を閉じる (/close) の応答待ちの間は「断る」を止める (閉じると同じ描画のうちの押下も DELETE を出さない)', async () => {
    const pendingClose = deferred<Response>();
    handlers[`POST /api/ai/consultation/sessions/${SESSION_ID}/close`] = () => pendingClose.promise;
    handlers[DELETE_KEY] = async () => json(200, { success: true });
    await openChat();
    const closeButton = container.querySelector<HTMLButtonElement>('button[title="相談を終了して要約を保存"]');
    expect(closeButton).not.toBeNull();
    const reject = rejectButton()!;
    await act(async () => {
      closeButton!.click();
      // 閉じると同じ描画のうちの「断る」の押下 (ボタンの止めがまだ描かれていない): rejectAction の入口で止める
      reject.click();
    });
    expect(deleteCalls()).toBe(0);
    expect(rejectButton()!.disabled).toBe(true);
    expect(executeButton().disabled).toBe(true);
    await click(rejectButton()!);
    expect(deleteCalls()).toBe(0);
  });

  it('終了した相談 (一覧の status が終了) では「断る」を止める (押しても DELETE を出さない)', async () => {
    handlers['GET /api/ai/consultation/sessions?status=all'] = async () =>
      json(200, { sessions: [{ id: SESSION_ID, title: 'AI相談', messageCount: 1, status: 'closed' }] });
    handlers[DELETE_KEY] = async () => json(200, { success: true });
    await openChat();
    await pollUntil(() => rejectButton() !== null);
    expect(text()).toContain(PANTRY_LABEL);
    expect(rejectButton()!.disabled).toBe(true);
    expect(executeButton().disabled).toBe(true);
    await click(rejectButton()!);
    expect(deleteCalls()).toBe(0);
  });

  it('送信が 409 (終了した相談) で返って終了と分かった直後 (止めがまだ描かれていない) の「断る」も、rejectAction の入口で止める', async () => {
    handlers[`POST /api/ai/consultation/sessions/${SESSION_ID}/messages?stream=true`] = async () =>
      json(CONSULTATION_SESSION_CLOSED_STATUS, consultationSessionClosedBody());
    handlers[DELETE_KEY] = async () => json(200, { success: true });
    await openChat();
    // 終了と分かった (markSessionsClosed) すぐあとに一覧を読み直す。その読み直しの中 (描画の前) で「断る」を押す
    let rejectEnabledWhenPressed: boolean | null = null;
    handlers['GET /api/ai/consultation/sessions?status=all'] = async () => {
      const reject = rejectButton();
      if (reject && rejectEnabledWhenPressed === null) {
        rejectEnabledWhenPressed = !reject.disabled;
        reject.click();
      }
      return json(200, { sessions: [{ id: SESSION_ID, title: 'AI相談', messageCount: 1, status: 'closed' }] });
    };
    const input = container.querySelector<HTMLInputElement>('input[placeholder="メッセージを入力..."]');
    expect(input).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, '明日の朝ごはんは?');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="メッセージを送信"]');
    expect(sendButton).not.toBeNull();
    await act(async () => {
      sendButton!.click();
    });
    await pollUntil(() => rejectEnabledWhenPressed !== null && rejectButton()?.disabled === true);
    // 押したときはボタンがまだ押せた (止めは描かれていない) ので、止めたのは rejectAction の入口
    expect(rejectEnabledWhenPressed).toBe(true);
    expect(rejectButton()!.disabled).toBe(true);
    expect(deleteCalls()).toBe(0);
  });
});
