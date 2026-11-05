/**
 * #2275 T3 献立表 (/menus/weekly) の生成中の印 (localStorage の v4MenuGenerating ほか) の読み書きが、保存が禁止された環境で投げて、
 * 失敗の表示・完了の後処理・中止が途中で止まっていた欠陥の回帰テスト。
 *
 * 問題 (直す前):
 *   - 5 秒ごとの確認 (ポーリング) の failed / not_found の分岐は、印を消す removeItem が GEN_FAIL の dispatch より前にあり、
 *     投げると tick の try/catch に握られて失敗パネルが出なかった
 *   - 再読み込みの復元 (restoreGeneration) は、サーバーの状態が completed / failed のとき、印を消す removeItem が完成のお知らせ・
 *     失敗パネルより前にあり、投げると catch の中の removeItem もまた投げて、何も出なかった (未処理の reject)
 *   - 復元の進捗の購読の callback は、completed / failed で removeItem が投げると、同じイベントの完了の後処理 (完成のお知らせ・
 *     進捗の表示を消す)・失敗パネルに届かなかった
 *   - 中止 (handleCancelGeneration) は、印を消す removeItem が投げると、進捗の表示を消す前に止まった
 *
 * 直したあと: page.tsx の印の読み書きは _state/safeLocalStorage.ts の失敗を握る関数 (readLocalStorageItem・removeLocalStorageItem) を通す。
 * 印を消せなくても、失敗パネル・完了の後処理・中止は最後まで走る。
 *
 * どの it も直す前の形で赤になる。Supabase には接続しない (createClient をモック)。生成のフック (useV4MenuGeneration) はモックにし、
 * 進捗の購読の callback をこの検査から呼ぶ。@testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => {
  // ページの週の始まりの初期値はモジュールを読んだときの時計で決まるので、読む前に時計を止める。
  // 5 秒ごとの確認 (setInterval) はこの検査が時計を進めて回す (setTimeout は止めない)
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-11-04T03:00:00.000Z'));
  return {
    router: { push: () => undefined, back: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined },
    searchParams: new URLSearchParams(),
  };
});
vi.mock('next/navigation', () => ({
  usePathname: () => '/menus/weekly',
  useSearchParams: () => navigation.searchParams,
  useRouter: () => navigation.router,
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('next/image', () => ({ default: () => null }));
// dynamic import の部品は描かない。ただし生成のモーダル (V4GenerateModal: isOpen と onGenerate を受け取る) は、開いているあいだ
// 「生成する」のボタンだけを描き、押すと 1 枠の生成を頼む
vi.mock('next/dynamic', () => ({
  default: () =>
    function DynamicStub(props: { isOpen?: boolean; onGenerate?: (params: unknown) => unknown }) {
      if (!props.isOpen || !props.onGenerate) return null;
      const onGenerate = props.onGenerate;
      return (
        <button
          type="button"
          data-testid="stub-v4-generate"
          onClick={() => {
            void onGenerate({ targetSlots: [{ date: '2026-11-04', mealType: 'dinner' }], constraints: {}, note: '' });
          }}
        >
          生成する
        </button>
      );
    },
}));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => undefined }));
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: async () => 'consented', consentModal: null }),
}));

/** 生成のフックのモック。進捗の購読 (subscribeToProgress) の callback を控え、検査から呼ぶ */
type ProgressCallback = (progress: { status: string; errorMessage?: string | null }) => void;
const v4 = vi.hoisted(() => ({
  requestId: '22750000-0000-4000-8000-0000000000a1',
  subscriptions: [] as { requestId: string; onProgress: ProgressCallback }[],
}));
vi.mock('@/hooks/useV4MenuGeneration', () => ({
  useV4MenuGeneration: (options: { onGenerationStart?: (requestId: string) => void } = {}) => ({
    isGenerating: false,
    requestId: null,
    error: null,
    // 本物のフックと同じく、受け付けたら onGenerationStart を呼ぶ (画面はここで生成中になる)
    generate: async () => {
      options.onGenerationStart?.(v4.requestId);
      return { requestId: v4.requestId, status: 'pending', totalSlots: 1 };
    },
    subscribeToProgress: (requestId: string, onProgress: ProgressCallback) => {
      v4.subscriptions.push({ requestId, onProgress });
      return () => undefined;
    },
    cancelGeneration: () => undefined,
    getRequestStatus: async () => null,
  }),
}));

