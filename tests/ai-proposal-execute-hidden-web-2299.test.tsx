/**
 * #2299 AI 相談 (Web) の提案のカード (src/components/AIChatBubble.tsx) の「実行する」(executeAction) が、実行の API の 400 / 404 の
 * proposedActionHidden を受けてカードを閉じる。あわせて「断る」(rejectAction) の入口と待ちを executeAction にそろえる。
 *
 * 問題 (直す前):
 *   - 別のタブで断った提案に「実行する」を押すと、404 で「もう一度 AI に頼んでください」の案内 (と失敗の文) が出た。
 *     開き直すと GET は hidden でカードが消え、見え方が食い違っていた
 *   - 「断る」の入口は会話の読み込みの最中 (loadingRef) を見ていなかった (executeAction は見ている)
 *   - 「断る」の fetch に待ちの上限が無く、応答が返らない間はカードの「実行する」「断る」が止まったままだった
 *
 * 直したあと:
 *   - 実行するの 400 / 404 の本文が proposedActionHidden: true (許した値 true だけ) なら、カードを閉じ、会話に失敗の文を足さない
 *   - 「断る」は会話の読み込みの最中は DELETE を出さない
 *   - 「断る」は AI_CHAT_REQUEST_TIME_LIMIT_MS を上限に待ち、上限に達したらカードを残して断れなかった文を 1 つ出す
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
const { AI_CHAT_REQUEST_TIME_LIMIT_MS } = await import('@/lib/ai/consultation-request-time-limit');

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
  // 偽のタイマーを使うテストが途中で落ちても、次のテストに残さない
  vi.useRealTimers();
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
const NOT_FOUND_ERROR = 'not found error text 2299';
/** 提案の見出し (ACTION_LABELS の add_pantry_item の名前。手で書いた期待値) */
const PANTRY_LABEL = '冷蔵庫に追加';
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

/** 実行の API の 400 の本文の error (画面に出す失敗の文の元。hidden のときは出さない) */
const ALREADY_PROCESSED_ERROR = 'already processed error text 2299';

function executeCalls(): number {
  return vi.mocked(fetch).mock.calls.filter(
    ([input, init]) => (init?.method ?? 'GET').toUpperCase() === 'POST' && String(input).endsWith(`/actions/${MESSAGE_ID}/execute`),
  ).length;
}

/** 案内・失敗の文がどれも出ていない */
function expectNoGuideNorFailure(errorText: string) {
  expect(guideShown()).toBe(false);
  for (const guide of [RUNNING_OR_DONE_GUIDE_TEXT, UNCONFIRMED_GUIDE_TEXT, NOT_EXECUTABLE_GUIDE_TEXT]) {
    expect(text()).not.toContain(guide);
  }
  expect(text()).not.toContain(errorText);
}

describe('#2299 「実行する」の 400 / 404 が proposedActionHidden ならカードを閉じる', () => {
  it('別のタブで断った提案に「実行する」を押す再現: 404 + proposedActionHidden でカードを閉じ、「もう一度 AI に頼んでください」も失敗の文も出さない', async () => {
    handlers[EXECUTE_KEY] = async () => json(404, { error: NOT_FOUND_ERROR, proposedActionHidden: true });
    await openChat();
    expect(text()).toContain(PANTRY_LABEL);
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    await pollUntil(() => !cardShown());

    expect(cardShown()).toBe(false);
    expectNoGuideNorFailure(NOT_FOUND_ERROR);
    expect(executeCalls()).toBe(1);
    expect(deleteCalls()).toBe(0);
    // 実行していないので、データの更新は通知しない
    expect(mealPlanUpdated).not.toHaveBeenCalled();
  });

  it('400 (読んだ時点・claim が 0 行で断られていた) + proposedActionHidden: カードを閉じ、失敗の文を出さない', async () => {
    handlers[EXECUTE_KEY] = async () => json(400, { error: ALREADY_PROCESSED_ERROR, proposedActionHidden: true });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    await pollUntil(() => !cardShown());

    expect(cardShown()).toBe(false);
    expectNoGuideNorFailure(ALREADY_PROCESSED_ERROR);
    expect(mealPlanUpdated).not.toHaveBeenCalled();
  });

  it.each([
    [404, NOT_FOUND_ERROR],
    [400, ALREADY_PROCESSED_ERROR],
  ])('%i で proposedActionHidden が true でない ("true" の文字): カードを閉じず、今までどおり失敗の文と頼み直しの案内を出す', async (status, error) => {
    handlers[EXECUTE_KEY] = async () => json(status, { error, proposedActionHidden: 'true' });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    await pollUntil(() => guideShown());

    expect(guideShown()).toBe(true);
    expect(text()).toContain(PANTRY_LABEL);
    expect(text()).toContain(NOT_EXECUTABLE_GUIDE_TEXT);
    expect(text()).toContain(error);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)).toBeUndefined();
  });

  it('404 で notExecutableReason: runningOrDone (実行済みを含む): 今までどおりカードは残して「実行中か実行済み」の案内', async () => {
    handlers[EXECUTE_KEY] = async () => json(404, { error: NOT_FOUND_ERROR, notExecutableReason: 'runningOrDone' });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    await pollUntil(() => guideShown());

    expect(guideShown()).toBe(true);
    expect(text()).toContain(RUNNING_OR_DONE_GUIDE_TEXT);
    expect(text()).toContain(PANTRY_LABEL);
  });

  it('500 + proposedActionHidden (400 / 404 でない): カードを閉じない (閉じるのは 400 / 404 のときだけ)', async () => {
    handlers[EXECUTE_KEY] = async () => json(500, { error: NOT_FOUND_ERROR, proposedActionHidden: true });
    await openChat();
    await click(buttonByText(EXECUTE_BUTTON_TEXT)!);
    await pollUntil(() => text().includes(NOT_FOUND_ERROR));

    expect(text()).toContain(NOT_FOUND_ERROR);
    expect(cardShown()).toBe(true);
  });
});

