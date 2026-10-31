/**
 * #2073 S7 と同じ型: 運営の画面で、状態の変更の通信が reject された (応答を受け取れなかった) ときに、今の状態を読み直す
 *
 * 対象:
 *   - クーポンの詳細 (/super-admin/coupons/[id]) の「一時停止」「再開する」
 *   - 機能パッケージの詳細 (/super-admin/feature-packages/[id]) の「廃止する」
 *   - A/B テストの詳細 (/super-admin/experiments/[id]) の「実験開始」「完了」「中止」と一覧 (/super-admin/experiments) の「開始」「完了」
 *   - 機能フラグの一覧 (/super-admin/flags) の切り替えと「削除」
 *   - メール送信の一覧 (/super-admin/email-outbox) の「再送」 (dead → queued。2 周目のレビューで足した同じ型)
 *
 * 以前の画面は、通信が reject されると「通信エラー」の文 (または alert) を出すだけで読み直さなかった。サーバーが変更を済ませてから
 * 応答が切れると、画面は古い状態とボタンのまま残り、もう一度押すと 409 (遷移表に無い変更・同時の変更) になって、
 * 自分の操作だったのに「別の操作でクーポンの状態が先に変わっていました」のように出た。
 * また、クーポン・機能パッケージは 409 のあとの読み直しが失敗したとき「ページを読み込み直してください」と出すだけで、
 * プラン・A/B テストの画面にある「再試行」が無かった。
 *
 * 直したあとの不変条件:
 *   - 通信が reject されたら、今の状態を読み直して見せ、「<操作>の応答を受け取れませんでした（通信エラー）」に続けて
 *     読み直した旨を出す (自分の操作が済んでいたときにも合う文。alert にしない)
 *   - 読み直しに失敗したら、その旨と「再試行」を出し、読み直せるまで状態の変更のボタンを止める (押しても送らない)
 *   - クーポン・機能パッケージの 409 のあとの読み直しが失敗したときも「再試行」を出す
 *   - 読み直しのあいだは、その画面の状態の変更を出さない (読み直しの古い一覧・状態が、あとから変えた結果を上書きしないため)。
 *     メール送信の一覧は、再送を 1 行ずつにし、一覧の読み込み (「絞り込む」「再読み込み」「さらに読み込む」・読み直し) と重ねない
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROW_ID = '20732073-2073-4073-8073-207320732074';

vi.mock('next/navigation', () => {
  // 一覧 (/super-admin/experiments) は URL の page を useSearchParams で読み、件数より後ろのページを router.replace で移す (#2107 Y9)。
  // router は描画のたびに同じものを返す (一覧の読み込みの useCallback が router に依存するので、毎回別の値だと読み込みが止まらない)
  const router = { push: () => undefined, replace: () => undefined, refresh: () => undefined };
  return {
    useParams: () => ({ id: ROW_ID }),
    useRouter: () => router,
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: CouponDetailPage } = await import('@/app/super-admin/coupons/[id]/page');
const { default: FeaturePackageDetailPage } = await import('@/app/super-admin/feature-packages/[id]/page');
const { default: ExperimentDetailPage } = await import('@/app/super-admin/experiments/[id]/page');
const { default: ExperimentsPage } = await import('@/app/super-admin/experiments/page');
const { default: FlagsPage } = await import('@/app/super-admin/flags/page');
const { default: EmailOutboxPage } = await import('@/app/super-admin/email-outbox/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 詳細の画面で、今の状態を読み直せたときに続く文 */
const STATE_RELOADED_GUIDE = '今の状態を読み込み直したので、状態を確かめてから、必要ならもう一度操作してください';
/** 詳細の画面で、読み直しにも失敗したときに続く文 */
const STATE_RELOAD_FAILED_GUIDE = '今の状態を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください';
/** 一覧の画面で、一覧を読み直せたときに続く文 */
const LIST_RELOADED_GUIDE = '一覧を読み込み直したので、今の状態を確かめてから、必要ならもう一度操作してください';
/** 一覧の画面で、一覧の読み直しにも失敗したときに続く文 */
const LIST_RELOAD_FAILED_GUIDE = '一覧を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください';

/** 自分の操作のときに出してはいけない、別の操作が先に変えた旨の文の一部 */
const OTHER_OPERATION_WORDS = '別の操作で';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 通信の reject (応答が切れた・届かなかった) */
const networkFailure = () => new TypeError('Failed to fetch');

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let alertSpy: ReturnType<typeof vi.fn>;

type Handler = (method: string, url: URL, body: unknown) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    return handler(method, url, body);
  });
  vi.stubGlobal('fetch', fetchMock);
}

const callsOf = (method: string, pathname: string) =>
  fetchMock.mock.calls.filter(([input, init]) => {
    const m = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    return m === method && new URL(String(input), 'http://localhost').pathname === pathname;
  });

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderElement(element: React.ReactElement) {
  await act(async () => {
    root.render(createElement(Suspense, { fallback: null }, element));
  });
  await settle();
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
}

async function click(element: HTMLElement | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeDefined();
  await act(async () => {
    element!.click();
  });
  await settle();
}

/** 止まったボタンにも click を直に出す (handler の守りを確かめる) */
async function forceClick(element: HTMLButtonElement | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeDefined();
  await act(async () => {
    element!.disabled = false;
    element!.click();
  });
  await settle();
}

const text = () => container.textContent ?? '';

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  alertSpy = vi.fn();
  vi.stubGlobal('alert', alertSpy);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * 詳細の画面 (クーポン・機能パッケージ) のサーバーの代わり。GET は今の行を返す。PATCH は transitions にある遷移なら書く
 * (route と同じく、遷移表に無い変更は 409 invalidCode)。rejectPatch(n) が 'after-write' の n 回目の PATCH は、書いてから
 * reject する (応答が切れた)。'before-write' なら書かずに reject する。failGet(n) が true の n 回目の GET は 500 を返す
 */
