/**
 * #2093 W6・W7: 運営の画面の読み直しの 401 / 403 の残りと、壊れた応答・JSON でない 502 の扱い
 *
 * 以前 (W6):
 *   - 機能フラグの一覧は、書き込み (切り替え・削除) の通信が切れたあとの読み直しが 401 / 403 でも「再試行」を出し、
 *     読み直せるまで切り替えと削除を止め続けた (listStaleRef が true のまま)。ログインが切れているので「再試行」を押しても変わらない
 *   - AI の利用上限の画面は、保存のあと・409 のあとの読み直しが 401 / 403 でも「再試行」を出した
 *   - 運営のメンバーシップの画面 (fetchOperatorJson) は、401 を本文の文 (「認証が必要です」) か「読み込めませんでした (HTTP 401)」で出した
 * 以前 (W7):
 *   - A/B テストの一覧・機能フラグの一覧・インフラのアラート / メトリクス・監査ログは、200 なのに本文が読めない / data が配列でないと 0 件に見えた
 *   - クーポン・機能パッケージの詳細 (読み込み・保存)、クーポン・機能パッケージ・プランの作成、価格の変更は、本文を ok の確認より先に
 *     res.json() で読んだので、プロキシの 502 の HTML は catch に落ちて「ネットワークエラー」になった (サーバーの失敗と通信の失敗が分からない)。
 *     作成・価格の変更の成功の応答の本文が読めないときも「ネットワークエラー」になり、済んでいるのに失敗に見えた
 * 直したあと (不変条件):
 *   - 読み直しの 401 は「ログインし直してください」、403 は理由の文か「権限がありません」(src/lib/super-admin/detail-reread.ts の
 *     rereadUnavailableMessage)。どちらも「再試行」を出さず、操作を止め続けない。500 などの失敗は今までどおり「再試行」を出す
 *   - 運営のメンバーシップの画面の読み込みの 401 は「ログインし直してください」
 *   - 一覧の 200 で data が配列でなければ「<対象>を読み込めませんでした（通信エラー）」(0 件と見せない)
 *   - 失敗の応答は ok を先に確かめ、本文の日本語の文か「<対象>を読み込めませんでした (HTTP n)」「<操作>に失敗しました (HTTP n)」を出す。
 *     通信そのものの失敗だけを「（通信エラー）」にする
 *   - 作成の成功の応答の本文が読めなければ、作成は済んだので失敗とは言わず、一覧で確かめるよう促す (作った行の画面へは移らない)
 *   - 価格の変更の成功の応答の本文は読まない (使わないため。読めなくても済んだ画面へ移る)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminCreatedButUnreadableMessage,
  createdRowIdOfResponse,
  fetchAdminRows,
  AdminScreenError,
} from '@/lib/admin/admin-screen-messages';
import {
  fetchOperatorJson,
  fetchOperatorRows,
  OperatorLoadUnavailableError,
  OperatorScreenError,
} from '@/lib/membership/operator-screen-messages';

const ROW_ID = '20932093-2093-4093-8093-209320932093';
// useRouter は描画のたびに同じ物を返す (router を依存に持つ読み込みが描画のたびに走らないように)
const nav = vi.hoisted(() => {
  const push = vi.fn();
  return { push, router: { push, replace: () => undefined, refresh: () => undefined, back: () => undefined } };
});
const routerPush = nav.push;

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '20932093-2093-4093-8093-209320932093' }),
  useRouter: () => nav.router,
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: FlagsPage } = await import('@/app/super-admin/flags/page');
const { default: LLMQuotasPage } = await import('@/app/super-admin/llm/quotas/page');
const { default: ExperimentsPage } = await import('@/app/super-admin/experiments/page');
const { default: InfraAlertsPage } = await import('@/app/super-admin/infra/page');
const { default: InfraMetricsPage } = await import('@/app/super-admin/infra/metrics/page');
const { default: AuditLogsPage } = await import('@/app/super-admin/audit-logs/page');
const { default: CouponDetailPage } = await import('@/app/super-admin/coupons/[id]/page');
const { default: FeaturePackageDetailPage } = await import('@/app/super-admin/feature-packages/[id]/page');
const { default: CouponNewPage } = await import('@/app/super-admin/coupons/new/page');
const { default: FeaturePackageNewPage } = await import('@/app/super-admin/feature-packages/new/page');
const { default: PlanNewPage } = await import('@/app/super-admin/plans/new/page');
const { default: PriceChangePage } = await import('@/app/super-admin/plans/[id]/price-change/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 読み直しの 401 のときの文 (UNAUTHENTICATED_SCREEN_MESSAGE) */
const RELOGIN_MESSAGE = 'ログインし直してください';
/** 403 の理由の文 (二段階認証の確認が要る。API_MFA_REQUIRED_MESSAGE) */
const MFA_REQUIRED_MESSAGE = '二段階認証の確認が必要です';
/** 403 の本文の文が理由の文でないときの文 */
const FORBIDDEN_MESSAGE = '権限がありません';
/** 画面に出してはいけない、英字の内部の文の例 */
const RAW_FORBIDDEN_TEXT = 'permission denied for super_admin';
/** 以前の画面が、JSON でない失敗の応答・成功の応答の読めない本文で出していた文 */
const OLD_NETWORK_ERROR_TEXTS = ['ネットワークエラー', 'ネットワークエラーが発生しました'];
/** 画面に出てはいけない英字の文 */
const ENGLISH_LEAKS = ['Failed to fetch', 'SyntaxError', 'TypeError', 'Unexpected token', 'Bad Gateway'];

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
/** 本文が JSON でない応答 (プロキシの 502 の HTML・壊れた 200) */
const htmlResponse = (status: number) =>
  new Response('<html><body>Bad Gateway</body></html>', { status, headers: { 'content-type': 'text/html' } });