/** Supabase のモック。ログインしていて、プロフィールは全部入り (週の始まりは月曜)。ほかの表は空 */
vi.mock('@/lib/supabase/client', () => {
  const USER = { id: '22750000-0000-4000-8000-0000000000b1', user_metadata: {} };
  const PROFILE = {
    profile_completeness: 100,
    height: 170,
    weight: 65,
    age: 35,
    fitness_goals: ['健康維持'],
    health_conditions: ['なし'],
    week_start_day: 'monday',
    family_id: null,
  };
  const resultOf = (table: string | null, single: boolean) => {
    if (table === 'user_profiles') return single ? { data: PROFILE, error: null, count: 1 } : { data: [PROFILE], error: null, count: 1 };
    return single ? { data: null, error: null, count: 0 } : { data: [], error: null, count: 0 };
  };
  const query = (table: string | null, single: boolean): unknown =>
    new Proxy(() => undefined, {
      get: (_target, prop) => {
        if (prop === 'then') return (resolve: (value: unknown) => void) => resolve(resultOf(table, single));
        return () => query(table, single || prop === 'single' || prop === 'maybeSingle');
      },
    });
  const channel = { on: () => channel, subscribe: () => channel, unsubscribe: async () => 'ok' };
  return {
    createClient: () => ({
      auth: {
        getUser: async () => ({ data: { user: USER }, error: null }),
        getSession: async () => ({ data: { session: { user: USER } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      },
      from: (table: string) => query(table, false),
      rpc: () => query(null, false),
      channel: () => channel,
      removeChannel: async () => 'ok',
    }),
  };
});

const { default: WeeklyMenuPage } = await import('@/app/(main)/menus/weekly/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** fetch → res.json() → setState → useEffect → 次の fetch の連鎖を流しきるまでに回すタスクの数 */
const SETTLE_TASKS = 20;
/** ページの API の相対 URL を解く起点 (fetch のモックの中だけで使う) */
const PAGE_ORIGIN = 'http://localhost';
const NOT_FOUND_STATUS = 404;
/** 5 秒ごとの確認の間隔 (page.tsx の handleV4Generate の setInterval と同じ) */
const V4_POLL_INTERVAL_MS = 5000;
/** 生成の状態の API */
const V4_STATUS_PATH = '/api/ai/menu/weekly/status';
/** 生成中の印のキー */
const V4_MARKER_KEY = 'v4MenuGenerating';
/** 失敗パネル・進捗の表示 */
const FAILED_PANEL = '[data-testid="generation-failed-modal"]';
const PROGRESS_CARD = '[data-testid="generation-progress"]';
/** 完了の後処理が出す完成のお知らせ */
const COMPLETED_TITLE = '献立が完成しました！';
/** 5 秒ごとの確認の failed / not_found の分岐の既定の失敗の文 */
const POLL_FAILED_MESSAGE = '献立の生成に失敗しました。もう一度お試しください。';
/** 状態が失敗の行の文 (こちらで書いた定型の文ではないので、表示では既定の文になる) */
const RESTORE_FAILED_MESSAGE = '生成に失敗しました';

/** 保存が禁止された環境の例外 */
const SECURITY_ERROR = new DOMException('The operation is insecure.', 'SecurityError');

/** GET /api/ai/menu/weekly/status の答え (null = 404) */
let v4StatusBody: Record<string, unknown> | null;
let fetchCalls: { path: string; method: string }[];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function installFakeServer() {
  fetchCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: { method?: string }) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), PAGE_ORIGIN);
    const method = (init?.method ?? 'GET').toUpperCase();
    fetchCalls.push({ path: url.pathname, method });
    // 祝日の一覧 (外の API) は、この検査では祝日なし
    if (url.origin !== PAGE_ORIGIN) return jsonResponse({});
    switch (url.pathname) {
      case '/api/meal-plans':
        return jsonResponse({ dailyMeals: [], startDate: url.searchParams.get('startDate'), endDate: url.searchParams.get('endDate'), shoppingList: null });
      case '/api/ai/menu/weekly/pending':
        return jsonResponse({ hasPending: false });
      case '/api/ai/menu/meal/pending':
        return jsonResponse({ hasPending: false, requests: [] });
      case '/api/ai/menu/weekly/cleanup':
        return jsonResponse({ cleaned: 0 });
      case '/api/pantry':
        return jsonResponse({ items: [] });
      case '/api/profile':
        return jsonResponse({ family_size: 2, servings_config: null, radar_chart_nutrients: null });
      case V4_STATUS_PATH:
        if (method === 'POST') return jsonResponse({ success: true });
        return v4StatusBody === null ? jsonResponse({}, NOT_FOUND_STATUS) : jsonResponse(v4StatusBody);
      default:
        return jsonResponse({}, NOT_FOUND_STATUS);
    }
  }));
}

