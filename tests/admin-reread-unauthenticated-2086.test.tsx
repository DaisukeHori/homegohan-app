/**
 * #2086 V4: 運営の画面の、状態の変更のあとの読み直しの 401 / 403 の扱いのそろえ
 *
 * 以前:
 *   - クーポン・機能パッケージ・A/B テスト (詳細・一覧)・プランの詳細は、読み直しが 401 (ログインが切れた) で断られると failed 扱いにして
 *     「再試行」を出し、状態のボタンを止め続けた。ログインが切れているので「再試行」を何度押しても変わらない。
 *     手動のプラン付与 (ManualPlanGrantSection) だけは 401 を「ログインし直してください」にして「再試行」を出さなかった。
 *   - 手動のプラン付与は 403 を code (OP_PERMISSION_DENIED) から常に「権限がありません」にしていた。運営の route は二段階認証の確認が
 *     要るときも code は OP_PERMISSION_DENIED のまま文だけを理由の文にする (#2014) ので、二段階認証が理由でも運営に分からなかった
 *     (ほかの運営の画面は forbiddenMessageForScreen で理由の文を出す)。
 * 直したあと (不変条件):
 *   - 読み直しの 401 は、どの画面でも「ログインし直してください」を出し、「再試行」は出さず、状態のボタンを止めない
 *     (src/lib/super-admin/detail-reread.ts の rereadUnavailableMessage に分け方をまとめる)
 *   - 手動のプラン付与の 403 は、本文の文が理由の文 (src/lib/api/forbidden-reason-messages.ts の表) のときだけその文を出し、
 *     それ以外 (英字の内部の文など) は「権限がありません」
 *   - 500 などの読み直しの失敗は今までどおり「再試行」を出す (401 / 403 / 404 だけが unavailable)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rereadUnavailableMessage } from '@/lib/super-admin/detail-reread';
import { fetchManualPlanView, MANUAL_GRANT_CLIENT_UNKNOWN_CODE } from '@/lib/billing/manual-grant-client';
import { MANUAL_GRANT_CLIENT_MESSAGES, manualGrantErrorMessage } from '@/lib/billing/manual-grant';
import { FORBIDDEN_SCREEN_MESSAGE, UNAUTHENTICATED_SCREEN_MESSAGE } from '@/lib/admin/api-error-message';
import { FORBIDDEN_REASON_CODE_BY_MESSAGE } from '@/lib/api/forbidden-reason-messages';

const ROW_ID = '20862086-2086-4086-8086-208620862086';

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
const { default: PlanDetailPage } = await import('@/app/super-admin/plans/[id]/page');
const { ManualPlanGrantSection } = await import('@/components/admin/ManualPlanGrantSection');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 読み直しの 401 のときの文 (UNAUTHENTICATED_SCREEN_MESSAGE。手動のプラン付与の AUTH_UNAUTHENTICATED の文と同じ) */
const RELOGIN_MESSAGE = 'ログインし直してください';
/** 403 の理由の文 (二段階認証の確認が要る。API_MFA_REQUIRED_MESSAGE) */
const MFA_REQUIRED_MESSAGE = '二段階認証の確認が必要です';
/** 403 の本文の文が理由の文でないときの文 */
const FORBIDDEN_MESSAGE = '権限がありません';
/** 画面に出してはいけない、英字の内部の文の例 */
const RAW_FORBIDDEN_TEXT = 'permission denied for super_admin';
/** 詳細の画面で、今の状態の読み直しにも失敗したときに続く文 (「再試行」を出す) */
const STATE_RELOAD_FAILED_GUIDE = '今の状態を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const unauthenticatedResponse = () => jsonResponse(401, { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } });
const mfaForbiddenResponse = () => jsonResponse(403, { error: { code: 'OP_PERMISSION_DENIED', message: MFA_REQUIRED_MESSAGE } });
const rawForbiddenResponse = () => jsonResponse(403, { error: { code: 'OP_PERMISSION_DENIED', message: RAW_FORBIDDEN_TEXT } });
const serverErrorResponse = () => jsonResponse(500, { error: { code: 'OP_INTERNAL_ERROR', message: '内部エラー' } });
/** 通信の reject (応答が切れた・届かなかった) */
const networkFailure = () => new TypeError('Failed to fetch');

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

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

const text = () => container.textContent ?? '';

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('alert', vi.fn());
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