const proxyBadGateway = () => htmlResponse(502);
const unauthenticatedResponse = () => jsonResponse(401, { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } });
const mfaForbiddenResponse = () => jsonResponse(403, { error: { code: 'OP_PERMISSION_DENIED', message: MFA_REQUIRED_MESSAGE } });
const rawForbiddenResponse = () => jsonResponse(403, { error: { code: 'OP_PERMISSION_DENIED', message: RAW_FORBIDDEN_TEXT } });
const serverErrorResponse = () => jsonResponse(500, { error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } });
/** 通信の reject (応答が切れた・届かなかった) */
const networkFailure = () => new TypeError('Failed to fetch');

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let alertSpy: ReturnType<typeof vi.fn>;

type Handler = (method: string, url: URL) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    return handler(method, url);
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

/** React の制御された入力欄へ値を入れる (value の setter を通してから input イベントを出す) */
async function typeInto(element: Element | null | undefined, value: string, what: string) {
  expect(element, `${what}が見つからない`).toBeTruthy();
  const target = element as HTMLInputElement | HTMLTextAreaElement;
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** form の submit (必須の欄の確かめを通さずに、画面の onSubmit を呼ぶ) */
async function submitForm() {
  const form = container.querySelector('form');
  expect(form, 'form が見つからない').not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

const text = () => container.textContent ?? '';
const alertTexts = () => alertSpy.mock.calls.map(([message]) => String(message));

function expectNoLeak(shown: string) {
  for (const leak of [...ENGLISH_LEAKS, ...OLD_NETWORK_ERROR_TEXTS]) expect(shown, `「${leak}」が出ている`).not.toContain(leak);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  alertSpy = vi.fn();
  vi.stubGlobal('alert', alertSpy);
  routerPush.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------------
// W6: 読み直しの 401 / 403
// ---------------------------------------------------------------------------------------------------------------------

describe('機能フラグの一覧: 書き込みの通信が切れたあとの読み直しが 401 / 403 なら理由を出し、「再試行」を出さず、切り替えと削除を止めない (#2093 W6)', () => {
  const FLAG = {
    key: 'flag_2093',
    description: '説明',
    enabled: false,
    rollout_strategy: null,
    constraints: null,
    active_user_count: 0,
    updated_at: '2026-10-30T00:00:00.000Z',
  };
  const LIST_PATH = '/api/super-admin/flags';
  const ITEM_PATH = `/api/super-admin/flags/${FLAG.key}`;
  const noticeText = () => container.querySelector('[data-testid="flags-reload-notice"]')?.textContent ?? null;
  const toggleButton = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('tbody button')).find((b) => (b.textContent ?? '').trim() === '');

  /** n 回目の一覧の GET (1 から) の応答。undefined は一覧を 200 で返す。書き込みはいつも reject */
  function mockFlagsServer(getOverride: (n: number) => Response | undefined) {
    let gets = 0;
    mockFetch((method, url) => {
      if (url.pathname === LIST_PATH && method === 'GET') {
        gets += 1;
        return getOverride(gets) ?? jsonResponse(200, { data: [FLAG] });
      }
      if (url.pathname === ITEM_PATH) throw networkFailure();
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  it('切り替えの通信が切れたあとの読み直しが 401 なら、「ログインし直してください」を出し、「再試行」は出さず、切り替えも削除も止めない', async () => {
    mockFlagsServer((n) => (n === 2 ? unauthenticatedResponse() : undefined));
    await renderElement(createElement(FlagsPage));

    await click(toggleButton(), '切り替えのボタン');

    expect(callsOf('GET', LIST_PATH)).toHaveLength(2);
    expect(noticeText()).toBe(`「${FLAG.key}」の切り替えの応答を受け取れませんでした（通信エラー）。${RELOGIN_MESSAGE}`);
    expect(findButton('再試行')).toBeUndefined();
    expect(toggleButton()?.disabled).toBe(false);
    expect(findButton('削除')?.disabled).toBe(false);

    // 止め続けていない: もう一度押すと送る (読み直しの失敗のあいだの止め (listStaleRef) が戻っている)
    await click(findButton('削除'), '「削除」ボタン');
    expect(callsOf('DELETE', ITEM_PATH)).toHaveLength(1);
  });

  it('削除の通信が切れたあとの読み直しが 403 なら、理由の文 (二段階認証の確認が要る) を出し、理由でない文なら「権限がありません」を出す (英字の文を出さない)', async () => {
    mockFlagsServer((n) => (n === 2 ? mfaForbiddenResponse() : n === 3 ? rawForbiddenResponse() : undefined));
    await renderElement(createElement(FlagsPage));

    await click(findButton('削除'), '「削除」ボタン');
    expect(noticeText()).toBe(`「${FLAG.key}」の削除の応答を受け取れませんでした（通信エラー）。${MFA_REQUIRED_MESSAGE}`);
    expect(findButton('再試行')).toBeUndefined();

    await click(toggleButton(), '切り替えのボタン');
    expect(callsOf('PATCH', ITEM_PATH)).toHaveLength(1);
    expect(noticeText()).toBe(`「${FLAG.key}」の切り替えの応答を受け取れませんでした（通信エラー）。${FORBIDDEN_MESSAGE}`);
    expect(text()).not.toContain(RAW_FORBIDDEN_TEXT);
    expect(findButton('再試行')).toBeUndefined();
  });

  it('読み直しが 500 なら今までどおり「再試行」を出し、読み直せるまで切り替えと削除を止める', async () => {
    mockFlagsServer((n) => (n === 2 ? serverErrorResponse() : undefined));
    await renderElement(createElement(FlagsPage));

    await click(toggleButton(), '切り替えのボタン');

    expect(findButton('再試行')).toBeDefined();
    await click(findButton('削除'), '「削除」ボタン');
    expect(callsOf('DELETE', ITEM_PATH)).toHaveLength(0);
  });

  it('「再試行」の読み直しが 401 になったら、「再試行」を消して理由を出し、切り替えと削除を止めない', async () => {
    mockFlagsServer((n) => (n === 2 ? serverErrorResponse() : n === 3 ? unauthenticatedResponse() : undefined));
    await renderElement(createElement(FlagsPage));

    await click(toggleButton(), '切り替えのボタン');
    await click(findButton('再試行'), '「再試行」ボタン');

    expect(noticeText()).toBe(`「${FLAG.key}」の切り替えの応答を受け取れませんでした（通信エラー）。${RELOGIN_MESSAGE}`);
    expect(findButton('再試行')).toBeUndefined();
    await click(findButton('削除'), '「削除」ボタン');
    expect(callsOf('DELETE', ITEM_PATH)).toHaveLength(1);
  });
});

describe('AI の利用上限: 保存のあと・409 のあとの読み直しが 401 / 403 なら理由を出し、「再試行」を出さない (#2093 W6)', () => {
  const QUOTAS_PATH = '/api/super-admin/llm/quotas';
  const LIST = {
    data: [
      { plan_key: 'free', plan_source: 'subscription_plan', display_name: 'Free', plan_type: 'personal', daily_limit: 10, configured: true, effective_daily_limit: 10, updated_at: '2026-10-11T00:00:00Z' },
    ],
    default_plan_key: 'free',
    enforced: true,
    note: '上限の説明',
  };
  const reloadError = () => container.querySelector('[data-testid="quota-reload-error"]')?.textContent ?? null;
  const rowStatus = () => container.querySelector('[data-testid="quota-row-free"] [role="status"]')?.textContent ?? null;

  function mockQuotasServer(options: { patch: () => Response; getOverride: (n: number) => Response | undefined }) {
    let gets = 0;
    mockFetch((method, url) => {
      if (url.pathname !== QUOTAS_PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') {
        gets += 1;
        return options.getOverride(gets) ?? jsonResponse(200, LIST);
      }
      return options.patch();
    });
  }

  async function saveFree() {
    await typeInto(container.querySelector('input[aria-label="free の新しい上限"]'), '20', '新しい上限の欄');
    await typeInto(container.querySelector('input[aria-label="free の変更の理由"]'), '見直し', '変更の理由の欄');
    await click(findButton('保存'), '「保存」ボタン');
  }

  it('保存のあとの読み直しが 401 なら、表の上に「ログインし直してください」を出し、「再試行」は出さない (表は残す)', async () => {
    mockQuotasServer({
      patch: () => jsonResponse(200, { data: { plan_key: 'free', daily_limit: 20 } }),
      getOverride: (n) => (n === 2 ? unauthenticatedResponse() : undefined),
    });
    await renderElement(createElement(LLMQuotasPage));

    await saveFree();

    expect(callsOf('GET', QUOTAS_PATH)).toHaveLength(2);
    expect(reloadError()).toContain(RELOGIN_MESSAGE);
    expect(reloadError()).not.toContain('認証が必要です');
    expect(findButton('再試行')).toBeUndefined();
    expect(container.querySelector('[data-testid="quota-row-free"]')).not.toBeNull();
  });

  it('409 のあとの読み直しが 403 なら、表の上に理由の文を出し、「再試行」は出さず、行の文も「再試行」を促さない', async () => {
    mockQuotasServer({
      patch: () => jsonResponse(409, { error: { code: 'CONFLICT_STALE_DATA', message: '画面を読み込み直してください' } }),
      getOverride: (n) => (n === 2 ? mfaForbiddenResponse() : undefined),
    });
    await renderElement(createElement(LLMQuotasPage));

    await saveFree();

    expect(reloadError()).toContain(MFA_REQUIRED_MESSAGE);
    expect(findButton('再試行')).toBeUndefined();
    expect(rowStatus()).toContain('別の運営が先にこのプランの上限を変えていました');
    expect(rowStatus()).not.toContain('再試行');
    expect(rowStatus()).toContain('入力した値と理由は残しています');
    // 書きかけは残す
    expect(container.querySelector<HTMLInputElement>('input[aria-label="free の新しい上限"]')?.value).toBe('20');
  });

  it('409 のあとの読み直しが 500 (「再試行」を促す行の文) のあと、「再試行」が 401 になったら、表の上の「再試行」も行の文の「再試行」も消す', async () => {
    mockQuotasServer({
      patch: () => jsonResponse(409, { error: { code: 'CONFLICT_STALE_DATA', message: '画面を読み込み直してください' } }),
      getOverride: (n) => (n === 2 ? serverErrorResponse() : n === 3 ? unauthenticatedResponse() : undefined),
    });
    await renderElement(createElement(LLMQuotasPage));

    await saveFree();
    expect(rowStatus()).toContain('再試行');
    await click(findButton('再試行'), '「再試行」ボタン');

    expect(callsOf('GET', QUOTAS_PATH)).toHaveLength(3);
    expect(reloadError()).toContain(RELOGIN_MESSAGE);
    expect(findButton('再試行')).toBeUndefined();
    expect(rowStatus()).not.toContain('再試行');
    expect(rowStatus()).toContain('入力した値と理由は残しています');
  });

  it('読み直しの 403 の文が理由の文でなければ「権限がありません」(英字の文を出さない)', async () => {
    mockQuotasServer({
      patch: () => jsonResponse(200, { data: { plan_key: 'free', daily_limit: 20 } }),
      getOverride: (n) => (n === 2 ? rawForbiddenResponse() : undefined),
    });
    await renderElement(createElement(LLMQuotasPage));

    await saveFree();

    expect(reloadError()).toContain(FORBIDDEN_MESSAGE);
    expect(text()).not.toContain(RAW_FORBIDDEN_TEXT);
    expect(findButton('再試行')).toBeUndefined();
  });

  it('読み直しが 500 なら今までどおり「再試行」を出す', async () => {
    mockQuotasServer({
      patch: () => jsonResponse(200, { data: { plan_key: 'free', daily_limit: 20 } }),
      getOverride: (n) => (n === 2 ? serverErrorResponse() : undefined),
    });
    await renderElement(createElement(LLMQuotasPage));

    await saveFree();

    expect(reloadError()).not.toBeNull();
    expect(findButton('再試行')).toBeDefined();
  });

  it('一覧の 200 の本文が読めない・data が配列でないなら、読み込めなかった文を出す (空の表を出さない)', async () => {
    mockQuotasServer({ patch: () => jsonResponse(200, {}), getOverride: () => jsonResponse(200, { note: '説明だけ' }) });
    await renderElement(createElement(LLMQuotasPage));

    expect(text()).toContain('AI の利用上限を読み込めませんでした（通信エラー）');
    expect(container.querySelector('table')).toBeNull();
  });
});

describe('運営のメンバーシップの画面: 読み込みの 401 は「ログインし直してください」(#2093 W6)', () => {
  // 401 / 403 は、読み込み直しても変わらないことを画面が見分けられるよう OperatorLoadUnavailableError (OperatorScreenError の子) で投げる (#2101 X4)
  it('fetchOperatorJson / fetchOperatorRows は 401 を「ログインし直してください」の OperatorScreenError にする (本文の文・「HTTP 401」を出さない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => unauthenticatedResponse()));
    await expect(fetchOperatorJson('/api/operator/membership/audit', '監査ログ')).rejects.toEqual(
      new OperatorLoadUnavailableError(RELOGIN_MESSAGE),
    );
    await expect(fetchOperatorRows('/api/operator/membership/orgs/inactive', '組織の一覧')).rejects.toEqual(
      new OperatorLoadUnavailableError(RELOGIN_MESSAGE),
    );
    await expect(fetchOperatorJson('/api/operator/membership/audit', '監査ログ')).rejects.toBeInstanceOf(OperatorScreenError);

    // 本文の無い 401 (プロキシなど) も同じ
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(401)));
    await expect(fetchOperatorJson('/api/operator/membership/audit', '監査ログ')).rejects.toEqual(
      new OperatorLoadUnavailableError(RELOGIN_MESSAGE),
    );
  });

  it('401 以外は今までどおり (本文の文、無ければ「読み込めませんでした (HTTP n)」)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mfaForbiddenResponse()));
    await expect(fetchOperatorJson('/api/operator/membership/audit', '監査ログ')).rejects.toEqual(
      new OperatorLoadUnavailableError(MFA_REQUIRED_MESSAGE),
    );
    vi.stubGlobal('fetch', vi.fn(async () => proxyBadGateway()));
    await expect(fetchOperatorJson('/api/operator/membership/audit', '監査ログ')).rejects.toEqual(
      new OperatorScreenError('監査ログを読み込めませんでした (HTTP 502)'),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// W7: 壊れた応答・JSON でない 502
// ---------------------------------------------------------------------------------------------------------------------

describe('部品: fetchAdminRows・createdRowIdOfResponse・adminCreatedButUnreadableMessage (#2093 W7)', () => {
  it('fetchAdminRows は data が配列なら返し、200 の読めない本文・data が配列でない応答は「（通信エラー）」の AdminScreenError にする', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: [{ id: 1 }] })));
    await expect(fetchAdminRows('/x', '一覧')).resolves.toEqual([{ id: 1 }]);
    for (const broken of [() => htmlResponse(200), () => jsonResponse(200, {}), () => jsonResponse(200, { data: null }), () => jsonResponse(200, { data: { id: 1 } })]) {
      vi.stubGlobal('fetch', vi.fn(async () => broken()));
      await expect(fetchAdminRows('/x', '一覧')).rejects.toEqual(new AdminScreenError('一覧を読み込めませんでした（通信エラー）'));
    }
    vi.stubGlobal('fetch', vi.fn(async () => proxyBadGateway()));
    await expect(fetchAdminRows('/x', '一覧')).rejects.toEqual(new AdminScreenError('一覧を読み込めませんでした (HTTP 502)'));
  });

  it('createdRowIdOfResponse は { data: { id } } の id を返し、読めない本文・id が無い・空なら null', async () => {
    await expect(createdRowIdOfResponse(jsonResponse(201, { data: { id: 'abc' } }))).resolves.toBe('abc');
    await expect(createdRowIdOfResponse(htmlResponse(201))).resolves.toBeNull();
    await expect(createdRowIdOfResponse(jsonResponse(201, { data: {} }))).resolves.toBeNull();
    await expect(createdRowIdOfResponse(jsonResponse(201, { data: { id: '' } }))).resolves.toBeNull();
    await expect(createdRowIdOfResponse(jsonResponse(201, { data: { id: 7 } }))).resolves.toBeNull();
    await expect(createdRowIdOfResponse(jsonResponse(201, null))).resolves.toBeNull();
  });

  it('作成が済んだが本文が読めないときの文は「失敗」とも「通信エラー」とも言わない', () => {
    const message = adminCreatedButUnreadableMessage('クーポンの作成');
    expect(message).toBe('クーポンの作成は済みましたが、応答を読み込めませんでした。一覧から開いて確かめてください');
    expect(message).not.toContain('失敗');
    expect(message).not.toContain('通信エラー');
  });
});

describe('一覧の画面: 200 なのに本文が読めない・data が配列でないなら 0 件と見せず、読み込めなかった文を出す (#2093 W7)', () => {
  it('A/B テストの一覧: 200 の HTML なら「実験の一覧を読み込めませんでした（通信エラー）」を出す (「0 件」の文を出さない)', async () => {
    mockFetch(() => htmlResponse(200));
    await renderElement(createElement(ExperimentsPage));

    expect(text()).toContain('実験の一覧を読み込めませんでした（通信エラー）');
    expect(text()).not.toContain('実験がありません');
    expectNoLeak(text());
  });

  it('A/B テストの一覧: 200 で data が配列でないときも同じ', async () => {
    mockFetch(() => jsonResponse(200, { data: null }));
    await renderElement(createElement(ExperimentsPage));

    expect(text()).toContain('実験の一覧を読み込めませんでした（通信エラー）');
    expect(text()).not.toContain('実験がありません');
  });

  it('A/B テストの一覧: 表示したあとの読み直しの 200 が壊れていたら、一覧を残して「再試行」を出す (0 件で上書きしない)', async () => {
    const EXPERIMENT = {
      id: ROW_ID,
      key: 'broken_2093',
      name: '壊れた応答の実験',
      status: 'draft',
      start_date: null,
      end_date: null,
      variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }],
      primary_metric: null,
      created_at: '2026-10-01T00:00:00Z',
    };
    let gets = 0;
    mockFetch((method) => {
      if (method === 'GET') {
        gets += 1;
        return gets === 1 ? jsonResponse(200, { data: [EXPERIMENT] }) : htmlResponse(200);
      }
      throw networkFailure();
    });
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('開始'), '「開始」ボタン');

    expect(text()).toContain(EXPERIMENT.name);
    expect(findButton('再試行')).toBeDefined();
  });

  it('機能フラグの一覧: 200 で data が配列でないなら「機能フラグを読み込めませんでした（通信エラー）」(「機能フラグがありません」を出さない)', async () => {
    mockFetch(() => jsonResponse(200, {}));
    await renderElement(createElement(FlagsPage));

    expect(text()).toContain('機能フラグを読み込めませんでした（通信エラー）');
    expect(text()).not.toContain('機能フラグがありません');
  });

  it('インフラのアラート・メトリクス・監査ログ: 200 で data が配列でないなら読み込めなかった文を出す', async () => {
    mockFetch(() => jsonResponse(200, { data: 'oops' }));
    await renderElement(createElement(InfraAlertsPage));
    expect(text()).toContain('読み込めませんでした（通信エラー）');

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderElement(createElement(InfraMetricsPage));
    expect(text()).toContain('読み込めませんでした（通信エラー）');

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderElement(createElement(AuditLogsPage));
    expect(text()).toContain('読み込めませんでした（通信エラー）');
  });
});