function mockDetailServer(options: {
  path: string;
  row: Record<string, unknown>;
  transitions: ReadonlyArray<readonly [string, string]>;
  invalidCode: string;
  rejectPatch?: (n: number) => 'after-write' | 'before-write' | undefined;
  patchStatus?: (n: number) => number | undefined;
  failGet?: (n: number) => boolean;
}) {
  let current = { ...options.row };
  let gets = 0;
  let patches = 0;
  mockFetch((method, url, body) => {
    if (url.pathname !== options.path) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    if (method === 'GET') {
      gets += 1;
      if (options.failGet?.(gets)) return jsonResponse(500, { error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } });
      return jsonResponse(200, { data: { ...current } });
    }
    if (method !== 'PATCH') throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    patches += 1;
    const reject = options.rejectPatch?.(patches);
    if (reject === 'before-write') throw networkFailure();
    const forced = options.patchStatus?.(patches);
    if (forced !== undefined) {
      return jsonResponse(forced, { error: { code: 'CONFLICT_STALE_DATA', message: '別の操作で状態が先に変わりました' } });
    }
    const next = body as Record<string, unknown>;
    if (typeof next.status === 'string') {
      const allowed = options.transitions.some(([from, to]) => from === current.status && to === next.status);
      if (!allowed) {
        return jsonResponse(409, { error: { code: options.invalidCode, message: `状態は ${String(current.status)} から ${next.status} へは変えられません` } });
      }
    }
    current = { ...current, ...next };
    if (reject === 'after-write') throw networkFailure();
    return jsonResponse(200, { data: { ...current } });
  });
  return { serverRow: () => current };
}

describe('クーポンの詳細: 状態の変更の通信が reject されたら読み直す (#2073 S7)', () => {
  const COUPON = {
    id: ROW_ID,
    code: 'REJECT2073',
    display_name: '応答の切れるクーポン',
    discount_type: 'fixed',
    discount_value: 500,
    applicable_to: 'all',
    applicable_plans: [],
    valid_from: '2026-10-01T00:00:00.000Z',
    valid_until: '2026-12-31T14:59:59.000Z',
    max_uses: 100,
    uses_count: 3,
    per_user_limit: 1,
    duration_months: null,
    gross_margin_preview_jpy: null,
    status: 'active',
    created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    created_at: '2026-10-01T00:00:00.000Z',
  };
  const PATH = `/api/super-admin/coupons/${ROW_ID}`;
  const TRANSITIONS = [
    ['active', 'paused'],
    ['paused', 'active'],
  ] as const;
  const statusError = () => container.querySelector('[data-testid="status-change-error"]')?.textContent ?? null;
  const server = (options: Partial<Parameters<typeof mockDetailServer>[0]> = {}) =>
    mockDetailServer({ path: PATH, row: COUPON, transitions: TRANSITIONS, invalidCode: 'OP_COUPON_INVALID_TRANSITION', ...options });
  const render = async () => {
    await renderElement(createElement(CouponDetailPage));
    await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
  };

  it('サーバーが一時停止を済ませてから応答が切れたら、読み直して「停止中」と「再開する」にし、自分の操作でも合う文を出す', async () => {
    const s = server({ rejectPatch: () => 'after-write' });
    await render();

    await click(findButton('一時停止'), '「一時停止」ボタン');

    expect(s.serverRow().status).toBe('paused');
    expect(callsOf('GET', PATH)).toHaveLength(2);
    expect(text()).toContain('停止中');
    expect(findButton('一時停止')).toBeUndefined();
    expect(findButton('再開する')?.disabled).toBe(false);
    expect(statusError()).toBe(`一時停止の応答を受け取れませんでした（通信エラー）。${STATE_RELOADED_GUIDE}`);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('読み直したあとに「再開する」を押すと、409 にならずに再開できる (「別の操作で…」は出ない)', async () => {
    const s = server({ rejectPatch: (n) => (n === 1 ? 'after-write' : undefined) });
    await render();
    await click(findButton('一時停止'), '「一時停止」ボタン');

    await click(findButton('再開する'), '「再開する」ボタン');

    expect(s.serverRow().status).toBe('active');
    expect(text()).toContain('有効');
    expect(text()).not.toContain(OTHER_OPERATION_WORDS);
  });

  it('読み直しにも失敗したら、その旨と「再試行」を出し、状態のボタンを止める。「再試行」で読み直せたら今の状態にしてボタンを戻す', async () => {
    const s = server({ rejectPatch: () => 'after-write', failGet: (n) => n === 2 });
    await render();

    await click(findButton('一時停止'), '「一時停止」ボタン');

    expect(s.serverRow().status).toBe('paused');
    expect(statusError()).toContain(`一時停止の応答を受け取れませんでした（通信エラー）。${STATE_RELOAD_FAILED_GUIDE}`);
    expect(findButton('一時停止')?.disabled).toBe(true);
    await forceClick(findButton('一時停止'), '「一時停止」ボタン');
    expect(callsOf('PATCH', PATH)).toHaveLength(1);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(text()).toContain('停止中');
    expect(statusError()).toBe(`一時停止の応答を受け取れませんでした（通信エラー）。${STATE_RELOADED_GUIDE}`);
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('再開する')?.disabled).toBe(false);
  });

  it('409 のあとの読み直しが失敗したときも「再試行」を出し、読み直せたら今の状態と読み直した旨の文にする', async () => {
    // 画面を開いたあとに別の操作で一時停止されていた。1 回目の PATCH (一時停止) は遷移表に無いので 409
    let gets = 0;
    let current: Record<string, unknown> = { ...COUPON };
    mockFetch((method) => {
      if (method === 'PATCH') {
        return jsonResponse(409, { error: { code: 'OP_COUPON_INVALID_TRANSITION', message: '状態は paused から paused へは変えられません' } });
      }
      gets += 1;
      if (gets === 1) {
        const first = { ...current };
        current = { ...current, status: 'paused' };
        return jsonResponse(200, { data: first });
      }
      if (gets === 2) return jsonResponse(500, { error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } });
      return jsonResponse(200, { data: { ...current } });
    });
    await render();

    await click(findButton('一時停止'), '「一時停止」ボタン');

    expect(statusError()).toBe(
      '一時停止できませんでした（別の操作でクーポンの状態が先に変わっていました。今の状態を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください）',
    );
    expect(findButton('一時停止')?.disabled).toBe(true);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(text()).toContain('停止中');
    expect(statusError()).toBe('一時停止できませんでした（別の操作でクーポンの状態が先に変わっていました。今の状態を読み込み直しました）');
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('再開する')?.disabled).toBe(false);
  });
});