/** 詳細の画面のサーバーの代わり。PATCH は 'reject-after-write' なら書いてから reject、'conflict' なら書かずに 409 */
function mockDetailServer(options: {
  path: string;
  row: Record<string, unknown>;
  invalidCode: string;
  patch: 'reject-after-write' | 'conflict';
  getOverride?: GetOverride;
}) {
  let current = { ...options.row };
  let gets = 0;
  mockFetch((method, url, body) => {
    if (url.pathname === `${options.path}/results`) return jsonResponse(404, { error: { message: '結果がありません' } });
    if (url.pathname !== options.path) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    if (method === 'GET') {
      gets += 1;
      return options.getOverride?.(gets) ?? jsonResponse(200, { data: { ...current } });
    }
    if (options.patch === 'conflict') {
      return jsonResponse(409, { error: { code: options.invalidCode, message: '状態を変えられません' } });
    }
    current = { ...current, ...(body as Record<string, unknown>) };
    throw networkFailure();
  });
}

describe('rereadUnavailableMessage: 読み直しの失敗の分け方 (#2086 V4)', () => {
  const NOT_FOUND = 'クーポンが見つかりません。一覧に戻って確かめてください';

  it('401 は「ログインし直してください」、403 は理由の文か「権限がありません」、404 は渡した文を返す', () => {
    expect(rereadUnavailableMessage(401, null, NOT_FOUND)).toBe(RELOGIN_MESSAGE);
    expect(rereadUnavailableMessage(403, { error: { code: 'OP_PERMISSION_DENIED', message: MFA_REQUIRED_MESSAGE } }, NOT_FOUND)).toBe(
      MFA_REQUIRED_MESSAGE,
    );
    expect(rereadUnavailableMessage(403, { error: { message: RAW_FORBIDDEN_TEXT } }, NOT_FOUND)).toBe(FORBIDDEN_MESSAGE);
    expect(rereadUnavailableMessage(403, null, NOT_FOUND)).toBe(FORBIDDEN_MESSAGE);
    expect(rereadUnavailableMessage(404, null, NOT_FOUND)).toBe(NOT_FOUND);
  });

  it('500 などは null (「再試行」で変わりうる)。一覧の読み直し (404 の文を渡さない) の 404 も null', () => {
    expect(rereadUnavailableMessage(500, null, NOT_FOUND)).toBeNull();
    expect(rereadUnavailableMessage(502, null, NOT_FOUND)).toBeNull();
    expect(rereadUnavailableMessage(404, null, null)).toBeNull();
  });
});

describe('クーポンの詳細: 状態の変更のあとの読み直しが 401 なら「ログインし直してください」を出し、「再試行」を出さない (#2086 V4)', () => {
  const COUPON = {
    id: ROW_ID,
    code: 'RELOGIN2086',
    display_name: 'ログインの切れるクーポン',
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
  const statusError = () => container.querySelector('[data-testid="status-change-error"]')?.textContent ?? null;
  const render = async () => {
    await renderElement(createElement(CouponDetailPage));
    await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
  };

  it('通信の reject のあとの読み直しが 401 なら、「ログインし直してください」を出し、「再試行」は出さず、状態のボタンを戻す', async () => {
    mockDetailServer({
      path: PATH,
      row: COUPON,
      invalidCode: 'OP_COUPON_INVALID_TRANSITION',
      patch: 'reject-after-write',
      getOverride: (n) => (n === 2 ? unauthenticatedResponse() : undefined),
    });
    await render();

    await click(findButton('一時停止'), '「一時停止」ボタン');

    expect(callsOf('GET', PATH)).toHaveLength(2);
    expect(statusError()).toBe(`一時停止の応答を受け取れませんでした（通信エラー）。${RELOGIN_MESSAGE}`);
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('一時停止')?.disabled).toBe(false);
  });

  it('読み直しが 500 なら今までどおり「再試行」を出す (401 / 403 / 404 だけが「再試行」を出さない)', async () => {
    mockDetailServer({
      path: PATH,
      row: COUPON,
      invalidCode: 'OP_COUPON_INVALID_TRANSITION',
      patch: 'reject-after-write',
      getOverride: (n) => (n === 2 ? serverErrorResponse() : undefined),
    });
    await render();

    await click(findButton('一時停止'), '「一時停止」ボタン');

    expect(statusError()).toBe(`一時停止の応答を受け取れませんでした（通信エラー）。${STATE_RELOAD_FAILED_GUIDE}`);
    expect(findButton('再試行')).toBeDefined();
    expect(findButton('一時停止')?.disabled).toBe(true);
  });
});

