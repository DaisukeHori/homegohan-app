/**
 * #2080 U7・U8: 運営の画面で、状態の変更のあとの読み直しの取りこぼし (#2073 の続き)
 *
 * U7 A/B テストの詳細 (/super-admin/experiments/[id]):
 *   - 状態の変更が 200 で返ったのに本文を読み切れない (JSON でない・data が無い) と、以前は読み直さず、古い状態のまま知らせも出なかった。
 *     変更は済んでいるのに画面は古い状態のボタンを出し、押すと 409 になって自分の操作を「別の操作で…」と言われる。
 *     直したあとは、通信の reject と同じく今の状態を読み直して「状態の変更の応答を受け取れませんでした（通信エラー）」に続けて今の状態を出す
 *     (クーポン・機能パッケージは本文の読み失敗も catch で同じ読み直しに入る)。
 *   - 409 のあとの読み直しが失敗しても、以前は状態のボタンを押せた (通信の reject のあとだけ止めていた)。
 *     直したあとは、読み直しが失敗して「再試行」を出しているあいだは、どちらの理由でも状態のボタンを止める (押しても送らない)。
 *     A/B テストの一覧 (/super-admin/experiments) も同じ型なので同じに直す。
 *
 * U8 クーポンの詳細・機能パッケージの詳細:
 *   - 状態の変更のあとの読み直し (409 のあと・通信の reject のあと) が 404 / 403 で断られても、以前は「再試行」を出し、
 *     状態のボタンを止め続けた (読み直しても変わらないので、何度押しても読めず、ボタンも戻らない)。
 *     直したあとは、プラン・A/B テストの詳細と同じく、404 は「見つかりません」、403 は理由の文 (二段階認証の確認が要る など。
 *     理由でなければ「権限がありません」) を出し、「再試行」は出さず、ボタンを戻す。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROW_ID = '20802080-2080-4080-8080-208020802080';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: ROW_ID }),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: CouponDetailPage } = await import('@/app/super-admin/coupons/[id]/page');
const { default: FeaturePackageDetailPage } = await import('@/app/super-admin/feature-packages/[id]/page');
const { default: ExperimentDetailPage } = await import('@/app/super-admin/experiments/[id]/page');
const { default: ExperimentsPage } = await import('@/app/super-admin/experiments/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 詳細の画面で、今の状態の読み直しにも失敗したときに続く文 */
const STATE_RELOAD_FAILED_GUIDE = '今の状態を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください';
/** 403 の理由の文 (二段階認証の確認が要る。src/lib/api/forbidden-reason-messages.ts の API_MFA_REQUIRED_MESSAGE) */
const MFA_REQUIRED_MESSAGE = '二段階認証の確認が必要です';
/** 403 の本文の文が理由の文でないときの画面の文 (FORBIDDEN_SCREEN_MESSAGE) */
const FORBIDDEN_MESSAGE = '権限がありません';
/** 画面に出してはいけない、英字の内部の値の例 (403 の本文の理由でない文) */
const RAW_FORBIDDEN_TEXT = 'permission denied for super_admin';

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

/** n 回目の GET (1 から) の応答の決め方。undefined は今の行を 200 で返す */
type GetOverride = (n: number) => Response | undefined;

/**
 * 詳細の画面 (クーポン・機能パッケージ) のサーバーの代わり。GET は今の行を返す (getOverride が応答を返せばそれを返す)。
 * PATCH は patch(n) が 'reject-after-write' なら書いてから reject、'conflict' なら書かずに 409 invalidCode、
 * undefined なら書いて 200 で返す
 */
function mockDetailServer(options: {
  path: string;
  row: Record<string, unknown>;
  invalidCode: string;
  patch: (n: number) => 'reject-after-write' | 'conflict' | undefined;
  getOverride?: GetOverride;
}) {
  let current = { ...options.row };
  let gets = 0;
  let patches = 0;
  mockFetch((method, url, body) => {
    if (url.pathname !== options.path) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    if (method === 'GET') {
      gets += 1;
      return options.getOverride?.(gets) ?? jsonResponse(200, { data: { ...current } });
    }
    if (method !== 'PATCH') throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    patches += 1;
    const mode = options.patch(patches);
    if (mode === 'conflict') {
      return jsonResponse(409, { error: { code: options.invalidCode, message: `状態は ${String(current.status)} から変えられません` } });
    }
    current = { ...current, ...(body as Record<string, unknown>) };
    if (mode === 'reject-after-write') throw networkFailure();
    return jsonResponse(200, { data: { ...current } });
  });
  return { serverRow: () => current };
}

