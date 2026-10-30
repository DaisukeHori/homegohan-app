/**
 * #2112 Z1: プランの販売開始の画面
 *
 * Z1-1 (以前): 販売開始の手順 (docs/design/billing/01-billing-core.md §17.3 の 1.) は「Stripe の Product の ID を stripe_product_id に入れ、
 *   価格の変更で今の価格のまま Stripe の Price を作る」だが、
 *   - プラン詳細には stripe_product_id を入れる欄が無く (価格設定のタブに表示だけ)、
 *   - PATCH /api/super-admin/plans/{id} も公開中・非公開のプランでは stripe_product_id をいつも 422 OP_PLAN_STATUS_LOCKED で断った
 *     (販売開始の対象の pro・family_basic・family_pro は公開中)。
 *   - 価格の変更の画面は、Stripe の同期が要らないプラン (Product ID が無い・鍵が無い) で今と同じ価格のとき「変更がありません」とだけ出し、
 *     なぜ Stripe の Price を作れないかを言わなかった。
 * 直したあと (不変条件):
 *   - プラン詳細の基本情報に Stripe の Product ID の入力欄があり、保存で PATCH に送り (前後の空白を外す・空欄は null)、DB に入る
 *   - 公開中・非公開のプランでも、月額・年額のどちらの Stripe の Price もまだ無いあいだは変えられる。Price を作ったあとは 422 で理由の文。
 *     読んでから書くまでに Price が作られたら書かない (409 CONFLICT_STALE_DATA)
 *   - 価格の変更の画面は、Price ID がまだ無い間隔があるのに作れないとき、理由 (Product ID が未設定・鍵が無い) を出す
 * Z1-2 (以前): 価格変更履歴のタブは適用範囲を英字の値 (new_only) のまま出し、年額と Stripe の Price ID の列が無かった。
 * 直したあと: 適用範囲は日本語の名前 (PRICE_APPLIES_TO_LABELS。DB の CHECK の 3 値すべて)・旧年額 / 新年額の列・月額の Price ID が変わった印
 *
 * 画面の fetch は本物の route (GET / PATCH) へつなぎ、DB は条件 (eq / is / not) を本当に当てる 1 行のフェイクにする。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// route は UUID の形でない id を DB に渡さず 404 にする (#1917) ので、id は UUID の形にする
const PLAN_ID = '21122112-2112-4112-8112-211221122112';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '21122112-2112-4112-8112-211221122112' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, back: () => undefined }),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const mockRequireRole = vi.fn();
vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

// 失敗の記録 (app_logs) は書かない
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    withUser: () => ({ error: vi.fn() }),
  }),
  generateRequestId: () => 'req_test',
}));

// 監査ログは書いたことだけを数える
const mockRecordAdminAudit = vi.fn();
vi.mock('@/lib/admin/audit', () => ({
  recordAdminAudit: (...args: unknown[]) => mockRecordAdminAudit(...args),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeDb.client),
  // プランの更新は service_role の client で書く (#1917 の続き)。同じフェイクの DB に書く (廃止の操作はしない)
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'subscription_plans') throw new Error(`この試験では service_role で ${table} を使わない`);
      return fakeDb.client.from(table);
    },
  }),
}));

const { default: PlanDetailPage } = await import('@/app/super-admin/plans/[id]/page');
const { default: PriceChangePage } = await import('@/app/super-admin/plans/[id]/price-change/page');
const { GET, PATCH } = await import('@/app/api/super-admin/plans/[id]/route');
const {
  PLAN_TYPES,
  PLAN_TYPE_LABELS,
  PRICE_APPLIES_TO,
  PRICE_APPLIES_TO_LABELS,
  PRICE_HISTORY_APPLIES_TO,
  PlanUpdateSchema,
  STRIPE_PRODUCT_ID_EMPTY_MESSAGE,
  STRIPE_PRODUCT_ID_LOCKED_MESSAGE,
  isStripeProductIdEditable,
  planTypeLabel,
  priceAppliesToLabel,
} = await import('@/lib/super-admin/plans-schemas');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 販売開始の前の Stripe の商品の ID */
const PRODUCT_ID = 'prod_launch_pro';
const MONTHLY_PRICE_ID = 'price_monthly_pro';
const MONTHLY = 580;
const YEARLY = 5800;
const NEW_YEARLY = 6200;

