/**
 * #2107 Y2・Y6: 価格の変更の画面 (/super-admin/plans/[id]/price-change) から、販売開始の Stripe の Price を作れる
 *
 * Y2 (以前): 画面は今の価格と違うときだけ「シミュレーション」「実行」を押せた (hasAnyChange)。販売開始の手順
 *   (billing/03 §12 の順 3・billing/01 §17.3 の 1.) は、migration が入れた価格のまま price-change を呼んで Stripe の Price を作り
 *   ID を入れるので、画面からはできず、API を直接呼ぶか別の価格にしてから戻す (履歴に余計な 2 行・Stripe に余計な Price) しかなかった。
 * 直したあと (不変条件):
 *   - Stripe の同期が要るプラン (GET の stripe_price_sync_expected) で Price ID がまだ無い間隔は、今と同じ価格でも送れる
 *     (route の pendingPriceChange / priceChangeAlreadyApplied と同じ判定)。ボタンの文は「Stripe の Price を作る」
 *   - ID のある間隔・Stripe の同期が要らないプランは、これまでどおり今と同じ価格なら送らない (変更がありません)
 *   - 応答を受け取れなかったあとの読み直しは、価格が同じでも Price ID がまだ無ければ済んだとしない
 * Y6: 応答を受け取れなかったあと、読み直したプランが送った内容になっていないときの文に「まだ処理中のことがあります」を添える
 *   (route の 1 回目がまだ走っていることがある。押し直すと進行中の 409 になる)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROW_ID = '21072107-2107-4107-8107-210721072107';
const nav = vi.hoisted(() => {
  const push = vi.fn();
  return { push, router: { push, replace: () => undefined, refresh: () => undefined, back: () => undefined } };
});
const routerPush = nav.push;

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '21072107-2107-4107-8107-210721072107' }),
  useRouter: () => nav.router,
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: PriceChangePage } = await import('@/app/super-admin/plans/[id]/price-change/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** migration が入れた今の価格 (billing/03 §6.2 の pro) */
const MONTHLY = 580;
const YEARLY = 5800;
const HISTORY_PATH = `/super-admin/plans/${ROW_ID}?tab=history`;
const PLAN_PATH = `/api/super-admin/plans/${ROW_ID}`;
const IMPACT_PATH = `/api/super-admin/plans/${ROW_ID}/price-impact`;
const CHANGE_PATH = `/api/super-admin/plans/${ROW_ID}/price-change`;
const CREATE_PRICE_LABEL = 'Stripe の Price を作る';
const EXECUTE_LABEL = '価格変更を実行する';
const STILL_PROCESSING = 'まだ処理中のことがあります';

type PlanOverrides = Partial<{
  monthly_price_jpy: number | null;
  yearly_price_jpy: number | null;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  stripe_yearly_price_id: string | null;
  stripe_price_sync_expected: boolean;
}>;

/** 販売開始の前のプラン (Stripe の商品はあり、Price ID はまだ無い。Stripe の鍵がある環境) */
const planWith = (overrides: PlanOverrides = {}) => ({
  id: ROW_ID,
  plan_key: 'pro',
  plan_type: 'personal',
  display_name: '個人 Pro',
  monthly_price_jpy: MONTHLY,
  yearly_price_jpy: YEARLY,
  status: 'public',
  stripe_product_id: 'prod_pro',
  stripe_price_id: null,
  stripe_yearly_price_id: null,
  stripe_price_sync_expected: true,
  ...overrides,
});
const IMPACT = {
  affected_subscription_count: 0,
  affected_mrr_change_jpy: 0,
  current_monthly_price_jpy: MONTHLY,
  new_monthly_price_jpy: MONTHLY,
  applies_to: 'new_only',
  effective_timing: 'new_only',
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const networkFailure = () => new TypeError('Failed to fetch');

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

type Responder = () => Response;

function mockServer(options: { plans: Responder[]; changes: Responder[] }) {
  let planCalls = 0;
  let changeCalls = 0;
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.pathname === PLAN_PATH && method === 'GET') {
      const responder = options.plans[Math.min(planCalls, options.plans.length - 1)]!;
      planCalls++;
      return responder();
    }
    if (url.pathname === IMPACT_PATH) return jsonResponse(200, { data: IMPACT });
    if (url.pathname === CHANGE_PATH && method === 'POST') {
      const responder = options.changes[Math.min(changeCalls, options.changes.length - 1)]!;
      changeCalls++;
      return responder();
    }
    throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

const changeBodies = () =>
  fetchMock.mock.calls
    .filter(([input, init]) => ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST' && new URL(String(input), 'http://localhost').pathname === CHANGE_PATH)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage() {
  await act(async () => {
    root.render(createElement(Suspense, { fallback: null }, createElement(PriceChangePage)));
  });
  await settle();
}

const buttonWith = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));