describe('#2299 「断る」の入口と待ちを executeAction にそろえる', () => {
  it('会話の読み込みの最中 (新しい相談の作成を始めたのと同じ描画のうちの押下) は DELETE を出さない', async () => {
    const pendingCreate = deferred<Response>();
    handlers['POST /api/ai/consultation/sessions'] = () => pendingCreate.promise;
    const deleteHandler = vi.fn(async () => json(200, { success: true }));
    handlers[DELETE_KEY] = deleteHandler;
    await openChat();
    await pollUntil(() => rejectButton() !== null);
    const reject = rejectButton()!;
    const toggle = container.querySelector('svg.lucide-chevron-down')?.closest('button');
    expect(toggle).toBeTruthy();
    await act(async () => {
      (toggle as HTMLButtonElement).click();
    });
    await pollUntil(() => buttonByText('新しい相談を始める') !== undefined);
    const newSession = buttonByText('新しい相談を始める')!;
    // 一覧を開いても「断る」は画面にあり、押せる (外れた要素を押して空振りしないことを先に確かめる)
    expect(reject.isConnected).toBe(true);
    expect(reject.disabled).toBe(false);
    await act(async () => {
      newSession.click();
      // 読み込みを始めたのと同じ描画のうちの「断る」の押下 (輪がまだ描かれていない): rejectAction の入口で止める
      reject.click();
    });

    expect(deleteCalls()).toBe(0);
    expect(deleteHandler).not.toHaveBeenCalled();
  });

  it('対照: 読み込みの最中でなければ「断る」は DELETE を出す', async () => {
    handlers[DELETE_KEY] = async () => json(200, { success: true });
    await openChat();
    await pollUntil(() => rejectButton() !== null);
    await click(rejectButton()!);
    await pollUntil(() => !cardShown());

    expect(deleteCalls()).toBe(1);
    expect(cardShown()).toBe(false);
  });

  it('断るの応答が上限 (AI_CHAT_REQUEST_TIME_LIMIT_MS) までに返らない: 打ち切り、カードを残して断れなかった文を 1 つ出す。押せるように戻る', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const signals: AbortSignal[] = [];
    handlers[DELETE_KEY] = (_url, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The user aborted a request.', 'AbortError')));
      });
    };
    await openChat();
    await pollUntil(() => rejectButton() !== null);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await click(rejectButton()!);
    expect(deleteCalls()).toBe(1);
    expect(rejectButton()!.disabled).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_CHAT_REQUEST_TIME_LIMIT_MS - 1);
    });
    expect(rejectFailedCount()).toBe(0);
    expect(signals[0].aborted).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await pollUntil(() => rejectFailedCount() > 0);
    vi.useRealTimers();

    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    expect(rejectFailedCount()).toBe(1);
    expect(text()).toContain(PANTRY_LABEL);
    expect(guideShown()).toBe(false);
    expect(rejectButton()!.disabled).toBe(false);
    expect(buttonByText(EXECUTE_BUTTON_TEXT)!.disabled).toBe(false);
  });

  it('上限のあとに押し直すと、サーバーで断れていれば 404 の proposedActionHidden でカードが閉じる', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    handlers[DELETE_KEY] = (_url, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The user aborted a request.', 'AbortError')));
      });
    await openChat();
    await pollUntil(() => rejectButton() !== null);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await click(rejectButton()!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_CHAT_REQUEST_TIME_LIMIT_MS);
    });
    await pollUntil(() => rejectFailedCount() > 0);
    vi.useRealTimers();
    expect(rejectFailedCount()).toBe(1);

    handlers[DELETE_KEY] = async () => json(404, { error: NOT_FOUND_ERROR, proposedActionHidden: true });
    await click(rejectButton()!);
    await pollUntil(() => !cardShown());

    expect(cardShown()).toBe(false);
    expect(deleteCalls()).toBe(2);
    expect(rejectFailedCount()).toBe(1);
  });
});