/** 画面の文 (page の定数と同じ文。画面の文が変わったら赤になる) */
const PRODUCT_LOCKED_HELP = 'Stripe の Price を作ったあとなので、Stripe の Product ID は変えられません (Price は商品に紐づくため)。';
const PRODUCT_MISSING_REASON =
  'このプランには Stripe の Product ID が入っていないので、Stripe の Price は作れません。プラン詳細の基本情報で Stripe の Product ID を入れて保存してから、今の価格のまま進めて「Stripe の Price を作る」を押してください。';
const KEY_MISSING_REASON = 'この環境には Stripe の鍵が無いので、Stripe の Price は作れません。';
const MONTHLY_PRICE_CHANGED_MARK = '月額の Price ID が変わった';

type Row = Record<string, unknown>;

/** subscription_plans の 1 行 (公開中・販売開始の前 = Product ID も Price ID も無い) */
function planRow(overrides: Row = {}): Row {
  return {
    id: PLAN_ID,
    plan_key: 'pro',
    display_name: 'Pro',
    plan_type: 'personal',
    description: null,
    banner_url: null,
    monthly_price_jpy: MONTHLY,
    yearly_price_jpy: YEARLY,
    max_members: null,
    stripe_product_id: null,
    stripe_price_id: null,
    stripe_yearly_price_id: null,
    status: 'public',
    display_order: 20,
    trial_days: 7,
    feature_packages: [],
    ends_at: null,
    ...overrides,
  };
}

/** plan_price_history の 1 行 */
function historyRow(overrides: Row = {}): Row {
  return {
    id: `h-${Math.random().toString(36).slice(2)}`,
    plan_id: PLAN_ID,
    old_monthly_price_jpy: MONTHLY,
    new_monthly_price_jpy: MONTHLY,
    old_yearly_price_jpy: YEARLY,
    new_yearly_price_jpy: YEARLY,
    old_stripe_price_id: null,
    new_stripe_price_id: null,
    changed_by: 'sa-1',
    reason: '理由',
    effective_at: '2026-10-30T00:00:00.000Z',
    applies_to: 'new_only',
    created_at: '2026-10-30T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * subscription_plans の 1 行と plan_price_history を持つフェイクの DB。
 * eq / is / not ('is', null) の条件を本当に行に当て、条件が合わない更新は 0 行 (data: null) にする (route の条件つきの更新を確かめるため)。
 * beforeUpdate は、route が読んでから書くまでのあいだの割り込み (別の運営の変更) を 1 回だけ起こす
 */
function createDb(initialPlan: Row, history: Row[] = []) {
  const state = {
    plan: { ...initialPlan } as Row,
    history,
    updates: [] as Row[],
    beforeUpdate: null as null | ((plan: Row) => Row),
  };

  function builder(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let pendingUpdate: Row | null = null;
    function run(): { data: unknown; error: null } {
      if (table === 'plan_price_history') return { data: state.history, error: null };
      if (table !== 'subscription_plans') throw new Error(`想定していないテーブル: ${table}`);
      if (pendingUpdate) {
        if (state.beforeUpdate) {
          state.plan = state.beforeUpdate(state.plan);
          state.beforeUpdate = null;
        }
        if (!filters.every((matches) => matches(state.plan))) return { data: null, error: null };
        state.updates.push(pendingUpdate);
        state.plan = { ...state.plan, ...pendingUpdate };
        return { data: { ...state.plan }, error: null };
      }
      return { data: filters.every((matches) => matches(state.plan)) ? { ...state.plan } : null, error: null };
    }
    const b = {
      select: () => b,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return b;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => (row[column] ?? null) === value);
        return b;
      },
      not: (column: string, operator: string, value: unknown) => {
        if (operator !== 'is' || value !== null) throw new Error(`想定していない not: ${column} ${operator}`);
        filters.push((row) => (row[column] ?? null) !== null);
        return b;
      },
      order: () => b,
      limit: () => b,
      update: (values: Row) => {
        pendingUpdate = values;
        return b;
      },
      single: async () => run(),
      maybeSingle: async () => run(),
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(run()).then(onFulfilled, onRejected),
    };
    return b;
  }

  return { state, client: { from: (table: string) => builder(table) } };
}