describe('クーポン・機能パッケージの詳細: ok を先に確かめ、JSON でない 502 を「ネットワークエラー」と見せない (#2093 W7)', () => {
  const COUPON = {
    id: ROW_ID,
    code: 'BROKEN2093',
    display_name: '壊れた応答のクーポン',
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
  const FEATURE_PACKAGE = {
    id: ROW_ID,
    package_key: 'pkg_2093',
    display_name: '壊れた応答のパッケージ',
    description: '説明',
    feature_flags: ['flag_a'],
    display_order: 2,
    status: 'active',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
  const SCREENS = [
    { name: 'クーポン', page: CouponDetailPage, path: `/api/super-admin/coupons/${ROW_ID}`, row: COUPON },
    { name: '機能パッケージ', page: FeaturePackageDetailPage, path: `/api/super-admin/feature-packages/${ROW_ID}`, row: FEATURE_PACKAGE },
  ] as const;

  for (const screen of SCREENS) {
    it(`${screen.name}の詳細: 読み込みが本文の無い 502 なら「${screen.name}を読み込めませんでした (HTTP 502)」、通信の reject なら「（通信エラー）」、200 の読めない本文も「（通信エラー）」`, async () => {
      mockFetch(() => proxyBadGateway());
      await renderElement(createElement(screen.page));
      expect(text()).toContain(`${screen.name}を読み込めませんでした (HTTP 502)`);
      expectNoLeak(text());

      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
      mockFetch(() => {
        throw networkFailure();
      });
      await renderElement(createElement(screen.page));
      expect(text()).toContain(`${screen.name}を読み込めませんでした（通信エラー）`);
      expectNoLeak(text());

      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
      mockFetch(() => htmlResponse(200));
      await renderElement(createElement(screen.page));
      expect(text()).toContain(`${screen.name}を読み込めませんでした（通信エラー）`);
      expectNoLeak(text());
    });

    it(`${screen.name}の詳細: 読み込みの失敗の応答の本文に日本語の文があればそれを出す (英字だけの文は出さない)`, async () => {
      mockFetch(() => jsonResponse(404, { error: { code: 'NOT_FOUND', message: `${screen.name}が見つかりません` } }));
      await renderElement(createElement(screen.page));
      expect(text()).toContain(`${screen.name}が見つかりません`);

      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
      mockFetch(() => jsonResponse(403, { error: { code: 'OP_PERMISSION_DENIED', message: RAW_FORBIDDEN_TEXT } }));
      await renderElement(createElement(screen.page));
      expect(text()).not.toContain(RAW_FORBIDDEN_TEXT);
      expect(text()).toContain(`${screen.name}を読み込めませんでした (HTTP 403)`);
    });

    it(`${screen.name}の詳細: 保存が本文の無い 502 なら「保存に失敗しました (HTTP 502)」、通信の reject なら「保存の応答を受け取れませんでした（通信エラー）」`, async () => {
      let patch: () => Response = () => proxyBadGateway();
      mockFetch((method) => (method === 'GET' ? jsonResponse(200, { data: { ...screen.row } }) : patch()));
      await renderElement(createElement(screen.page));
      await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());

      await typeInto(container.querySelector('input[type="text"]'), '新しい表示名', '表示名の欄');
      await click(findButton('保存する'), '「保存する」ボタン');
      expect(text()).toContain('保存に失敗しました (HTTP 502)');
      expectNoLeak(text());

      patch = () => {
        throw networkFailure();
      };
      await click(findButton('保存する'), '「保存する」ボタン');
      expect(text()).toContain('保存の応答を受け取れませんでした（通信エラー）');
      expect(text()).not.toContain('保存に失敗しました (HTTP 502)');
      expectNoLeak(text());

      // 成功の応答の本文が読めない: 保存は済んでいるかもしれないので、失敗とは言わず応答を受け取れなかった文にする
      patch = () => htmlResponse(200);
      await click(findButton('保存する'), '「保存する」ボタン');
      expect(text()).toContain('保存の応答を受け取れませんでした（通信エラー）');
      expect(text()).not.toContain('保存しました');
      expectNoLeak(text());
    });

    it(`${screen.name}の詳細: 保存の失敗の応答の本文に日本語の文があればそれを出す`, async () => {
      mockFetch((method) =>
        method === 'GET'
          ? jsonResponse(200, { data: { ...screen.row } })
          : jsonResponse(400, { error: { code: 'VALIDATION_ERROR', message: '表示名が長すぎます' } }),
      );
      await renderElement(createElement(screen.page));
      await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());

      await typeInto(container.querySelector('input[type="text"]'), '新しい表示名', '表示名の欄');
      await click(findButton('保存する'), '「保存する」ボタン');
      expect(text()).toContain('表示名が長すぎます');
    });
  }
});