const notFoundResponse = () => jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Coupon not found' } });
const mfaForbiddenResponse = () => jsonResponse(403, { error: { code: 'AUTH_2FA_REQUIRED', message: MFA_REQUIRED_MESSAGE } });
const rawForbiddenResponse = () => jsonResponse(403, { error: { code: 'OP_PERMISSION_DENIED', message: RAW_FORBIDDEN_TEXT } });
const serverErrorResponse = () => jsonResponse(500, { error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } });

describe('クーポンの詳細: 状態の変更のあとの読み直しが 404 / 403 なら理由を出し、「再試行」を出さずにボタンを戻す (#2080 U8)', () => {
  const COUPON = {
    id: ROW_ID,
    code: 'RELOAD2080',
    display_name: '読み直しの断られるクーポン',
    discount_type: 'fixed',
    discount_value: 500,
    applicable_to: 'all',
    applicable_plans: [],
    valid_from: '2026-10-01T00:00:00.000Z',
    valid_until: '2026-12-31T14:59:59.000Z',
    max_uses: 100,
    uses_count: 0,
    per_user_limit: 1,
    duration_months: null,
    gross_margin_preview_jpy: null,
    status: 'active',
    created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    created_at: '2026-10-01T00:00:00.000Z',
  };
  const PATH = `/api/super-admin/coupons/${ROW_ID}`;
  const NOT_FOUND_MESSAGE = 'クーポンが見つかりません。一覧に戻って確かめてください';
  const statusError = () => container.querySelector('[data-testid="status-change-error"]')?.textContent ?? null;
  const server = (options: { patch: Parameters<typeof mockDetailServer>[0]['patch']; getOverride?: GetOverride }) =>
    mockDetailServer({ path: PATH, row: COUPON, invalidCode: 'OP_COUPON_INVALID_TRANSITION', ...options });
  const render = async () => {
    await renderElement(createElement(CouponDetailPage));
    await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
  };

  it('通信の reject のあとの読み直しが 404 (クーポンが消えた) なら「見つかりません」を出し、「再試行」は出さず、状態のボタンを戻す', async () => {
    server({ patch: () => 'reject-after-write', getOverride: (n) => (n === 2 ? notFoundResponse() : undefined) });
    await render();

    await click(findButton('一時停止'), '「一時停止」ボタン');

    expect(callsOf('GET', PATH)).toHaveLength(2);
    expect(statusError()).toBe(`一時停止の応答を受け取れませんでした（通信エラー）。${NOT_FOUND_MESSAGE}`);
    expect(statusError()).not.toContain('再試行');
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('一時停止')?.disabled).toBe(false);
    expect(text()).not.toContain('Coupon not found');
  });

  it('409 のあとの読み直しが 403 (二段階認証の確認が要る) なら、その理由の文を出し、「再試行」は出さず、状態のボタンを戻す', async () => {
    server({ patch: () => 'conflict', getOverride: (n) => (n === 2 ? mfaForbiddenResponse() : undefined) });
    await render();

    await click(findButton('一時停止'), '「一時停止」ボタン');

    expect(statusError()).toBe(`一時停止できませんでした（別の操作でクーポンの状態が先に変わっていました。${MFA_REQUIRED_MESSAGE}）`);
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('一時停止')?.disabled).toBe(false);
  });

  it('403 の本文の文が理由の文でなければ「権限がありません」を出す (英字の内部の文を出さない)', async () => {
    server({ patch: () => 'reject-after-write', getOverride: (n) => (n === 2 ? rawForbiddenResponse() : undefined) });
    await render();

    await click(findButton('一時停止'), '「一時停止」ボタン');

    expect(statusError()).toBe(`一時停止の応答を受け取れませんでした（通信エラー）。${FORBIDDEN_MESSAGE}`);
    expect(text()).not.toContain(RAW_FORBIDDEN_TEXT);
    expect(findButton('再試行')).toBeUndefined();
  });

  it('読み直しが 500 なら今までどおり「再試行」を出してボタンを止め、「再試行」の読み直しが 404 なら理由を出して「再試行」を消し、ボタンを戻す', async () => {
    server({
      patch: () => 'reject-after-write',
      getOverride: (n) => (n === 2 ? serverErrorResponse() : n === 3 ? notFoundResponse() : undefined),
    });
    await render();

    await click(findButton('一時停止'), '「一時停止」ボタン');

    expect(statusError()).toBe(`一時停止の応答を受け取れませんでした（通信エラー）。${STATE_RELOAD_FAILED_GUIDE}`);
    expect(findButton('一時停止')?.disabled).toBe(true);
    await forceClick(findButton('一時停止'), '「一時停止」ボタン');
    expect(callsOf('PATCH', PATH)).toHaveLength(1);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(callsOf('GET', PATH)).toHaveLength(3);
    expect(statusError()).toBe(`一時停止の応答を受け取れませんでした（通信エラー）。${NOT_FOUND_MESSAGE}`);
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('一時停止')?.disabled).toBe(false);
  });
});