let fakeDb: ReturnType<typeof createDb>;
let container: HTMLDivElement;
let root: Root;
const patchBodies: Row[] = [];

function patchRequest(body: unknown) {
  return new Request(`http://localhost/api/super-admin/plans/${PLAN_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

const routeContext = () => ({ params: Promise.resolve({ id: PLAN_ID }) });

/** 画面の fetch を本物の route の GET / PATCH へつなぐ */
function connectPageToRoute() {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const request = new Request(`http://localhost${url}`, {
      method: init?.method ?? 'GET',
      headers: init?.headers,
      body: init?.body,
    }) as never;
    if (init?.method === 'PATCH') {
      patchBodies.push(JSON.parse(init.body ?? '{}') as Row);
      return PATCH(request, routeContext());
    }
    return GET(request, routeContext());
  });
  vi.stubGlobal('fetch', fetchMock);
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDetail() {
  await act(async () => {
    root.render(createElement(PlanDetailPage));
  });
  await vi.waitFor(() => expect(container.querySelector('[data-testid="plan-stripe-product-id"]')).not.toBeNull());
}

const productInput = () => container.querySelector<HTMLInputElement>('[data-testid="plan-stripe-product-id"]')!;
const productHelp = () => container.querySelector('[data-testid="plan-stripe-product-id-help"]')?.textContent ?? '';
const text = () => container.textContent ?? '';
const buttonWith = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(element: HTMLElement | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeDefined();
  await act(async () => {
    element!.click();
  });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  patchBodies.length = 0;
  mockRequireRole.mockResolvedValue({ id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('Z1-1: プラン詳細の基本情報で Stripe の Product ID を入れて保存できる (#2112)', () => {
  it('公開中で Price がまだ無いプランは、入力欄に入れて保存すると PATCH で送り (前後の空白を外す)、DB に入り、読み直した値が出る', async () => {
    fakeDb = createDb(planRow());
    connectPageToRoute();
    await renderDetail();

    expect(productInput().disabled).toBe(false);
    expect(productInput().value).toBe('');
    await typeInto(productInput(), `  ${PRODUCT_ID} `);
    await click(buttonWith('保存する'), '「保存する」のボタン');
    await vi.waitFor(() => expect(text()).toContain('保存しました'));

    // 送ったのは変えた欄 (Product ID) だけ。空白は外して送る
    expect(patchBodies).toEqual([{ stripe_product_id: PRODUCT_ID }]);
    expect(fakeDb.state.plan.stripe_product_id).toBe(PRODUCT_ID);
    // 公開中のまま (状態は変えない)・監査は 1 行
    expect(fakeDb.state.plan.status).toBe('public');
    expect(mockRecordAdminAudit).toHaveBeenCalledTimes(1);
    // 読み直した値が入力欄に出る (書きかけではない)
    expect(productInput().value).toBe(PRODUCT_ID);

    // もう一度保存しても、変えていなければ送らない
    await click(buttonWith('保存する'), '「保存する」のボタン');
    expect(patchBodies).toHaveLength(1);
    expect(text()).toContain('変更した項目がないので、保存していません');
  });

  it('入力欄を空にして保存すると null を送って外す', async () => {
    fakeDb = createDb(planRow({ stripe_product_id: PRODUCT_ID }));
    connectPageToRoute();
    await renderDetail();

    expect(productInput().value).toBe(PRODUCT_ID);
    await typeInto(productInput(), '   ');
    await click(buttonWith('保存する'), '「保存する」のボタン');
    await vi.waitFor(() => expect(text()).toContain('保存しました'));

    expect(patchBodies).toEqual([{ stripe_product_id: null }]);
    expect(fakeDb.state.plan.stripe_product_id).toBeNull();
  });

  it('Stripe の Price を作ったあとの公開中のプランは、入力欄を止めて理由を出す (送らない)', async () => {
    fakeDb = createDb(planRow({ stripe_product_id: PRODUCT_ID, stripe_price_id: MONTHLY_PRICE_ID }));
    connectPageToRoute();
    await renderDetail();

    expect(productInput().disabled).toBe(true);
    expect(productInput().value).toBe(PRODUCT_ID);
    expect(productHelp()).toBe(PRODUCT_LOCKED_HELP);
  });

  it('下書きのプランは、Price ID があっても入力できる (下書きは全部の項目を変えられる)', async () => {
    fakeDb = createDb(planRow({ status: 'draft', stripe_yearly_price_id: 'price_yearly_x' }));
    connectPageToRoute();
    await renderDetail();

    expect(productInput().disabled).toBe(false);
    expect(productHelp()).not.toBe(PRODUCT_LOCKED_HELP);
  });

  it('廃止したプランは入力できない (ほかの欄と同じ)', async () => {
    fakeDb = createDb(planRow({ status: 'deprecated', ends_at: '2026-12-31T00:00:00.000Z' }));
    connectPageToRoute();
    await renderDetail();

    expect(productInput().disabled).toBe(true);
  });
});

describe('Z1-1: PATCH /api/super-admin/plans/{id} の stripe_product_id (#2112)', () => {
  it('公開中・非公開で Price がまだ無ければ 200 で書く (以前は 422 OP_PLAN_STATUS_LOCKED)', async () => {
    for (const status of ['public', 'private'] as const) {
      fakeDb = createDb(planRow({ status }));
      const res = await PATCH(patchRequest({ stripe_product_id: PRODUCT_ID }), routeContext());
      expect(res.status, status).toBe(200);
      expect(fakeDb.state.plan.stripe_product_id, status).toBe(PRODUCT_ID);
    }
  });

  it('公開中で月額か年額の Price ID があれば 422 OP_PLAN_STATUS_LOCKED で、理由の文を返し、書かない', async () => {
    for (const ids of [
      { stripe_price_id: MONTHLY_PRICE_ID, stripe_yearly_price_id: null },
      { stripe_price_id: null, stripe_yearly_price_id: 'price_yearly_pro' },
    ]) {
      fakeDb = createDb(planRow({ stripe_product_id: PRODUCT_ID, ...ids }));
      const res = await PATCH(patchRequest({ stripe_product_id: 'prod_other' }), routeContext());
      expect(res.status).toBe(422);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error).toEqual({ code: 'OP_PLAN_STATUS_LOCKED', message: STRIPE_PRODUCT_ID_LOCKED_MESSAGE });
      expect(fakeDb.state.updates).toEqual([]);
      expect(fakeDb.state.plan.stripe_product_id).toBe(PRODUCT_ID);
    }
  });

  it('ほかの変えられない項目と一緒なら、項目の一覧の文 (Product ID も並ぶ)', async () => {
    fakeDb = createDb(planRow({ stripe_price_id: MONTHLY_PRICE_ID }));
    const res = await PATCH(patchRequest({ stripe_product_id: PRODUCT_ID, trial_days: 3 }), routeContext());
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('OP_PLAN_STATUS_LOCKED');
    expect(json.error.message).toContain('Stripe の商品の ID (stripe_product_id)');
    expect(json.error.message).toContain('試用の日数 (trial_days)');
  });

  it('読んでから書くまでに別の運営が価格の変更で Price を作っていたら、書かずに 409 CONFLICT_STALE_DATA', async () => {
    fakeDb = createDb(planRow());
    fakeDb.state.beforeUpdate = (plan) => ({ ...plan, stripe_price_id: MONTHLY_PRICE_ID });
    const res = await PATCH(patchRequest({ stripe_product_id: PRODUCT_ID }), routeContext());
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('CONFLICT_STALE_DATA');
    expect(fakeDb.state.updates).toEqual([]);
    expect(fakeDb.state.plan.stripe_product_id).toBeNull();
    expect(mockRecordAdminAudit).not.toHaveBeenCalled();
  });

  it('空・空白だけの文字列は 400 OP_INVALID_INPUT で書かない (外すときは null)', async () => {
    for (const value of ['', '   ']) {
      fakeDb = createDb(planRow());
      const res = await PATCH(patchRequest({ stripe_product_id: value }), routeContext());
      expect(res.status, JSON.stringify(value)).toBe(400);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe('OP_INVALID_INPUT');
      expect(json.error.message).toContain(STRIPE_PRODUCT_ID_EMPTY_MESSAGE);
      expect(fakeDb.state.updates).toEqual([]);
    }
    fakeDb = createDb(planRow({ stripe_product_id: PRODUCT_ID }));
    const res = await PATCH(patchRequest({ stripe_product_id: null }), routeContext());
    expect(res.status).toBe(200);
    expect(fakeDb.state.plan.stripe_product_id).toBeNull();
  });

  it('PlanUpdateSchema は前後の空白を外す', () => {
    const parsed = PlanUpdateSchema.safeParse({ stripe_product_id: ` ${PRODUCT_ID}\t` });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.stripe_product_id).toBe(PRODUCT_ID);
  });

  it('isStripeProductIdEditable: 下書きは常に・公開中 / 非公開は Price ID が両方無いときだけ・廃止は変えない', () => {
    const noIds = { stripe_price_id: null, stripe_yearly_price_id: null };
    expect(isStripeProductIdEditable({ status: 'draft', stripe_price_id: 'p', stripe_yearly_price_id: 'y' })).toBe(true);
    expect(isStripeProductIdEditable({ status: 'public', ...noIds })).toBe(true);
    expect(isStripeProductIdEditable({ status: 'private', ...noIds })).toBe(true);
    expect(isStripeProductIdEditable({ status: 'public', stripe_price_id: 'p', stripe_yearly_price_id: null })).toBe(false);
    expect(isStripeProductIdEditable({ status: 'private', stripe_price_id: null, stripe_yearly_price_id: 'y' })).toBe(false);
    expect(isStripeProductIdEditable({ status: 'deprecated', ...noIds })).toBe(false);
  });
});

describe('Z1-1: 価格の変更の画面は、Stripe の Price を作れない理由を出す (#2112)', () => {
  /** 価格の変更の画面のプラン (GET の本文) */
  const changePlan = (overrides: Row = {}) => ({
    ...planRow(),
    stripe_price_sync_expected: false,
    ...overrides,
  });

  async function renderPriceChange(plan: Row) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: plan }), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    await act(async () => {
      root.render(createElement(Suspense, { fallback: null }, createElement(PriceChangePage)));
    });
    await settle();
  }

  const reasonBox = () => container.querySelector('[data-testid="price-change-stripe-price-unavailable"]');

  it('Product ID が無く Price ID もまだ無いと、今の価格のままでは「変更がありません」に加えて Product ID が未設定の理由とプラン詳細へのリンクを出す', async () => {
    await renderPriceChange(changePlan({ stripe_product_id: null }));

    expect(text()).toContain('変更がありません');
    expect(reasonBox()?.textContent).toContain(PRODUCT_MISSING_REASON);
    expect(reasonBox()?.querySelector('a')?.getAttribute('href')).toBe(`/super-admin/plans/${PLAN_ID}?tab=basic`);
    expect(buttonWith('影響をシミュレーション')?.disabled).toBe(true);
  });

  it('Product ID はあるが Stripe の鍵が無い (同期が要らない) と、鍵が無い理由を出す (リンクは出さない)', async () => {
    await renderPriceChange(changePlan({ stripe_product_id: PRODUCT_ID }));

    expect(reasonBox()?.textContent).toBe(KEY_MISSING_REASON);
    expect(reasonBox()?.querySelector('a')).toBeNull();
  });

  it('片方の間隔だけ Price ID が無いときも理由を出す', async () => {
    await renderPriceChange(changePlan({ stripe_product_id: null, stripe_price_id: MONTHLY_PRICE_ID }));

    expect(reasonBox()?.textContent).toContain(PRODUCT_MISSING_REASON);
  });

  it('月額・年額の Price ID がどちらもあれば、理由は出さない (「変更がありません」だけ)', async () => {
    await renderPriceChange(changePlan({ stripe_price_id: MONTHLY_PRICE_ID, stripe_yearly_price_id: 'price_yearly_pro' }));

    expect(text()).toContain('変更がありません');
    expect(reasonBox()).toBeNull();
  });

  it('価格が無い間隔 (年額が null) は Price を作らないので数えない', async () => {
    await renderPriceChange(changePlan({ yearly_price_jpy: null, stripe_price_id: MONTHLY_PRICE_ID }));

    expect(reasonBox()).toBeNull();
  });

  it('Stripe の同期が要るプランでは理由を出さず、今の価格のまま「Stripe の Price を作る」へ進める (#2107 Y2 のまま)', async () => {
    await renderPriceChange(changePlan({ stripe_product_id: PRODUCT_ID, stripe_price_sync_expected: true }));

    expect(reasonBox()).toBeNull();
    expect(text()).not.toContain('変更がありません');
    expect(buttonWith('影響をシミュレーション')?.disabled).toBe(false);
  });

  it('価格を変えているあいだは理由を出さない (送れるので)', async () => {
    await renderPriceChange(changePlan({ stripe_product_id: null }));
    const yearlyInput = container.querySelectorAll<HTMLInputElement>('input[type="number"]')[1];
    await typeInto(yearlyInput!, String(NEW_YEARLY));

    expect(reasonBox()).toBeNull();
    expect(text()).not.toContain('変更がありません');
  });
});