describe('クーポン・機能パッケージ・プランの作成: ok を先に確かめ、JSON でない 502 を「ネットワークエラー」と見せない (#2093 W7)', () => {
  const CREATE_SCREENS = [
    {
      name: 'クーポン',
      action: 'クーポンの作成',
      page: CouponNewPage,
      path: '/api/super-admin/coupons',
      fill: async () => undefined,
    },
    {
      name: '機能パッケージ',
      action: '機能パッケージの作成',
      page: FeaturePackageNewPage,
      path: '/api/super-admin/feature-packages',
      // 機能フラグの欄 (2 つ目の textarea) が空だと送らない
      fill: async () => {
        await typeInto(container.querySelectorAll('textarea')[1], 'flag_a', '機能フラグの欄');
      },
    },
    {
      name: 'プラン',
      action: 'プランの作成',
      page: PlanNewPage,
      path: '/api/super-admin/plans',
      // テンプレートを選ばないと送らない
      fill: async () => {
        const template = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('free'));
        await click(template, 'free のテンプレート');
      },
    },
  ] as const;

  for (const screen of CREATE_SCREENS) {
    async function submitWith(response: () => Response) {
      mockFetch((method, url) => {
        if (method === 'POST' && url.pathname === screen.path) return response();
        throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      });
      await renderElement(createElement(screen.page));
      await screen.fill();
      await submitForm();
    }

    it(`${screen.name}の作成: 本文の無い 502 なら「${screen.action}に失敗しました (HTTP 502)」を出す`, async () => {
      await submitWith(() => proxyBadGateway());

      expect(callsOf('POST', screen.path)).toHaveLength(1);
      expect(text()).toContain(`${screen.action}に失敗しました (HTTP 502)`);
      expect(routerPush).not.toHaveBeenCalled();
      expectNoLeak(text());
    });

    it(`${screen.name}の作成: 失敗の応答の本文に日本語の文があればそれを出し、英字だけの文は出さない`, async () => {
      await submitWith(() => jsonResponse(409, { error: { code: 'DUPLICATE', message: 'キーは既に存在します' } }));
      expect(text()).toContain('キーは既に存在します');

      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
      await submitWith(() => jsonResponse(500, { error: { code: 'X', message: 'duplicate key value violates unique constraint' } }));
      expect(text()).toContain(`${screen.action}に失敗しました (HTTP 500)`);
      expect(text()).not.toContain('duplicate key');
    });

    it(`${screen.name}の作成: 通信の reject なら「${screen.action}の応答を受け取れませんでした（通信エラー）」を出す`, async () => {
      await submitWith(() => {
        throw networkFailure();
      });

      expect(text()).toContain(`${screen.action}の応答を受け取れませんでした（通信エラー）`);
      expect(routerPush).not.toHaveBeenCalled();
      expectNoLeak(text());
    });

    it(`${screen.name}の作成: 成功の応答の本文が読めないなら、作成は済んだ文を出し (失敗とは言わない)、作った行の画面へは移らない`, async () => {
      await submitWith(() => htmlResponse(201));

      expect(text()).toContain(adminCreatedButUnreadableMessage(screen.action));
      expect(text()).not.toContain('に失敗しました');
      expect(routerPush).not.toHaveBeenCalled();
      expectNoLeak(text());
    });

    it(`${screen.name}の作成: 成功の応答に id があれば作った行の画面へ移る`, async () => {
      await submitWith(() => jsonResponse(201, { data: { id: 'new-row-2093' } }));

      expect(routerPush).toHaveBeenCalledWith(`/super-admin/${screen.path.split('/').pop()}/new-row-2093`);
    });
  }
});