async function click(element: HTMLElement | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeDefined();
  await act(async () => {
    element!.click();
  });
  await settle();
}

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

/** 価格は入れたまま (今と同じ) でシミュレーションし、確認ステップで理由を入れる */
async function goToConfirmWithoutChangingPrices() {
  await click(buttonWith('影響をシミュレーション'), 'シミュレーションのボタン');
  await click(buttonWith('確認ステップへ'), '確認ステップへ');
  await typeInto(container.querySelector('textarea'), '販売開始の Price の登録', '変更理由の欄');
}

const text = () => container.textContent ?? '';

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
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

describe('Y2: 販売開始の Stripe の Price を画面から作れる (#2107)', () => {
  it('Stripe の同期が要り、月額・年額の Price ID がまだ無いと、今と同じ価格のまま両方を送り「Stripe の Price を作る」で済む', async () => {
    mockServer({ plans: [() => jsonResponse(200, { data: planWith() })], changes: [() => jsonResponse(200, { data: {} })] });
    await renderPage();

    expect(text()).not.toContain('変更がありません');
    expect(buttonWith('影響をシミュレーション')?.disabled).toBe(false);
    await goToConfirmWithoutChangingPrices();

    const createButton = buttonWith(CREATE_PRICE_LABEL);
    expect(createButton, '「Stripe の Price を作る」のボタンが無い').toBeDefined();
    expect(createButton?.disabled).toBe(false);
    expect(buttonWith(EXECUTE_LABEL)).toBeUndefined();
    await click(createButton, '「Stripe の Price を作る」のボタン');

    expect(changeBodies()).toHaveLength(1);
    expect(changeBodies()[0]).toMatchObject({ new_monthly_price_jpy: MONTHLY, new_yearly_price_jpy: YEARLY, applies_to: 'new_only' });
    expect(routerPush).toHaveBeenCalledWith(HISTORY_PATH);
  });

  it('月額の Price ID はあり年額だけ無いと、年額だけを今と同じ価格で送る (月額の Price を作り直さない)', async () => {
    mockServer({
      plans: [() => jsonResponse(200, { data: planWith({ stripe_price_id: 'price_month_live' }) })],
      changes: [() => jsonResponse(200, { data: {} })],
    });
    await renderPage();

    await goToConfirmWithoutChangingPrices();
    await click(buttonWith(CREATE_PRICE_LABEL), '「Stripe の Price を作る」のボタン');

    expect(changeBodies()).toHaveLength(1);
    expect(changeBodies()[0]!.new_monthly_price_jpy ?? null).toBeNull();
    expect(changeBodies()[0]!.new_yearly_price_jpy).toBe(YEARLY);
  });

  it('価格も変えたときは、これまでどおり「価格変更を実行する」で送る (Price ID の無い間隔は同じ価格でも一緒に送る)', async () => {
    const NEW_MONTHLY = 680;
    mockServer({ plans: [() => jsonResponse(200, { data: planWith() })], changes: [() => jsonResponse(200, { data: {} })] });
    await renderPage();

    await typeInto(container.querySelectorAll('input[type="number"]')[0], String(NEW_MONTHLY), '新しい月額の欄');
    await goToConfirmWithoutChangingPrices();
    expect(buttonWith(CREATE_PRICE_LABEL)).toBeUndefined();
    await click(buttonWith(EXECUTE_LABEL), '実行のボタン');

    expect(changeBodies()[0]).toMatchObject({ new_monthly_price_jpy: NEW_MONTHLY, new_yearly_price_jpy: YEARLY });
  });

  it.each([
    ['Stripe の同期が要らない (鍵が無い・商品が無い)', planWith({ stripe_price_sync_expected: false })],
    ['月額・年額の Price ID がどちらも入っている', planWith({ stripe_price_id: 'price_m', stripe_yearly_price_id: 'price_y' })],
    ['GET の本文に stripe_price_sync_expected が無い', (() => {
      const { stripe_price_sync_expected: _omit, ...rest } = planWith();
      return rest;
    })()],
  ])('%s ときは、今と同じ価格では送れない (変更がありません)', async (_label, plan) => {
    mockServer({ plans: [() => jsonResponse(200, { data: plan })], changes: [() => jsonResponse(200, { data: {} })] });
    await renderPage();

    expect(text()).toContain('変更がありません');
    expect(buttonWith('影響をシミュレーション')?.disabled).toBe(true);
    expect(changeBodies()).toHaveLength(0);
  });

  it('応答を受け取れなかったあと、読み直したプランの Price ID がまだ無ければ (価格は同じでも) 済んだとせず、処理中のことがあると出す', async () => {
    mockServer({
      plans: [() => jsonResponse(200, { data: planWith() }), () => jsonResponse(200, { data: planWith() })],
      changes: [() => { throw networkFailure(); }],
    });
    await renderPage();

    await goToConfirmWithoutChangingPrices();
    await click(buttonWith(CREATE_PRICE_LABEL), '「Stripe の Price を作る」のボタン');

    expect(routerPush).not.toHaveBeenCalled();
    expect(text()).toContain(STILL_PROCESSING);
    expect(text()).toContain('履歴で確かめ');
  });

  it('応答を受け取れなかったあと、読み直したプランに Price ID が入っていれば済んだとして履歴へ移る', async () => {
    mockServer({
      plans: [
        () => jsonResponse(200, { data: planWith() }),
        () => jsonResponse(200, { data: planWith({ stripe_price_id: 'price_m_new', stripe_yearly_price_id: 'price_y_new' }) }),
      ],
      changes: [() => { throw networkFailure(); }],
    });
    await renderPage();

    await goToConfirmWithoutChangingPrices();
    await click(buttonWith(CREATE_PRICE_LABEL), '「Stripe の Price を作る」のボタン');

    expect(routerPush).toHaveBeenCalledWith(HISTORY_PATH);
  });
});

describe('Y6: 応答を受け取れず、読み直したプランが送った価格になっていないとき「まだ処理中のことがあります」を添える (#2107)', () => {
  it('価格の変更のあとの読み直しが今の価格のままなら、送った価格になっていないことと、まだ処理中のことがあることを出す', async () => {
    const NEW_MONTHLY = 680;
    const noSync = planWith({ stripe_price_sync_expected: false });
    mockServer({
      plans: [() => jsonResponse(200, { data: noSync }), () => jsonResponse(200, { data: noSync })],
      changes: [() => { throw networkFailure(); }],
    });
    await renderPage();

    await typeInto(container.querySelectorAll('input[type="number"]')[0], String(NEW_MONTHLY), '新しい月額の欄');
    await goToConfirmWithoutChangingPrices();
    await click(buttonWith(EXECUTE_LABEL), '実行のボタン');

    expect(routerPush).not.toHaveBeenCalled();
    expect(text()).toContain('送った価格になっていません');
    expect(text()).toContain(STILL_PROCESSING);
  });
});