/** 印を消す removeItem が投げる形 2 つ (後片付けは afterEach) */
const REMOVE_FAILURES: readonly { failure: string; install: () => () => void }[] = [
  {
    failure: 'removeItem だけが投げる',
    install: () => {
      const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw SECURITY_ERROR;
      });
      return () => removeItem.mockRestore();
    },
  },
  {
    failure: 'localStorage への参照そのものが投げる',
    install: () => {
      const own = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => {
          throw SECURITY_ERROR;
        },
      });
      return () => {
        if (own) Object.defineProperty(globalThis, 'localStorage', own);
      };
    },
  },
];
const REMOVE_ONLY_FAILURE = REMOVE_FAILURES[0]!;

let container: HTMLDivElement;
let root: Root;
let uninstallStorageFailure: (() => void) | null;

beforeEach(() => {
  process.env.TZ = 'UTC';
  navigation.searchParams = new URLSearchParams();
  localStorage.clear();
  v4.subscriptions = [];
  v4StatusBody = null;
  uninstallStorageFailure = null;
  installFakeServer();
  // framer-motion がアニメーションの寸法を測るときに呼ぶ (jsdom には無い)
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  // 印を読み書きできなかった警告は、この検査では出てよい
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  uninstallStorageFailure?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

afterAll(() => {
  vi.useRealTimers();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < SETTLE_TASKS; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function renderWeeklyPage() {
  await act(async () => {
    root.render(<WeeklyMenuPage />);
  });
  await settle();
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await settle();
}

function requireElement<T extends Element>(element: T | null | undefined, what: string): T {
  if (!element) throw new Error(`${what} が無い`);
  return element;
}

/** 再読み込みの前に置かれていた生成中の印 (今の時刻に始めた生成) */
function storeV4Marker() {
  localStorage.setItem(V4_MARKER_KEY, JSON.stringify({ requestId: v4.requestId, timestamp: Date.now(), totalSlots: 1 }));
}

/** 印を消す removeItem を投げる形にする */
function installStorageFailure(failure: { install: () => () => void }) {
  uninstallStorageFailure = failure.install();
}

/** 失敗パネルの文 (無ければ null) */
const failedPanelText = () => container.querySelector(FAILED_PANEL)?.textContent ?? null;

/** 復元の購読に進捗を 1 つ届ける。callback が投げたら、その例外を返す (直す前は removeItem の例外がここから投げた) */
async function deliverRestoredProgress(progress: { status: string; errorMessage?: string | null }): Promise<unknown> {
  const subscription = v4.subscriptions.find((s) => s.requestId === v4.requestId);
  if (!subscription) throw new Error('復元の進捗の購読が無い');
  let thrown: unknown = null;
  await act(async () => {
    try {
      subscription.onProgress(progress);
    } catch (error: unknown) {
      thrown = error;
    }
  });
  await settle();
  return thrown;
}

describe('再読み込みの復元: 印を消す removeItem が投げても、失敗パネル・完成のお知らせを出す (#2275 T3)', () => {
  it('サーバーの状態が failed: 失敗パネルを出す (直す前は removeItem の例外で何も出なかった)', async () => {
    storeV4Marker();
    v4StatusBody = { status: 'failed', errorMessage: null };
    installStorageFailure(REMOVE_ONLY_FAILURE);
    await renderWeeklyPage();
    expect(failedPanelText()).toContain(RESTORE_FAILED_MESSAGE);
    expect(container.querySelector(PROGRESS_CARD)).toBeNull();
  });

  it('サーバーの状態が completed: 完成のお知らせを出す (直す前は removeItem の例外で何も出なかった)', async () => {
    storeV4Marker();
    v4StatusBody = { status: 'completed' };
    installStorageFailure(REMOVE_ONLY_FAILURE);
    await renderWeeklyPage();
    expect(container.textContent).toContain(COMPLETED_TITLE);
    expect(container.querySelector(FAILED_PANEL)).toBeNull();
  });

  it('処理中から completed が届く: 購読の callback は投げず、進捗の表示を消して完成のお知らせを出す (完了の後処理が走る)', async () => {
    storeV4Marker();
    v4StatusBody = { status: 'processing', progress: { totalSlots: 1, completedSlots: 0 } };
    installStorageFailure(REMOVE_ONLY_FAILURE);
    await renderWeeklyPage();
    expect(container.querySelector(PROGRESS_CARD), '復元で進捗の表示が出ていない (検査の前提が崩れた)').not.toBeNull();

    const thrown = await deliverRestoredProgress({ status: 'completed' });
    expect(thrown).toBeNull();
    expect(container.querySelector(PROGRESS_CARD)).toBeNull();
    expect(container.textContent).toContain(COMPLETED_TITLE);
  });

  it('処理中から failed が届く: 購読の callback は投げず、失敗パネルを出す', async () => {
    storeV4Marker();
    v4StatusBody = { status: 'processing', progress: { totalSlots: 1, completedSlots: 0 } };
    installStorageFailure(REMOVE_ONLY_FAILURE);
    await renderWeeklyPage();
    expect(container.querySelector(PROGRESS_CARD), '復元で進捗の表示が出ていない (検査の前提が崩れた)').not.toBeNull();

    const thrown = await deliverRestoredProgress({ status: 'failed', errorMessage: null });
    expect(thrown).toBeNull();
    expect(container.querySelector(PROGRESS_CARD)).toBeNull();
    expect(failedPanelText()).toContain(RESTORE_FAILED_MESSAGE);
  });
});

describe('中止: 印を消す removeItem が投げても、進捗の表示を消して中止を知らせる (#2275 T3)', () => {
  it('復元した生成を中止すると、進捗の表示が消え、中止のお知らせが出て、サーバーへ中止を送る (直す前は removeItem の例外で止まった)', async () => {
    storeV4Marker();
    v4StatusBody = { status: 'processing', progress: { totalSlots: 1, completedSlots: 0 } };
    installStorageFailure(REMOVE_ONLY_FAILURE);
    await renderWeeklyPage();
    const progressCard = requireElement(container.querySelector<HTMLElement>(PROGRESS_CARD), '進捗の表示');
    await click(requireElement(progressCard.querySelector<HTMLButtonElement>('button[aria-label="生成を中止する"]'), '中止のボタン'));
    const confirmButton = requireElement(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => (button.textContent ?? '').trim() === '中止する'),
      '中止の確認のボタン',
    );
    await click(confirmButton);

    expect(container.querySelector(PROGRESS_CARD)).toBeNull();
    expect(container.textContent).toContain('生成の追跡を中止しました');
    expect(fetchCalls.filter((call) => call.path === V4_STATUS_PATH && call.method === 'POST')).toHaveLength(1);
  });
});

describe('5 秒ごとの確認: 印を消す removeItem が投げても、failed / not_found で失敗パネルを出す (#2275 T3)', () => {
  for (const failure of REMOVE_FAILURES) {
    for (const status of ['failed', 'not_found'] as const) {
      it(`${failure.failure}・状態が ${status}: 失敗パネルを出す (直す前は removeItem の例外が tick の catch に握られ、何も出なかった)`, async () => {
        await renderWeeklyPage();
        installStorageFailure(failure);
        await click(requireElement(container.querySelector<HTMLButtonElement>('[data-testid="ai-assistant-banner-button"]'), 'AI に埋めてもらうボタン'));
        await click(requireElement(container.querySelector<HTMLButtonElement>('[data-testid="stub-v4-generate"]'), '生成するボタン'));
        expect(container.querySelector(PROGRESS_CARD), '生成の進捗の表示が出ていない (検査の前提が崩れた)').not.toBeNull();

        v4StatusBody = { status };
        await act(async () => {
          await vi.advanceTimersByTimeAsync(V4_POLL_INTERVAL_MS);
        });
        await settle();

        expect(fetchCalls.some((call) => call.path === V4_STATUS_PATH && call.method === 'GET'), '5 秒ごとの確認が状態を読んでいない').toBe(true);
        expect(failedPanelText()).toContain(POLL_FAILED_MESSAGE);
        expect(container.querySelector(PROGRESS_CARD)).toBeNull();
      });
    }
  }
});