describe('機能パッケージの詳細: 廃止のあとの読み直しが 401 なら「ログインし直してください」を出し、「再試行」を出さない (#2086 V4)', () => {
  const FEATURE_PACKAGE = {
    id: ROW_ID,
    package_key: 'pkg_2086',
    display_name: 'ログインの切れるパッケージ',
    description: '説明',
    feature_flags: ['flag_a'],
    display_order: 2,
    status: 'active',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
  const PATH = `/api/super-admin/feature-packages/${ROW_ID}`;
  const statusError = () => container.querySelector('[data-testid="status-change-error"]')?.textContent ?? null;

  it('409 のあとの読み直しが 401 なら、「ログインし直してください」を出し、「再試行」は出さず、「廃止する」を戻す', async () => {
    mockDetailServer({
      path: PATH,
      row: FEATURE_PACKAGE,
      invalidCode: 'OP_FEATURE_PACKAGE_INVALID_TRANSITION',
      patch: 'conflict',
      getOverride: (n) => (n === 2 ? unauthenticatedResponse() : undefined),
    });
    await renderElement(createElement(FeaturePackageDetailPage));
    await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());

    await click(findButton('廃止する'), '「廃止する」ボタン');

    expect(statusError()).toBe(`廃止できませんでした（別の操作で機能パッケージの状態が先に変わっていました。${RELOGIN_MESSAGE}）`);
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('廃止する')?.disabled).toBe(false);
  });
});

describe('A/B テストの詳細・一覧: 読み直しが 401 / 403 なら理由を出し、「再試行」を出さず、状態のボタンを止めない (#2086 V4)', () => {
  const EXPERIMENT = {
    id: ROW_ID,
    key: 'relogin_2086',
    name: 'ログインの切れる実験',
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
  const LIST_PATH = '/api/super-admin/experiments';
  const noticeText = () => container.querySelector('[data-testid="experiment-reload-notice"] p')?.textContent ?? null;

  it('詳細: 409 のあとの読み直しが 401 なら、「ログインし直してください」を出し、「再試行」は出さず、状態のボタンを止めない', async () => {
    mockDetailServer({
      path: PATH,
      row: EXPERIMENT,
      invalidCode: 'OP_EXPERIMENT_INVALID_TRANSITION',
      patch: 'conflict',
      getOverride: (n) => (n === 2 ? unauthenticatedResponse() : undefined),
    });
    await renderElement(createElement(ExperimentDetailPage, { params: Promise.resolve({ id: ROW_ID }) }));

    await click(findButton('完了'), '「完了」ボタン');

    expect(noticeText()).toBe(RELOGIN_MESSAGE);
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('完了')?.disabled).toBe(false);
    expect(findButton('中止')?.disabled).toBe(false);
  });

  /** 一覧のサーバーの代わり。PATCH は 409、gets 回目の GET は override の応答 */
  function mockListServer(override: GetOverride) {
    let gets = 0;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === LIST_PATH) {
        gets += 1;
        return override(gets) ?? jsonResponse(200, { data: [{ ...EXPERIMENT, status: 'draft' }] });
      }
      if (method === 'PATCH' && url.pathname === `${LIST_PATH}/${ROW_ID}`) {
        return jsonResponse(409, { error: { code: 'CONFLICT_STALE_DATA', message: '画面を読み込み直してください' } });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  it('一覧: 409 のあとの一覧の読み直しが 401 なら、「ログインし直してください」を出し、「再試行」は出さず、「開始」を止めない', async () => {
    mockListServer((n) => (n === 2 ? unauthenticatedResponse() : undefined));
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('開始'), '「開始」ボタン');

    expect(callsOf('GET', LIST_PATH)).toHaveLength(2);
    expect(noticeText()).toBe(RELOGIN_MESSAGE);
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('開始')?.disabled).toBe(false);
  });

  it('一覧: 一覧の読み直しが 403 なら理由の文 (二段階認証の確認が要る) を出し、理由でない文なら「権限がありません」を出す (英字の文を出さない)', async () => {
    mockListServer((n) => (n === 2 ? mfaForbiddenResponse() : n === 3 ? rawForbiddenResponse() : undefined));
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('開始'), '「開始」ボタン');
    expect(noticeText()).toBe(MFA_REQUIRED_MESSAGE);
    expect(findButton('再試行')).toBeUndefined();

    await click(findButton('開始'), '「開始」ボタン');
    expect(noticeText()).toBe(FORBIDDEN_MESSAGE);
    expect(text()).not.toContain(RAW_FORBIDDEN_TEXT);
    expect(findButton('開始')?.disabled).toBe(false);
  });

  it('一覧: 一覧の読み直しが 500 なら今までどおり「再試行」を出し、「開始」を止める', async () => {
    mockListServer((n) => (n === 2 ? serverErrorResponse() : undefined));
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('開始'), '「開始」ボタン');

    expect(findButton('再試行')).toBeDefined();
    expect(findButton('開始')?.disabled).toBe(true);
  });
});