describe('機能パッケージの詳細: 廃止のあとの読み直しが 404 / 403 なら理由を出し、「再試行」を出さずにボタンを戻す (#2080 U8)', () => {
  const FEATURE_PACKAGE = {
    id: ROW_ID,
    package_key: 'pkg_2080',
    display_name: '読み直しの断られるパッケージ',
    description: '説明',
    feature_flags: ['flag_a'],
    display_order: 2,
    status: 'active',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
  const PATH = `/api/super-admin/feature-packages/${ROW_ID}`;
  const NOT_FOUND_MESSAGE = '機能パッケージが見つかりません。一覧に戻って確かめてください';
  const statusError = () => container.querySelector('[data-testid="status-change-error"]')?.textContent ?? null;
  const server = (options: { patch: Parameters<typeof mockDetailServer>[0]['patch']; getOverride?: GetOverride }) =>
    mockDetailServer({ path: PATH, row: FEATURE_PACKAGE, invalidCode: 'OP_FEATURE_PACKAGE_INVALID_TRANSITION', ...options });
  const render = async () => {
    await renderElement(createElement(FeaturePackageDetailPage));
    await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
  };

  it('通信の reject のあとの読み直しが 404 なら「見つかりません」を出し、「再試行」は出さず、「廃止する」を戻す', async () => {
    server({ patch: () => 'reject-after-write', getOverride: (n) => (n === 2 ? notFoundResponse() : undefined) });
    await render();

    await click(findButton('廃止する'), '「廃止する」ボタン');

    expect(statusError()).toBe(`廃止の応答を受け取れませんでした（通信エラー）。${NOT_FOUND_MESSAGE}`);
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('廃止する')?.disabled).toBe(false);
  });

  it('409 のあとの読み直しが 403 (二段階認証の確認が要る) なら、その理由の文を出し、「再試行」は出さない', async () => {
    server({ patch: () => 'conflict', getOverride: (n) => (n === 2 ? mfaForbiddenResponse() : undefined) });
    await render();

    await click(findButton('廃止する'), '「廃止する」ボタン');

    expect(statusError()).toBe(`廃止できませんでした（別の操作で機能パッケージの状態が先に変わっていました。${MFA_REQUIRED_MESSAGE}）`);
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('廃止する')?.disabled).toBe(false);
  });

  it('「再試行」の読み直しが 403 (理由の文でない) なら「権限がありません」を出し、「再試行」を消す', async () => {
    server({
      patch: () => 'reject-after-write',
      getOverride: (n) => (n === 2 ? serverErrorResponse() : n === 3 ? rawForbiddenResponse() : undefined),
    });
    await render();

    await click(findButton('廃止する'), '「廃止する」ボタン');
    expect(findButton('廃止する')?.disabled).toBe(true);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(statusError()).toBe(`廃止の応答を受け取れませんでした（通信エラー）。${FORBIDDEN_MESSAGE}`);
    expect(text()).not.toContain(RAW_FORBIDDEN_TEXT);
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('廃止する')?.disabled).toBe(false);
  });
});