describe('機能パッケージの詳細: 廃止の通信が reject されたら読み直す (#2073 S7)', () => {
  const FEATURE_PACKAGE = {
    id: ROW_ID,
    package_key: 'pkg_2073',
    display_name: '応答の切れるパッケージ',
    description: '説明',
    feature_flags: ['flag_a'],
    display_order: 2,
    status: 'active',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
  const PATH = `/api/super-admin/feature-packages/${ROW_ID}`;
  const TRANSITIONS = [['active', 'deprecated']] as const;
  const statusError = () => container.querySelector('[data-testid="status-change-error"]')?.textContent ?? null;
  const server = (options: Partial<Parameters<typeof mockDetailServer>[0]> = {}) =>
    mockDetailServer({
      path: PATH,
      row: FEATURE_PACKAGE,
      transitions: TRANSITIONS,
      invalidCode: 'OP_FEATURE_PACKAGE_INVALID_TRANSITION',
      ...options,
    });
  const render = async () => {
    await renderElement(createElement(FeaturePackageDetailPage));
    await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
  };

  it('サーバーが廃止を済ませてから応答が切れたら、読み直して「廃止」にし、「廃止する」を消す。自分の操作でも合う文を出す', async () => {
    const s = server({ rejectPatch: () => 'after-write' });
    await render();

    await click(findButton('廃止する'), '「廃止する」ボタン');

    expect(s.serverRow().status).toBe('deprecated');
    expect(callsOf('GET', PATH)).toHaveLength(2);
    expect(findButton('廃止する')).toBeUndefined();
    expect(statusError()).toBe(`廃止の応答を受け取れませんでした（通信エラー）。${STATE_RELOADED_GUIDE}`);
    expect(text()).not.toContain(OTHER_OPERATION_WORDS);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('読み直しにも失敗したら「再試行」を出し、「廃止する」を止める。「再試行」で読み直せたら今の状態にする', async () => {
    server({ rejectPatch: () => 'after-write', failGet: (n) => n === 2 });
    await render();

    await click(findButton('廃止する'), '「廃止する」ボタン');

    expect(statusError()).toBe(`廃止の応答を受け取れませんでした（通信エラー）。${STATE_RELOAD_FAILED_GUIDE}`);
    expect(findButton('廃止する')?.disabled).toBe(true);
    await forceClick(findButton('廃止する'), '「廃止する」ボタン');
    expect(callsOf('PATCH', PATH)).toHaveLength(1);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(findButton('廃止する')).toBeUndefined();
    expect(statusError()).toBe(`廃止の応答を受け取れませんでした（通信エラー）。${STATE_RELOADED_GUIDE}`);
    expect(findButton('再試行')).toBeUndefined();
  });

  it('409 のあとの読み直しが失敗したときも「再試行」を出す', async () => {
    server({ patchStatus: () => 409, failGet: (n) => n === 2 });
    await render();

    await click(findButton('廃止する'), '「廃止する」ボタン');

    expect(statusError()).toBe(
      '廃止できませんでした（別の操作で機能パッケージの状態が先に変わっていました。今の状態を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください）',
    );
    expect(findButton('再試行')?.disabled).toBe(false);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(statusError()).toBe('廃止できませんでした（別の操作で機能パッケージの状態が先に変わっていました。今の状態を読み込み直しました）');
    expect(findButton('再試行')).toBeUndefined();
  });
});

describe('A/B テストの詳細: 状態の変更の通信が reject されたら読み直す (#2073 と同じ型)', () => {
  const EXPERIMENT = {
    id: ROW_ID,
    key: 'reject_2073',
    name: '応答の切れる実験',
    hypothesis: null,
    status: 'running',
    start_date: null,
    end_date: null,
    variants: [
      { key: 'control', weight: 50 },
      { key: 'treatment', weight: 50 },
    ],
    primary_metric: null,
    created_at: '2026-10-01T00:00:00Z',
  };
  const PATH = `/api/super-admin/experiments/${ROW_ID}`;
  const noticeText = () => container.querySelector('[data-testid="experiment-reload-notice"] p')?.textContent ?? null;

  function mockExperimentServer(options: { failGet?: (n: number) => boolean; rejectPatch?: (n: number) => 'after-write' | undefined }) {
    let current: Record<string, unknown> = { ...EXPERIMENT };
    let gets = 0;
    let patches = 0;
    mockFetch((method, url, body) => {
      if (method === 'GET' && url.pathname === `${PATH}/results`) return jsonResponse(404, { error: { message: 'not found' } });
      if (url.pathname !== PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') {
        gets += 1;
        if (options.failGet?.(gets)) return jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' } });
        return jsonResponse(200, { data: { ...current } });
      }
      patches += 1;
      current = { ...current, ...(body as Record<string, unknown>) };
      if (options.rejectPatch?.(patches) === 'after-write') throw networkFailure();
      return jsonResponse(200, { data: { ...current } });
    });
    return { serverRow: () => current };
  }

  const renderDetail = () => renderElement(createElement(ExperimentDetailPage, { params: Promise.resolve({ id: ROW_ID }) }));

  it('サーバーが完了を済ませてから応答が切れたら、読み直して「完了」の状態にし、自分の操作でも合う文を出す (alert にしない)', async () => {
    const s = mockExperimentServer({ rejectPatch: () => 'after-write' });
    await renderDetail();

    await click(findButton('完了'), '「完了」ボタン');

    expect(s.serverRow().status).toBe('completed');
    expect(callsOf('GET', PATH)).toHaveLength(2);
    expect(findButton('完了')).toBeUndefined();
    expect(findButton('中止')).toBeUndefined();
    expect(noticeText()).toBe(
      `状態の変更の応答を受け取れませんでした（通信エラー）。今の状態（完了）を読み込み直したので、状態を確かめてから、必要ならもう一度操作してください`,
    );
    expect(text()).not.toContain(OTHER_OPERATION_WORDS);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('読み直しにも失敗したら「再試行」を出し、状態のボタンを止める。「再試行」で読み直せたら今の状態にする', async () => {
    mockExperimentServer({ rejectPatch: () => 'after-write', failGet: (n) => n === 2 });
    await renderDetail();

    await click(findButton('完了'), '「完了」ボタン');

    expect(noticeText()).toBe(`状態の変更の応答を受け取れませんでした（通信エラー）。${STATE_RELOAD_FAILED_GUIDE}`);
    expect(findButton('完了')?.disabled).toBe(true);
    expect(findButton('中止')?.disabled).toBe(true);
    await forceClick(findButton('中止'), '「中止」ボタン');
    expect(callsOf('PATCH', PATH)).toHaveLength(1);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(findButton('完了')).toBeUndefined();
    expect(noticeText()).toBe(
      `状態の変更の応答を受け取れませんでした（通信エラー）。今の状態（完了）を読み込み直したので、状態を確かめてから、必要ならもう一度操作してください`,
    );
    expect(findButton('再試行')).toBeUndefined();
  });
});

describe('A/B テストの一覧: 状態の変更の通信が reject されたら一覧を読み直す (#2073 と同じ型)', () => {
  const LIST_PATH = '/api/super-admin/experiments';
  const EXPERIMENT = {
    id: ROW_ID,
    key: 'reject_list_2073',
    name: '一覧の応答の切れる実験',
    status: 'draft',
    start_date: null,
    end_date: null,
    variants: [{ key: 'control', weight: 100 }],
    primary_metric: null,
    created_at: '2026-10-01T00:00:00Z',
  };
  const noticeText = () => container.querySelector('[data-testid="experiment-reload-notice"] p')?.textContent ?? null;

  function mockListServer(options: { failGet?: (n: number) => boolean }) {
    let current: Record<string, unknown> = { ...EXPERIMENT };
    let gets = 0;
    mockFetch((method, url, body) => {
      if (method === 'GET' && url.pathname === LIST_PATH) {
        gets += 1;
        if (options.failGet?.(gets)) return jsonResponse(500, { error: { message: 'サーバーエラーが発生しました' } });
        return jsonResponse(200, { data: [{ ...current }] });
      }
      if (method === 'PATCH' && url.pathname === `${LIST_PATH}/${ROW_ID}`) {
        current = { ...current, ...(body as Record<string, unknown>) };
        throw networkFailure();
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    return { serverRow: () => current };
  }

  it('サーバーが開始を済ませてから応答が切れたら、一覧を読み直して「実行中」にし、自分の操作でも合う文を出す', async () => {
    const s = mockListServer({});
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('開始'), '「開始」ボタン');

    expect(s.serverRow().status).toBe('running');
    expect(callsOf('GET', LIST_PATH)).toHaveLength(2);
    expect(text()).toContain('実行中');
    expect(findButton('開始')).toBeUndefined();
    expect(findButton('完了')?.disabled).toBe(false);
    expect(noticeText()).toBe(
      `「${EXPERIMENT.name}」の状態の変更の応答を受け取れませんでした（通信エラー）。${LIST_RELOADED_GUIDE}`,
    );
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('一覧の読み直しにも失敗したら「再試行」を出し、状態のボタンを止める。「再試行」で読み直せたら今の状態にする', async () => {
    mockListServer({ failGet: (n) => n === 2 });
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('開始'), '「開始」ボタン');

    expect(noticeText()).toBe(
      `「${EXPERIMENT.name}」の状態の変更の応答を受け取れませんでした（通信エラー）。${LIST_RELOAD_FAILED_GUIDE}`,
    );
    expect(findButton('開始')?.disabled).toBe(true);
    await forceClick(findButton('開始'), '「開始」ボタン');
    expect(callsOf('PATCH', `${LIST_PATH}/${ROW_ID}`)).toHaveLength(1);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(text()).toContain('実行中');
    expect(noticeText()).toBe(
      `「${EXPERIMENT.name}」の状態の変更の応答を受け取れませんでした（通信エラー）。${LIST_RELOADED_GUIDE}`,
    );
    expect(findButton('完了')?.disabled).toBe(false);
  });
});

describe('機能フラグの一覧: 切り替え・削除の通信が reject されたら一覧を読み直す (#2073 と同じ型)', () => {
  const LIST_PATH = '/api/super-admin/flags';
  const FLAG_NAME = 'reject_flag_2073';
  const flagRow = (enabled: boolean) => ({
    key: FLAG_NAME,
    description: '',
    enabled,
    rollout_strategy: null,
    constraints: null,
    active_user_count: 0,
    updated_at: '2026-10-10T00:00:00Z',
  });
  const noticeText = () => container.querySelector('[data-testid="flags-reload-notice"]')?.textContent ?? null;
  const rowOf = () =>
    Array.from(container.querySelectorAll('tbody tr')).find((tr) => tr.querySelector('code')?.textContent === FLAG_NAME) as
      | HTMLTableRowElement
      | undefined;
  const toggle = () => rowOf()?.querySelectorAll('button')[0] as HTMLButtonElement | undefined;
  const deleteButton = () => Array.from(rowOf()?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === '削除');
  const shownState = () => {
    const row = rowOf();
    if (!row) return 'absent';
    return row.textContent?.includes('ON') ? 'ON' : 'OFF';
  };

  /** サーバーのフラグ (null は削除済み)。PATCH / DELETE は書いてから reject する。failGet(n) の GET は 500 */
  function mockFlagsServer(options: { failGet?: (n: number) => boolean }) {
    let current: boolean | null = false;
    let gets = 0;
    mockFetch((method, url, body) => {
      if (method === 'GET' && url.pathname === LIST_PATH) {
        gets += 1;
        if (options.failGet?.(gets)) return jsonResponse(500, { error: { message: 'サーバーエラーが発生しました' } });
        return jsonResponse(200, { data: current === null ? [] : [flagRow(current)] });
      }
      if (url.pathname === `${LIST_PATH}/${FLAG_NAME}` && method === 'PATCH') {
        current = (body as { enabled: boolean }).enabled;
        throw networkFailure();
      }
      if (url.pathname === `${LIST_PATH}/${FLAG_NAME}` && method === 'DELETE') {
        current = null;
        throw networkFailure();
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    return { serverState: () => current };
  }

  it('サーバーが切り替えを済ませてから応答が切れたら、一覧を読み直して ON を出し、自分の操作でも合う文を出す (alert にしない)', async () => {
    const s = mockFlagsServer({});
    await renderElement(createElement(FlagsPage));
    expect(shownState()).toBe('OFF');

    await click(toggle(), '切り替えのボタン');

    expect(s.serverState()).toBe(true);
    expect(callsOf('GET', LIST_PATH)).toHaveLength(2);
    expect(shownState()).toBe('ON');
    expect(noticeText()).toBe(`「${FLAG_NAME}」の切り替えの応答を受け取れませんでした（通信エラー）。${LIST_RELOADED_GUIDE}`);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('サーバーが削除を済ませてから応答が切れたら、一覧を読み直してそのフラグを消し、自分の操作でも合う文を出す', async () => {
    const s = mockFlagsServer({});
    await renderElement(createElement(FlagsPage));

    await click(deleteButton(), '「削除」ボタン');

    expect(s.serverState()).toBeNull();
    expect(callsOf('GET', LIST_PATH)).toHaveLength(2);
    expect(shownState()).toBe('absent');
    expect(noticeText()).toBe(`「${FLAG_NAME}」の削除の応答を受け取れませんでした（通信エラー）。${LIST_RELOADED_GUIDE}`);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('一覧の読み直しにも失敗したら「再試行」を出し、切り替えと削除を止める。「再試行」で読み直せたら今の値にする', async () => {
    mockFlagsServer({ failGet: (n) => n === 2 });
    await renderElement(createElement(FlagsPage));

    await click(toggle(), '切り替えのボタン');

    expect(noticeText()).toBe(`「${FLAG_NAME}」の切り替えの応答を受け取れませんでした（通信エラー）。${LIST_RELOAD_FAILED_GUIDE}`);
    expect(shownState()).toBe('OFF');
    expect(toggle()?.disabled).toBe(true);
    expect(deleteButton()?.disabled).toBe(true);
    await forceClick(toggle(), '切り替えのボタン');
    expect(callsOf('PATCH', `${LIST_PATH}/${FLAG_NAME}`)).toHaveLength(1);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(shownState()).toBe('ON');
    expect(noticeText()).toBe(`「${FLAG_NAME}」の切り替えの応答を受け取れませんでした（通信エラー）。${LIST_RELOADED_GUIDE}`);
    expect(toggle()?.disabled).toBe(false);
    expect(findButton('再試行')).toBeUndefined();
  });
});

describe('メール送信の一覧: 再送の通信が reject されたら一覧を読み直す (#2073 と同じ型)', () => {
  const LIST_PATH = '/api/super-admin/email-outbox';
  const REQUEUE_PATH = `${LIST_PATH}/${ROW_ID}/requeue`;
  const TEMPLATE = 'family_invite';
  const CREATED_AT = '2026-10-16T05:00:01.000000+00:00';
  /** route の 409 (dead でない行の再送) の文。自分の再送が済んでいたのにこれが出てはいけない */
  const NOT_REQUEUEABLE_MESSAGE = '届けられなかったメールだけを再送できます';
  /** 一覧の行の見分け (1 行目 = ROW_ID。2 行の画面の試験は 2 行目も使う) */
  interface OutboxRowKey {
    id: string;
    template: string;
    createdAt: string;
  }
  const ROW_A: OutboxRowKey = { id: ROW_ID, template: TEMPLATE, createdAt: CREATED_AT };
  const outboxRowOf = (row: OutboxRowKey, status: 'dead' | 'queued') => ({
    id: row.id,
    created_at: row.createdAt,
    updated_at: row.createdAt,
    status,
    template: row.template,
    recipient: 't***@example.com',
    redacted: false,
    user_id: null,
    attempts: status === 'dead' ? 1 : 0,
    requeue_count: status === 'dead' ? 0 : 1,
    next_attempt_at: row.createdAt,
    lease_expires_at: null,
    last_error_code: 'validation_error',
    last_error_message: 'The domain is not verified',
    last_status_code: 403,
    sent_at: null,
    dead_at: status === 'dead' ? row.createdAt : null,
    requeued_at: status === 'dead' ? null : row.createdAt,
  });
  const outboxRow = (status: 'dead' | 'queued') => outboxRowOf(ROW_A, status);
  const noticeText = () => container.querySelector('[data-testid="email-outbox-reload-notice"] p')?.textContent ?? null;
  const noticeRole = () => container.querySelector('[data-testid="email-outbox-reload-notice"] p')?.getAttribute('role') ?? null;
  const tableRows = () => Array.from(container.querySelectorAll('tbody tr'));
  const rowOfTemplate = (template: string) => tableRows().find((tr) => tr.textContent?.includes(template));
  const requeueButtonOf = (template: string) =>
    Array.from(rowOfTemplate(template)?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === '再送') as
      | HTMLButtonElement
      | undefined;
  const rowOf = () => rowOfTemplate(TEMPLATE);
  const requeueButton = () => requeueButtonOf(TEMPLATE);

  /**
   * サーバーの代わり。GET は今の行を status の絞り込みどおりに返す (route と同じく、絞り込みに合わない行は返さない)。
   * POST は dead の行だけ queued にする (dead でなければ 409 not_dead)。rejectPost(n) が 'after-write' の n 回目の POST は、
   * 書いてから reject する (応答が切れた)。'before-write' なら書かずに reject する。failGet(n) が true の n 回目の GET は 500
   */
  function mockOutboxServer(options: {
    rejectPost?: (n: number) => 'after-write' | 'before-write' | undefined;
    failGet?: (n: number) => boolean;
    /** 先頭のページ (cursor なし) の GET が返す続きのカーソル。続きのページ (cursor あり) は空で返す */
    nextCursor?: string;
    /** true の n 回目の GET は、返したあとに得られる release() を呼ぶまで応答を止める */
    holdGet?: (n: number) => boolean;
  }) {
    let current: 'dead' | 'queued' = 'dead';
    let gets = 0;
    let posts = 0;
    const held: Array<() => void> = [];
    mockFetch(async (method, url) => {
      if (method === 'GET' && url.pathname === LIST_PATH) {
        gets += 1;
        if (options.holdGet?.(gets)) await new Promise<void>((resolve) => held.push(resolve));
        if (options.failGet?.(gets)) return jsonResponse(500, { error: { message: '内部エラー' } });
        if (url.searchParams.has('cursor')) {
          return jsonResponse(200, { data: [], meta: { limit: 50, has_more: false, next_cursor: null } });
        }
        const data = url.searchParams.get('status') === current ? [outboxRow(current)] : [];
        const nextCursor = options.nextCursor ?? null;
        return jsonResponse(200, { data, meta: { limit: 50, has_more: nextCursor !== null, next_cursor: nextCursor } });
      }
      if (method === 'POST' && url.pathname === REQUEUE_PATH) {
        posts += 1;
        const reject = options.rejectPost?.(posts);
        if (reject === 'before-write') throw networkFailure();
        if (current !== 'dead') {
          return jsonResponse(409, {
            error: { code: 'OP_EMAIL_OUTBOX_NOT_REQUEUEABLE', message: NOT_REQUEUEABLE_MESSAGE, details: { reason: 'not_dead' } },
          });
        }
        current = 'queued';
        if (reject === 'after-write') throw networkFailure();
        return jsonResponse(200, { data: { id: ROW_ID, status: 'queued' } });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    return {
      serverStatus: () => current,
      /** 止めている GET の応答を全部返す */
      releaseHeld: () => held.splice(0).forEach((release) => release()),
    };
  }

  it('サーバーが再送を済ませてから応答が切れたら、一覧を読み直して今の状態を見せ、自分の操作でも合う文を出す (通信の失敗の alert にしない)', async () => {
    const s = mockOutboxServer({ rejectPost: () => 'after-write' });
    await renderElement(createElement(EmailOutboxPage));
    expect(requeueButton()?.disabled).toBe(false);

    await click(requeueButton(), '「再送」ボタン');

    expect(s.serverStatus()).toBe('queued');
    expect(callsOf('GET', LIST_PATH)).toHaveLength(2);
    // 届けられなかったものの一覧を読み直したので、送信待ちに移った行は一覧から外れ、「再送」も押せない (押しても 409 にならない)
    expect(rowOf()).toBeUndefined();
    expect(requeueButton()).toBeUndefined();
    expect(noticeText()).toBe(`「${TEMPLATE}」の再送の応答を受け取れませんでした（通信エラー）。${LIST_RELOADED_GUIDE}`);
    expect(noticeRole()).toBe('status');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(text()).not.toContain('通信に失敗しました');
    expect(findButton('再試行')).toBeUndefined();
    expect(alertSpy).not.toHaveBeenCalled();

    // 送信待ちで絞り込むと、その行が「送信待ち」で見える (読み直した今の状態)
    await click(container.querySelector('#email-outbox-status-queued') as HTMLInputElement, '「送信待ち」の選択肢');
    await click(findButton('絞り込む'), '「絞り込む」ボタン');
    expect(rowOf()?.textContent).toContain('送信待ち');
  });

  it('サーバーが書く前に応答が切れたら、読み直した一覧で「再送」を押し直せ、409 にならずに再送できる', async () => {
    const s = mockOutboxServer({ rejectPost: (n) => (n === 1 ? 'before-write' : undefined) });
    await renderElement(createElement(EmailOutboxPage));

    await click(requeueButton(), '「再送」ボタン');

    expect(s.serverStatus()).toBe('dead');
    expect(callsOf('GET', LIST_PATH)).toHaveLength(2);
    expect(noticeText()).toBe(`「${TEMPLATE}」の再送の応答を受け取れませんでした（通信エラー）。${LIST_RELOADED_GUIDE}`);
    expect(requeueButton()?.disabled).toBe(false);

    await click(requeueButton(), '「再送」ボタン');

    expect(s.serverStatus()).toBe('queued');
    expect(callsOf('POST', REQUEUE_PATH)).toHaveLength(2);
    expect(text()).not.toContain(NOT_REQUEUEABLE_MESSAGE);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('再送を受け付けました');
    expect(noticeText()).toBeNull();
  });

  it('一覧の読み直しにも失敗したら、一覧を残して「再試行」を出し、「再送」を止める。「再試行」で読み直せたら今の状態にする', async () => {
    const s = mockOutboxServer({ rejectPost: () => 'after-write', failGet: (n) => n === 2 });
    await renderElement(createElement(EmailOutboxPage));

    await click(requeueButton(), '「再送」ボタン');

    expect(s.serverStatus()).toBe('queued');
    expect(noticeText()).toBe(`「${TEMPLATE}」の再送の応答を受け取れませんでした（通信エラー）。${LIST_RELOAD_FAILED_GUIDE}`);
    expect(noticeRole()).toBe('alert');
    // 一覧は外さずに残す (読み直しの失敗で空にしない)。ただし状態が古いかもしれないので「再送」は止める
    expect(rowOf()?.textContent).toContain('届けられなかった');
    expect(requeueButton()?.disabled).toBe(true);
    await forceClick(requeueButton(), '「再送」ボタン');
    expect(callsOf('POST', REQUEUE_PATH)).toHaveLength(1);
    expect(text()).not.toContain(NOT_REQUEUEABLE_MESSAGE);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(callsOf('GET', LIST_PATH)).toHaveLength(3);
    expect(rowOf()).toBeUndefined();
    expect(noticeText()).toBe(`「${TEMPLATE}」の再送の応答を受け取れませんでした（通信エラー）。${LIST_RELOADED_GUIDE}`);
    expect(findButton('再試行')).toBeUndefined();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('読み直しの最中は「さらに読み込む」を止める (続きの読み込みが読み直しを追い越して、古い行と「再送」が知らせも無く残らない)', async () => {
    const s = mockOutboxServer({ rejectPost: () => 'after-write', nextCursor: 'cursor-2', holdGet: (n) => n === 2 });
    await renderElement(createElement(EmailOutboxPage));
    expect(findButton('さらに読み込む')?.disabled).toBe(false);

    await click(requeueButton(), '「再送」ボタン');

    // 読み直しの GET が応答を待っているあいだ: 一覧は残すが、「さらに読み込む」は止める (押しても続きを読まない)
    expect(s.serverStatus()).toBe('queued');
    expect(callsOf('GET', LIST_PATH)).toHaveLength(2);
    expect(rowOf()?.textContent).toContain('届けられなかった');
    expect(findButton('さらに読み込む')?.disabled).toBe(true);
    await forceClick(findButton('さらに読み込む'), '「さらに読み込む」ボタン');
    const cursorCalls = () =>
      callsOf('GET', LIST_PATH).filter(([input]) => new URL(String(input), 'http://localhost').searchParams.has('cursor'));
    expect(cursorCalls()).toHaveLength(0);

    await act(async () => {
      s.releaseHeld();
    });
    await settle();

    // 読み直しの結果が捨てられずに一覧が今の状態になり、自分の操作でも合う文が出る
    expect(callsOf('GET', LIST_PATH)).toHaveLength(2);
    expect(rowOf()).toBeUndefined();
    expect(requeueButton()).toBeUndefined();
    expect(noticeText()).toBe(`「${TEMPLATE}」の再送の応答を受け取れませんでした（通信エラー）。${LIST_RELOADED_GUIDE}`);
    // 読み直しのあとは続きを読める (読み直しで先頭のページの続きのカーソルを取り直す)
    expect(findButton('さらに読み込む')?.disabled).toBe(false);
    await click(findButton('さらに読み込む'), '「さらに読み込む」ボタン');
    expect(cursorCalls()).toHaveLength(1);
    expect(new URL(String(cursorCalls()[0][0]), 'http://localhost').searchParams.get('cursor')).toBe('cursor-2');
  });

  it('「再試行」で読み直したあとは「再送」を戻す (書く前に切れていた行はもう一度再送できる)', async () => {
    const s = mockOutboxServer({ rejectPost: (n) => (n === 1 ? 'before-write' : undefined), failGet: (n) => n === 2 });
    await renderElement(createElement(EmailOutboxPage));

    await click(requeueButton(), '「再送」ボタン');
    expect(requeueButton()?.disabled).toBe(true);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(requeueButton()?.disabled).toBe(false);
    await click(requeueButton(), '「再送」ボタン');
    expect(s.serverStatus()).toBe('queued');
    expect(callsOf('POST', REQUEUE_PATH)).toHaveLength(2);
  });

  describe('再送は 1 行ずつで、一覧の読み込みと重ねない (3 周目のレビューの指摘: 読み直しの最中にほかの行を再送できた)', () => {
    const ROW_B: OutboxRowKey = {
      id: '20732073-2073-4073-8073-207320732075',
      template: 'support_ticket_reply',
      createdAt: '2026-10-16T05:00:00.000000+00:00',
    };
    const requeuePathOf = (id: string) => `${LIST_PATH}/${id}/requeue`;
    const filterForm = () => container.querySelector('form[aria-label="メールの絞り込み"]') as HTMLFormElement | null;

    /**
     * 2 行 (A = ROW_A・B = ROW_B。どちらも dead) のサーバーの代わり。GET は今の行を status の絞り込みどおりに新しい順で返す。
     * GET は、届いた時点の行を読んでから止める (holdGet が true の n 回目は releaseHeld まで応答を返さない)。止めているあいだに
     * ほかの行の再送が書かれても、その GET は書かれる前の行を返す (読み直しの GET が再送の書き込みより先に読まれた)。
     * POST は dead の行だけ queued にする (dead でなければ 409 not_dead)。holdPost が true の POST は releaseHeld まで
     * 書かずに止める。rejectPost が 'after-write' の POST は、書いてから reject する (応答が切れた)
     */
    function mockTwoRowOutboxServer(options: {
      rejectPost?: (id: string) => 'after-write' | undefined;
      holdPost?: (id: string) => boolean;
      holdGet?: (n: number) => boolean;
      nextCursor?: string;
    }) {
      const current = new Map<string, 'dead' | 'queued'>([
        [ROW_A.id, 'dead'],
        [ROW_B.id, 'dead'],
      ]);
      let gets = 0;
      const held: Array<() => void> = [];
      const hold = () => new Promise<void>((resolve) => held.push(resolve));
      mockFetch(async (method, url) => {
        if (method === 'GET' && url.pathname === LIST_PATH) {
          gets += 1;
          if (url.searchParams.has('cursor')) {
            return jsonResponse(200, { data: [], meta: { limit: 50, has_more: false, next_cursor: null } });
          }
          const wanted = url.searchParams.get('status');
          const data = [ROW_A, ROW_B]
            .filter((row) => current.get(row.id) === wanted)
            .map((row) => outboxRowOf(row, current.get(row.id) ?? 'dead'));
          if (options.holdGet?.(gets)) await hold();
          const nextCursor = options.nextCursor ?? null;
          return jsonResponse(200, { data, meta: { limit: 50, has_more: nextCursor !== null, next_cursor: nextCursor } });
        }
        const row = [ROW_A, ROW_B].find((r) => method === 'POST' && url.pathname === requeuePathOf(r.id));
        if (row) {
          if (options.holdPost?.(row.id)) await hold();
          if (current.get(row.id) !== 'dead') {
            return jsonResponse(409, {
              error: { code: 'OP_EMAIL_OUTBOX_NOT_REQUEUEABLE', message: NOT_REQUEUEABLE_MESSAGE, details: { reason: 'not_dead' } },
            });
          }
          current.set(row.id, 'queued');
          if (options.rejectPost?.(row.id) === 'after-write') throw networkFailure();
          return jsonResponse(200, { data: { id: row.id, status: 'queued' } });
        }
        throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      });
      return {
        serverStatusOf: (id: string) => current.get(id),
        /** 止めている GET / POST の応答を全部進める */
        releaseHeld: () => held.splice(0).forEach((release) => release()),
      };
    }

    async function release(s: { releaseHeld: () => void }) {
      await act(async () => {
        s.releaseHeld();
      });
      await settle();
    }

    it('A の再送の reject のあとの読み直しの最中は、B の「再送」も止める (読み直しの古い一覧が B の再送の成功を上書きしない)', async () => {
      const s = mockTwoRowOutboxServer({
        rejectPost: (id) => (id === ROW_A.id ? 'after-write' : undefined),
        holdGet: (n) => n === 2,
      });
      await renderElement(createElement(EmailOutboxPage));
      expect(requeueButtonOf(ROW_B.template)?.disabled).toBe(false);

      await click(requeueButtonOf(ROW_A.template), '「再送」ボタン (A)');

      // 読み直しの GET が応答を待っているあいだ: 一覧は残すが、B の「再送」も止める (押しても送らない)
      expect(s.serverStatusOf(ROW_A.id)).toBe('queued');
      expect(callsOf('GET', LIST_PATH)).toHaveLength(2);
      expect(rowOfTemplate(ROW_B.template)?.textContent).toContain('届けられなかった');
      expect(requeueButtonOf(ROW_B.template)?.disabled).toBe(true);
      await forceClick(requeueButtonOf(ROW_B.template), '「再送」ボタン (B)');
      expect(callsOf('POST', requeuePathOf(ROW_B.id))).toHaveLength(0);
      expect(s.serverStatusOf(ROW_B.id)).toBe('dead');

      await release(s);

      // 知らせと一覧は読み直しの結果 (A は送信待ちに移って一覧から外れ、B は届けられなかったのまま)
      expect(rowOfTemplate(ROW_A.template)).toBeUndefined();
      expect(rowOfTemplate(ROW_B.template)?.textContent).toContain('届けられなかった');
      expect(noticeText()).toBe(`「${ROW_A.template}」の再送の応答を受け取れませんでした（通信エラー）。${LIST_RELOADED_GUIDE}`);
      // 読み直しのあとは B を再送でき、409 にならない
      expect(requeueButtonOf(ROW_B.template)?.disabled).toBe(false);
      await click(requeueButtonOf(ROW_B.template), '「再送」ボタン (B)');
      expect(s.serverStatusOf(ROW_B.id)).toBe('queued');
      expect(callsOf('POST', requeuePathOf(ROW_B.id))).toHaveLength(1);
      expect(rowOfTemplate(ROW_B.template)?.textContent).toContain('送信待ち');
      expect(container.querySelector('[role="status"]')?.textContent).toBe('再送を受け付けました');
      expect(text()).not.toContain(NOT_REQUEUEABLE_MESSAGE);
    });

    it('再送の応答を待つあいだは、ほかの行の「再送」と一覧の読み込み (「絞り込む」「再読み込み」「さらに読み込む」) を止める', async () => {
      const s = mockTwoRowOutboxServer({ holdPost: (id) => id === ROW_A.id, nextCursor: 'cursor-2' });
      await renderElement(createElement(EmailOutboxPage));
      expect(findButton('再読み込み')?.disabled).toBe(false);
      expect(findButton('さらに読み込む')?.disabled).toBe(false);

      await click(requeueButtonOf(ROW_A.template), '「再送」ボタン (A)');

      // A の POST が応答を待っているあいだ: B の「再送」と一覧の読み込みのボタンを止め、押されても (送信の操作でも) 送らない
      expect(callsOf('POST', requeuePathOf(ROW_A.id))).toHaveLength(1);
      expect(requeueButtonOf(ROW_A.template)?.disabled).toBe(true);
      expect(requeueButtonOf(ROW_B.template)?.disabled).toBe(true);
      expect(findButton('絞り込む')?.disabled).toBe(true);
      expect(findButton('再読み込み')?.disabled).toBe(true);
      expect(findButton('さらに読み込む')?.disabled).toBe(true);
      await forceClick(requeueButtonOf(ROW_B.template), '「再送」ボタン (B)');
      await forceClick(findButton('再読み込み'), '「再読み込み」ボタン');
      await forceClick(findButton('さらに読み込む'), '「さらに読み込む」ボタン');
      expect(filterForm(), '絞り込みのフォームが見つからない').not.toBeNull();
      await act(async () => {
        filterForm()!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await settle();
      expect(callsOf('POST', requeuePathOf(ROW_B.id))).toHaveLength(0);
      expect(callsOf('GET', LIST_PATH)).toHaveLength(1);

      await release(s);

      // A の再送の成功の描き替えと知らせが残る (あとから届いた一覧で上書きされない)。ボタンは戻る
      expect(s.serverStatusOf(ROW_A.id)).toBe('queued');
      expect(rowOfTemplate(ROW_A.template)?.textContent).toContain('送信待ち');
      expect(requeueButtonOf(ROW_A.template)).toBeUndefined();
      expect(container.querySelector('[role="status"]')?.textContent).toBe('再送を受け付けました');
      expect(requeueButtonOf(ROW_B.template)?.disabled).toBe(false);
      expect(findButton('絞り込む')?.disabled).toBe(false);
      expect(findButton('再読み込み')?.disabled).toBe(false);
      expect(findButton('さらに読み込む')?.disabled).toBe(false);
    });

    it('再描画の前に続けて押しても (同じ act の中の押下)、再送どうし・再送と一覧の読み込みを重ねない', async () => {
      const s = mockTwoRowOutboxServer({ holdPost: () => true });
      await renderElement(createElement(EmailOutboxPage));
      const buttonA = requeueButtonOf(ROW_A.template);
      const buttonB = requeueButtonOf(ROW_B.template);
      const reloadButton = findButton('再読み込み');
      expect(buttonA && buttonB && reloadButton, '「再送」(A・B) と「再読み込み」が見つからない').toBeTruthy();

      // A の「再送」の直後に B の「再送」と「再読み込み」: A の POST だけを送る
      await act(async () => {
        buttonA!.click();
        buttonB!.click();
        reloadButton!.click();
      });
      await settle();
      expect(callsOf('POST', requeuePathOf(ROW_A.id))).toHaveLength(1);
      expect(callsOf('POST', requeuePathOf(ROW_B.id))).toHaveLength(0);
      expect(callsOf('GET', LIST_PATH)).toHaveLength(1);
      await release(s);
      expect(container.querySelector('[role="status"]')?.textContent).toBe('再送を受け付けました');

      // 「再読み込み」の直後に B の「再送」: 一覧の読み込みだけを出す
      const buttonBAfter = requeueButtonOf(ROW_B.template);
      const reloadAfter = findButton('再読み込み');
      expect(buttonBAfter && reloadAfter, '「再送」(B) と「再読み込み」が見つからない').toBeTruthy();
      await act(async () => {
        reloadAfter!.click();
        buttonBAfter!.click();
      });
      await settle();
      expect(callsOf('GET', LIST_PATH)).toHaveLength(2);
      expect(callsOf('POST', requeuePathOf(ROW_B.id))).toHaveLength(0);
      expect(s.serverStatusOf(ROW_B.id)).toBe('dead');
    });
  });
});