describe('Z1-2: プラン詳細の価格変更履歴のタブ (#2112)', () => {
  async function openHistory(history: Row[]) {
    fakeDb = createDb(planRow({ stripe_product_id: PRODUCT_ID }), history);
    connectPageToRoute();
    await renderDetail();
    await click(buttonWith('価格変更履歴'), '「価格変更履歴」のタブ');
  }

  const historyRows = () => Array.from(container.querySelectorAll('tbody tr'));
  const cells = (row: Element) => Array.from(row.querySelectorAll('td')).map((td) => td.textContent ?? '');

  it('適用範囲は日本語の名前で出し、英字の値 (new_only・on_renewal・immediately) は出さない', async () => {
    await openHistory([
      historyRow({ applies_to: 'new_only' }),
      historyRow({ applies_to: 'on_renewal' }),
      historyRow({ applies_to: 'immediately' }),
    ]);

    const appliesTo = historyRows().map((row) => cells(row)[5]);
    expect(appliesTo).toEqual(['新規契約のみ', '更新時から', '即時']);
    for (const value of PRICE_HISTORY_APPLIES_TO) expect(text()).not.toContain(value);
  });

  it('見出しは 変更日・旧月額・新月額・旧年額・新年額・適用範囲・Stripe の Price・理由', async () => {
    await openHistory([historyRow()]);

    const headers = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['変更日', '旧月額', '新月額', '旧年額', '新年額', '適用範囲', 'Stripe の Price', '理由']);
  });

  it('年額だけを変えた行は、月額が同じ値で並び、年額の差が見える', async () => {
    await openHistory([historyRow({ new_yearly_price_jpy: NEW_YEARLY, reason: '年額の改定' })]);

    const [row] = historyRows();
    expect(cells(row!).slice(1, 5)).toEqual([`¥${MONTHLY}`, `¥${MONTHLY}`, '¥5,800', '¥6,200']);
    expect(cells(row!)[6]).toBe('—');
  });

  it('月額の Stripe の Price ID が入った行 (販売開始の Price の登録) には印を出し、無い行には出さない', async () => {
    await openHistory([historyRow({ new_stripe_price_id: MONTHLY_PRICE_ID, reason: '販売開始' }), historyRow({ reason: '価格だけ' })]);

    const [registered, priceOnly] = historyRows();
    expect(cells(registered!)[6]).toBe(MONTHLY_PRICE_CHANGED_MARK);
    expect(registered!.querySelector('[data-testid="price-history-stripe-price-changed"]')).not.toBeNull();
    expect(cells(priceOnly!)[6]).toBe('—');
    // Price ID の値そのものは出さない
    expect(text()).not.toContain(MONTHLY_PRICE_ID);
  });

  it('履歴が無いときの行は全部の列にまたがる', async () => {
    await openHistory([]);

    const emptyCell = container.querySelector('tbody td');
    expect(emptyCell?.textContent).toBe('価格変更履歴がありません');
    expect(emptyCell?.getAttribute('colspan')).toBe(String(container.querySelectorAll('thead th').length));
  });
});