describe('A/B テストの詳細: 200 の本文を読み切れないときも読み直し、409 のあとの読み直しの失敗でもボタンを止める (#2080 U7)', () => {
  const EXPERIMENT = {
    id: ROW_ID,
    key: 'reload_2080',
    name: '本文の読めない実験',
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
  /** 完了を読み直せたときの文 (今の状態を表示名で添える) */
  const COMPLETED_RELOADED_NOTICE =
    '状態の変更の応答を受け取れませんでした（通信エラー）。今の状態（完了）を読み込み直したので、状態を確かめてから、必要ならもう一度操作してください';

  /**
   * patch(n): 'unreadable-200' は書いてから JSON でない本文の 200、'no-data-200' は書いてから data の無い 200、
   * 'conflict' は書かずに 409、undefined は書いて 200。failGet(n) の GET は 500
   */
  function mockExperimentServer(options: {
    patch: (n: number) => 'unreadable-200' | 'no-data-200' | 'conflict' | undefined;
    failGet?: (n: number) => boolean;
  }) {
    let current: Record<string, unknown> = { ...EXPERIMENT };
    let gets = 0;
    let patches = 0;
    mockFetch((method, url, body) => {
      if (method === 'GET' && url.pathname === `${PATH}/results`) return jsonResponse(404, { error: { message: 'not found' } });
      if (url.pathname !== PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') {
        gets += 1;
        if (options.failGet?.(gets)) return serverErrorResponse();
        return jsonResponse(200, { data: { ...current } });
      }
      patches += 1;
      const mode = options.patch(patches);
      if (mode === 'conflict') {
        return jsonResponse(409, { error: { code: 'OP_EXPERIMENT_INVALID_TRANSITION', message: 'invalid transition' } });
      }
      current = { ...current, ...(body as Record<string, unknown>) };
      if (mode === 'unreadable-200') return new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      if (mode === 'no-data-200') return jsonResponse(200, {});
      return jsonResponse(200, { data: { ...current } });
    });
    return { serverRow: () => current };
  }

  const renderDetail = () => renderElement(createElement(ExperimentDetailPage, { params: Promise.resolve({ id: ROW_ID }) }));

  it('完了が済んで 200 が返ったのに本文が JSON でないとき、実験を読み直して「完了」の状態にし、今の状態を添えた文を出す', async () => {
    const s = mockExperimentServer({ patch: () => 'unreadable-200' });
    await renderDetail();

    await click(findButton('完了'), '「完了」ボタン');

    expect(s.serverRow().status).toBe('completed');
    expect(callsOf('GET', PATH)).toHaveLength(2);
    expect(findButton('完了')).toBeUndefined();
    expect(findButton('中止')).toBeUndefined();
    expect(noticeText()).toBe(COMPLETED_RELOADED_NOTICE);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('200 の本文に data が無いときも読み直す', async () => {
    mockExperimentServer({ patch: () => 'no-data-200' });
    await renderDetail();

    await click(findButton('中止'), '「中止」ボタン');

    expect(callsOf('GET', PATH)).toHaveLength(2);
    expect(findButton('完了')).toBeUndefined();
    expect(noticeText()).toBe(
      '状態の変更の応答を受け取れませんでした（通信エラー）。今の状態（中止）を読み込み直したので、状態を確かめてから、必要ならもう一度操作してください',
    );
  });

  it('200 の本文が読めず、読み直しにも失敗したら「再試行」を出して状態のボタンを止める', async () => {
    mockExperimentServer({ patch: () => 'unreadable-200', failGet: (n) => n === 2 });
    await renderDetail();

    await click(findButton('完了'), '「完了」ボタン');

    expect(noticeText()).toBe(`状態の変更の応答を受け取れませんでした（通信エラー）。${STATE_RELOAD_FAILED_GUIDE}`);
    expect(findButton('完了')?.disabled).toBe(true);
    await forceClick(findButton('中止'), '「中止」ボタン');
    expect(callsOf('PATCH', PATH)).toHaveLength(1);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(noticeText()).toBe(COMPLETED_RELOADED_NOTICE);
    expect(findButton('再試行')).toBeUndefined();
  });

  it('409 のあとの読み直しが失敗したあいだは状態のボタンを止め (押しても送らない)、「再試行」で読み直せたらボタンを戻す', async () => {
    mockExperimentServer({ patch: () => 'conflict', failGet: (n) => n === 2 });
    await renderDetail();

    await click(findButton('完了'), '「完了」ボタン');

    expect(noticeText()).toContain('最新の内容を読み込み直せませんでした');
    expect(findButton('完了')?.disabled).toBe(true);
    expect(findButton('中止')?.disabled).toBe(true);
    await forceClick(findButton('中止'), '「中止」ボタン');
    expect(callsOf('PATCH', PATH)).toHaveLength(1);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('完了')?.disabled).toBe(false);
    expect(findButton('中止')?.disabled).toBe(false);
  });
});

describe('A/B テストの一覧: 409 のあとの一覧の読み直しの失敗でも状態のボタンを止める (#2080 U7 と同じ型)', () => {
  const LIST_PATH = '/api/super-admin/experiments';
  const EXPERIMENT = {
    id: ROW_ID,
    key: 'reload_list_2080',
    name: '一覧の読み直しの失敗する実験',
    status: 'draft',
    start_date: null,
    end_date: null,
    variants: [{ key: 'control', weight: 100 }],
    primary_metric: null,
    created_at: '2026-10-01T00:00:00Z',
  };

  it('409 のあとの一覧の読み直しが失敗したあいだは状態のボタンを止め (押しても送らない)、「再試行」で読み直せたら戻す', async () => {
    let gets = 0;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === LIST_PATH) {
        gets += 1;
        if (gets === 2) return serverErrorResponse();
        return jsonResponse(200, { data: [{ ...EXPERIMENT }] });
      }
      if (method === 'PATCH' && url.pathname === `${LIST_PATH}/${ROW_ID}`) {
        return jsonResponse(409, { error: { code: 'CONFLICT_STALE_DATA', message: 'stale' } });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('開始'), '「開始」ボタン');

    expect(findButton('開始')?.disabled).toBe(true);
    await forceClick(findButton('開始'), '「開始」ボタン');
    expect(callsOf('PATCH', `${LIST_PATH}/${ROW_ID}`)).toHaveLength(1);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('開始')?.disabled).toBe(false);
  });
});