describe('価格の変更: ok を先に確かめ、JSON でない 502 を「ネットワークエラー」と見せない (#2093 W7)', () => {
  const PLAN = {
    id: ROW_ID,
    plan_key: 'pro',
    plan_type: 'personal',
    display_name: 'Pro',
    monthly_price_jpy: 580,
    yearly_price_jpy: null,
    status: 'active',
  };
  const PLAN_PATH = `/api/super-admin/plans/${ROW_ID}`;
  const IMPACT_PATH = `/api/super-admin/plans/${ROW_ID}/price-impact`;
  const CHANGE_PATH = `/api/super-admin/plans/${ROW_ID}/price-change`;
  const IMPACT = {
    affected_subscription_count: 0,
    affected_mrr_change_jpy: 0,
    current_monthly_price_jpy: 580,
    new_monthly_price_jpy: 680,
    applies_to: 'new_only',
    effective_timing: 'new_only',
  };

  function mockPriceServer(options: { plan?: () => Response; impact?: () => Response; change?: () => Response }) {
    mockFetch((method, url) => {
      if (url.pathname === PLAN_PATH) return (options.plan ?? (() => jsonResponse(200, { data: PLAN })))();
      if (url.pathname === IMPACT_PATH) return (options.impact ?? (() => jsonResponse(200, { data: IMPACT })))();
      if (url.pathname === CHANGE_PATH && method === 'POST') return (options.change ?? (() => jsonResponse(200, { data: {} })))();
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  async function simulate() {
    await typeInto(container.querySelectorAll('input[type="number"]')[0], '680', '新しい月額の欄');
    await click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('影響をシミュレーション')), 'シミュレーションのボタン');
  }

  async function execute() {
    await simulate();
    await click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('確認ステップへ')), '確認ステップへ');
    await typeInto(container.querySelector('textarea'), '価格の見直し', '変更理由の欄');
    await click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('価格変更を実行する')), '実行のボタン');
  }

  it('プランの読み込みが失敗したら「読み込み中」のまま止めず、読み込めなかった文を出す (502 の HTML・通信の reject)', async () => {
    mockPriceServer({ plan: () => proxyBadGateway() });
    await renderElement(createElement(PriceChangePage));
    expect(text()).toContain('プランを読み込めませんでした (HTTP 502)');
    expect(text()).not.toContain('読み込み中');
    expectNoLeak(text());

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    mockPriceServer({
      plan: () => {
        throw networkFailure();
      },
    });
    await renderElement(createElement(PriceChangePage));
    expect(text()).toContain('プランを読み込めませんでした（通信エラー）');
    expect(text()).not.toContain('読み込み中');
  });

  it('シミュレーションが本文の無い 502 なら「影響のシミュレーションに失敗しました (HTTP 502)」、通信の reject なら「（通信エラー）」', async () => {
    let impact: () => Response = () => proxyBadGateway();
    mockPriceServer({ impact: () => impact() });
    await renderElement(createElement(PriceChangePage));

    await simulate();
    expect(text()).toContain('影響のシミュレーションに失敗しました (HTTP 502)');
    expectNoLeak(text());

    impact = () => {
      throw networkFailure();
    };
    await click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('影響をシミュレーション')), 'シミュレーションのボタン');
    expect(text()).toContain('影響のシミュレーションの応答を受け取れませんでした（通信エラー）');
    expectNoLeak(text());
  });

  it('実行が本文の無い 502 なら「価格変更に失敗しました (HTTP 502)」を出し、画面を移らない', async () => {
    mockPriceServer({ change: () => proxyBadGateway() });
    await renderElement(createElement(PriceChangePage));

    await execute();

    expect(callsOf('POST', CHANGE_PATH)).toHaveLength(1);
    expect(text()).toContain('価格変更に失敗しました (HTTP 502)');
    expect(routerPush).not.toHaveBeenCalled();
    expectNoLeak(text());
  });

  it('実行の通信が reject されたら「価格変更の応答を受け取れませんでした（通信エラー）」を出す (失敗とは言わない)', async () => {
    mockPriceServer({
      change: () => {
        throw networkFailure();
      },
    });
    await renderElement(createElement(PriceChangePage));

    await execute();

    expect(text()).toContain('価格変更の応答を受け取れませんでした（通信エラー）');
    expect(routerPush).not.toHaveBeenCalled();
    expectNoLeak(text());
  });

  it('実行の成功の応答の本文が読めなくても、済んだので履歴の画面へ移る (失敗の文を出さない)', async () => {
    mockPriceServer({ change: () => htmlResponse(200) });
    await renderElement(createElement(PriceChangePage));

    await execute();

    expect(routerPush).toHaveBeenCalledWith(`/super-admin/plans/${ROW_ID}?tab=history`);
    expectNoLeak(text());
  });
});