describe('Z1 の同じ型: プラン詳細の基本情報の種別 (#2112)', () => {
  it('種別は日本語の名前で出し、英字の値 (personal・family・org) は出さない', async () => {
    for (const [planType, label] of [
      ['personal', '個人'],
      ['family', '家族'],
      ['org', '組織'],
    ] as const) {
      fakeDb = createDb(planRow({ plan_type: planType, plan_key: planType === 'org' ? 'org_starter' : 'pro' }));
      connectPageToRoute();
      await renderDetail();
      expect(container.querySelector('[data-testid="plan-type-label"]')?.textContent, planType).toBe(label);
      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
    }
  });

  it('PLAN_TYPE_LABELS は PLAN_TYPES の全部の値を持ち、プランの一覧の TYPE_LABELS と同じ語', () => {
    expect(Object.keys(PLAN_TYPE_LABELS).sort()).toEqual([...PLAN_TYPES].sort());
    const listSource = fs.readFileSync(path.resolve(__dirname, '..', 'src/app/super-admin/plans/page.tsx'), 'utf-8');
    for (const [value, label] of Object.entries(PLAN_TYPE_LABELS)) {
      expect(listSource).toContain(`${value}: { label: '${label}'`);
    }
    expect(planTypeLabel('unknown_type')).toBe('unknown_type');
  });
});