describe('プランの詳細: 状態の変更のあとの読み直しが 401 なら「ログインし直してください」を出し、「再試行」を出さない (#2086 V4)', () => {
  const PLAN = {
    id: ROW_ID,
    plan_key: 'pro_2086',
    display_name: 'ログインの切れるプラン',
    plan_type: 'personal',
    description: '説明',
    monthly_price_jpy: 980,
    yearly_price_jpy: 9800,
    max_members: null,
    stripe_product_id: null,
    stripe_price_id: null,
    stripe_yearly_price_id: null,
    status: 'public',
    display_order: 3,
    trial_days: 0,
    feature_packages: [],
    price_history: [],
  };
  const PATH = `/api/super-admin/plans/${ROW_ID}`;
  const notice = () => container.querySelector('[data-testid="plan-reload-notice"] > span')?.textContent ?? null;

  it('通信の reject のあとの読み直しが 401 なら、「ログインし直してください」を出し、「再試行」は出さず、状態のボタンを止めない', async () => {
    let gets = 0;
    mockFetch((method, url) => {
      if (url.pathname !== PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') {
        gets += 1;
        return gets === 2 ? unauthenticatedResponse() : jsonResponse(200, { data: { ...PLAN } });
      }
      throw networkFailure();
    });
    await renderElement(createElement(PlanDetailPage));

    await click(findButton('非公開にする'), '「非公開にする」ボタン');

    expect(callsOf('GET', PATH)).toHaveLength(2);
    expect(notice()).toBe(RELOGIN_MESSAGE);
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('非公開にする')?.disabled).toBe(false);
  });
});