describe('Z1-2: 適用範囲の名前の表 (#2112)', () => {
  it('DB の CHECK (plan_price_history_applies_to_check) の値と、名前の表の値が同じ', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '..', 'supabase/migrations/20251126124224_create_meal_planner_tables.sql'),
      'utf-8',
    );
    const check = migration.match(/CONSTRAINT "plan_price_history_applies_to_check" CHECK \(([^\n]*)\)/)?.[1];
    expect(check, 'plan_price_history_applies_to_check が見つからない').toBeDefined();
    const dbValues = [...check!.matchAll(/'([a-z_]+)'::character varying/g)].map(([, value]) => value).sort();
    expect([...PRICE_HISTORY_APPLIES_TO].sort()).toEqual(dbValues);
    expect(Object.keys(PRICE_APPLIES_TO_LABELS).sort()).toEqual(dbValues);
  });

  it('価格の変更が書く値 (PRICE_APPLIES_TO) はすべて名前の表にある', () => {
    for (const value of PRICE_APPLIES_TO) expect(PRICE_APPLIES_TO_LABELS[value]).toBe('新規契約のみ');
  });

  it('priceAppliesToLabel: 表の値は日本語の名前・知らない値はそのまま', () => {
    expect(priceAppliesToLabel('new_only')).toBe('新規契約のみ');
    expect(priceAppliesToLabel('on_renewal')).toBe('更新時から');
    expect(priceAppliesToLabel('immediately')).toBe('即時');
    expect(priceAppliesToLabel('someday')).toBe('someday');
  });

  it('価格の変更の画面の適用範囲も同じ名前の表から引く (直書きしない)', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/app/super-admin/plans/[id]/price-change/page.tsx'), 'utf-8');
    expect(source).toContain('const APPLIES_TO_LABEL = PRICE_APPLIES_TO_LABELS.new_only;');
    expect(source).not.toMatch(/['"]新規契約のみ['"]/);
  });
});