describe('手動のプラン付与: 403 の本文の文が理由の文ならその文を出す (#2086 V4)', () => {
  const USER_ID = '20862086-2086-4086-8086-208620862087';
  const MANUAL_PLAN_PATH = `/api/super-admin/users/${USER_ID}/manual-plan`;
  const VIEW = {
    current: null,
    plans: [{ plan_key: 'pro', display_name: 'プロ', plan_type: 'personal', max_members: null }],
    history: [],
  };

  it('画面の文の表 (manual-grant.ts は import を増やせないので書き写す) が、理由の文の表・運営の画面の 401 / 403 の文と同じ', () => {
    expect(FORBIDDEN_REASON_CODE_BY_MESSAGE.size).toBeGreaterThan(0);
    for (const [message, code] of FORBIDDEN_REASON_CODE_BY_MESSAGE) {
      expect(MANUAL_GRANT_CLIENT_MESSAGES[code], code).toBe(message);
    }
    expect(MANUAL_GRANT_CLIENT_MESSAGES.AUTH_UNAUTHENTICATED).toBe(UNAUTHENTICATED_SCREEN_MESSAGE);
    expect(MANUAL_GRANT_CLIENT_MESSAGES.OP_PERMISSION_DENIED).toBe(FORBIDDEN_SCREEN_MESSAGE);
  });

  it('client: 403 の文が理由の文なら、その理由の code にして返す (本文の文そのものは結果に入れない)', async () => {
    mockFetch(() => mfaForbiddenResponse());
    const mfa = await fetchManualPlanView(USER_ID);
    expect(mfa).toEqual({ ok: false, status: 403, code: 'AUTH_2FA_REQUIRED' });
    expect(manualGrantErrorMessage(mfa.ok ? '' : mfa.code)).toBe(MFA_REQUIRED_MESSAGE);

    mockFetch(() => jsonResponse(403, { error: { code: 'OP_PERMISSION_DENIED', message: '二段階認証の登録が必要です' } }));
    expect(await fetchManualPlanView(USER_ID)).toEqual({ ok: false, status: 403, code: 'AUTH_2FA_ENROLLMENT_REQUIRED' });

    mockFetch(() => jsonResponse(403, { error: { code: 'OP_PERMISSION_DENIED', message: 'アカウントが凍結されています' } }));
    expect(await fetchManualPlanView(USER_ID)).toEqual({ ok: false, status: 403, code: 'AUTH_ACCOUNT_FROZEN' });
  });

  it('client: 403 の文が理由の文でなければ本文の code のまま (英字の文は捨てる)。403 以外は理由の文でも本文の code のまま', async () => {
    mockFetch(() => rawForbiddenResponse());
    expect(await fetchManualPlanView(USER_ID)).toEqual({ ok: false, status: 403, code: 'OP_PERMISSION_DENIED' });

    mockFetch(() => new Response('<html>forbidden</html>', { status: 403, headers: { 'content-type': 'text/html' } }));
    expect(await fetchManualPlanView(USER_ID)).toEqual({ ok: false, status: 403, code: MANUAL_GRANT_CLIENT_UNKNOWN_CODE });

    mockFetch(() => jsonResponse(409, { error: { code: 'OP_SUBSCRIPTION_ALREADY_ACTIVE', message: MFA_REQUIRED_MESSAGE } }));
    expect(await fetchManualPlanView(USER_ID)).toEqual({ ok: false, status: 409, code: 'OP_SUBSCRIPTION_ALREADY_ACTIVE' });
  });

  async function setFieldValue(field: HTMLTextAreaElement | HTMLSelectElement | HTMLInputElement | null, value: string) {
    expect(field).not.toBeNull();
    await act(async () => {
      const proto =
        field instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : field instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
      field?.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
  }
  const byTestId = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
  const errorText = () => byTestId('manual-plan-grant-error')?.textContent ?? null;

  async function renderAndSubmitGrant() {
    await renderElement(createElement(ManualPlanGrantSection, { userId: USER_ID }));
    await setFieldValue(byTestId<HTMLSelectElement>('manual-plan-grant-plan'), 'pro');
    await setFieldValue(byTestId<HTMLTextAreaElement>('manual-plan-grant-reason'), '検証のため');
    const submit = byTestId<HTMLButtonElement>('manual-plan-grant-submit');
    expect(submit).not.toBeNull();
    await act(async () => {
      submit?.form?.requestSubmit(submit);
    });
    await settle();
  }

  it('付与の応答を受け取れなかったあとの読み直しが 403 (二段階認証の確認が要る) なら、その理由の文を出し、「再試行」は出さない', async () => {
    let gets = 0;
    mockFetch((method, url) => {
      if (url.pathname !== MANUAL_PLAN_PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') {
        gets += 1;
        return gets === 2 ? mfaForbiddenResponse() : jsonResponse(200, { data: VIEW });
      }
      throw networkFailure();
    });

    await renderAndSubmitGrant();

    expect(callsOf('GET', MANUAL_PLAN_PATH)).toHaveLength(2);
    expect(errorText()).toBe(`付与の応答を受け取れませんでした（通信エラー）。${MFA_REQUIRED_MESSAGE}`);
    expect(byTestId('manual-plan-grant-retry')).toBeNull();
  });

  it('読み直しの 403 の文が理由の文でなければ「権限がありません」を出す (英字の内部の文を出さない)', async () => {
    let gets = 0;
    mockFetch((method) => {
      if (method === 'GET') {
        gets += 1;
        return gets === 2 ? rawForbiddenResponse() : jsonResponse(200, { data: VIEW });
      }
      throw networkFailure();
    });

    await renderAndSubmitGrant();

    expect(errorText()).toBe(`付与の応答を受け取れませんでした（通信エラー）。${FORBIDDEN_MESSAGE}`);
    expect(text()).not.toContain(RAW_FORBIDDEN_TEXT);
  });

  it('付与そのものが 403 (二段階認証の確認が要る) で断られたときも理由の文を出す', async () => {
    mockFetch((method) => (method === 'GET' ? jsonResponse(200, { data: VIEW }) : mfaForbiddenResponse()));

    await renderAndSubmitGrant();

    expect(errorText()).toBe(MFA_REQUIRED_MESSAGE);
  });
});
