/**
 * #2101 X1: 価格の変更の画面 (/super-admin/plans/[id]/price-change) は、応答を受け取れなかったあとに押し直させない
 *
 * 以前の画面は、価格の変更の応答を受け取れなかった (fetch の reject・本文の無い 502 / 504) とき、失敗の文を出してボタンを戻すだけで、
 * 読み直しも送信の止めも無かった (plan は古いまま、monthlyChanged もそのまま)。押し直すと、1 回目で済んでいても
 * 同じ金額でもう一度 Stripe に新しい Price が作られ、履歴と監査に 2 行目が入った。
 * 直したあと (不変条件):
 *   - 応答を受け取れなかったら (AdminActionNoResponseError) プランを読み直し、価格が送った値になっていれば済んだとして履歴へ移る
 *   - 読み直したプランが送った値になっていなければ、画面のプランを読み直した値にし、済んでいないことを出す (もう一度実行できる)
 *   - 読み直せなければ送信を止め、「済んだか分かりません。履歴で確かめてください」と履歴へのリンクを出す
 *   - 409 OP_PRICE_UNCHANGED (すでにこの価格) は済んだものとして履歴へ移る。ほかの 409 はこれまでどおり文を出す
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRICE_UNCHANGED_CODE, PRICE_UNCHANGED_MESSAGE } from '@/lib/super-admin/price-change-unchanged';
import { PRICE_CHANGE_IN_PROGRESS_MESSAGE } from '@/lib/super-admin/plan-price-change-reservation';

const ROW_ID = '21012101-2101-4101-8101-210121012101';
const nav = vi.hoisted(() => {
  const push = vi.fn();
  return { push, router: { push, replace: () => undefined, refresh: () => undefined, back: () => undefined } };
});
const routerPush = nav.push;

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '21012101-2101-4101-8101-210121012101' }),
  useRouter: () => nav.router,
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: PriceChangePage } = await import('@/app/super-admin/plans/[id]/price-change/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 今の月額 (読み込んだプラン) */
const OLD_MONTHLY = 580;
/** 画面で入れる新しい月額 */
const NEW_MONTHLY = 680;
const HISTORY_PATH = `/super-admin/plans/${ROW_ID}?tab=history`;
const PLAN_PATH = `/api/super-admin/plans/${ROW_ID}`;
const IMPACT_PATH = `/api/super-admin/plans/${ROW_ID}/price-impact`;
const CHANGE_PATH = `/api/super-admin/plans/${ROW_ID}/price-change`;
/** 読み直せなかったときの案内 */
const UNCONFIRMED_GUIDE = '済んだか分かりません。履歴で確かめてください';
/** 画面に出てはいけない英字の文 */
const ENGLISH_LEAKS = ['Failed to fetch', 'SyntaxError', 'TypeError', 'Unexpected token', 'Bad Gateway', 'Gateway Timeout', PRICE_UNCHANGED_CODE];

const planWith = (monthly: number) => ({
  id: ROW_ID,
  plan_key: 'pro',
  plan_type: 'personal',
  display_name: 'Pro',
  monthly_price_jpy: monthly,
  yearly_price_jpy: null,
  status: 'public',
});
const IMPACT = {
  affected_subscription_count: 0,
  affected_mrr_change_jpy: 0,
  current_monthly_price_jpy: OLD_MONTHLY,
  new_monthly_price_jpy: NEW_MONTHLY,
  applies_to: 'new_only',
  effective_timing: 'new_only',
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
/** 本文が JSON でない応答 (プロキシの 502 / 504 の HTML) */
const htmlResponse = (status: number) =>
  new Response('<html><body>Gateway Timeout</body></html>', { status, headers: { 'content-type': 'text/html' } });
/** 通信の reject (応答が切れた・届かなかった) */
const networkFailure = () => new TypeError('Failed to fetch');

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

type Responder = () => Response;

/**
 * 偽のサーバー。plans は GET /plans/{id} の応答を順に返す (最後のものを使い続ける)。change は POST price-change の応答を順に返す
 */
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

/** 新しい月額を入れてシミュレーションし、確認ステップで理由を入れて実行する */
async function execute() {
  await typeInto(container.querySelectorAll('input[type="number"]')[0], String(NEW_MONTHLY), '新しい月額の欄');
  await click(buttonWith('影響をシミュレーション'), 'シミュレーションのボタン');
  await click(buttonWith('確認ステップへ'), '確認ステップへ');
  await typeInto(container.querySelector('textarea'), '価格の見直し', '変更理由の欄');
  await click(buttonWith('価格変更を実行する'), '実行のボタン');
}

const text = () => container.textContent ?? '';

function expectNoLeak() {
  for (const leak of ENGLISH_LEAKS) expect(text(), `「${leak}」が出ている`).not.toContain(leak);
}

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

describe('価格の変更の応答を受け取れなかったら、プランを読み直して確かめる (#2101 X1)', () => {
  it.each([
    ['通信の reject', () => { throw networkFailure(); }],
    ['本文の無い 504', () => htmlResponse(504)],
    ['本文の無い 502', () => htmlResponse(502)],
  ] as const)('%s のあと、読み直したプランが送った月額になっていれば済んだとして履歴へ移る (押し直させない)', async (_label, change) => {
    mockServer({ plans: [() => jsonResponse(200, { data: planWith(OLD_MONTHLY) }), () => jsonResponse(200, { data: planWith(NEW_MONTHLY) })], changes: [change] });
    await renderPage();

    await execute();

    expect(callsOf('POST', CHANGE_PATH)).toHaveLength(1);
    // 読み込み + 読み直し
    expect(callsOf('GET', PLAN_PATH)).toHaveLength(2);
    expect(routerPush).toHaveBeenCalledWith(HISTORY_PATH);
    expectNoLeak();
  });

  it('読み直したプランが送った月額になっていなければ、画面のプランを読み直した値にし、済んでいないことを出す (もう一度実行できる)', async () => {
    const OTHER_MONTHLY = 600;
    mockServer({
      plans: [() => jsonResponse(200, { data: planWith(OLD_MONTHLY) }), () => jsonResponse(200, { data: planWith(OTHER_MONTHLY) })],
      changes: [() => { throw networkFailure(); }, () => jsonResponse(200, { data: {} })],
    });
    await renderPage();

    await execute();

    expect(routerPush).not.toHaveBeenCalled();
    expect(text()).toContain('価格変更の応答を受け取れませんでした（通信エラー）');
    expect(text()).toContain('送った価格になっていません');
    // 確認の画面の旧月額は読み直した値
    expect(text()).toContain(`¥${OTHER_MONTHLY.toLocaleString()} → ¥${NEW_MONTHLY.toLocaleString()}`);
    expect(text()).not.toContain(UNCONFIRMED_GUIDE);
    expectNoLeak();

    const executeButton = buttonWith('価格変更を実行する');
    expect(executeButton?.disabled).toBe(false);
    await click(executeButton, '実行のボタン (2 回目)');
    expect(callsOf('POST', CHANGE_PATH)).toHaveLength(2);
    expect(routerPush).toHaveBeenCalledWith(HISTORY_PATH);
  });

  it.each([
    ['本文の無い 502', () => htmlResponse(502)],
    ['通信の reject', () => { throw networkFailure(); }],
    ['401', () => jsonResponse(401, { error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } })],
    ['200 なのに行が無い', () => jsonResponse(200, { data: null })],
  ] as const)('読み直しが %s で失敗したら、送信を止め、「済んだか分かりません。履歴で確かめてください」と履歴へのリンクを出す', async (_label, reread) => {
    mockServer({
      plans: [() => jsonResponse(200, { data: planWith(OLD_MONTHLY) }), reread],
      changes: [() => { throw networkFailure(); }],
    });
    await renderPage();

    await execute();

    expect(routerPush).not.toHaveBeenCalled();
    expect(text()).toContain('価格変更の応答を受け取れませんでした（通信エラー）');
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    const historyLink = Array.from(container.querySelectorAll('a')).find((a) => a.getAttribute('href') === HISTORY_PATH);
    expect(historyLink, '履歴へのリンクが無い').toBeDefined();
    expectNoLeak();

    // 送信を止める: 実行のボタンは押せず、押しても送らない
    const executeButton = buttonWith('価格変更を実行する');
    expect(executeButton?.disabled).toBe(true);
    await act(async () => {
      executeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(callsOf('POST', CHANGE_PATH)).toHaveLength(1);

    // 確認のステップから戻っても止めたまま (案内も消えない)
    await click(buttonWith('← 戻る'), '戻るのボタン');
    expect(text()).toContain(UNCONFIRMED_GUIDE);
    await click(buttonWith('確認ステップへ'), '確認ステップへ');
    expect(buttonWith('価格変更を実行する')?.disabled).toBe(true);
    expect(callsOf('POST', CHANGE_PATH)).toHaveLength(1);
  });
});

describe('409 OP_PRICE_UNCHANGED (すでにこの価格) は済んだものとして履歴へ移る (#2101 X1)', () => {
  it('409 OP_PRICE_UNCHANGED なら履歴へ移り、失敗の文を出さない', async () => {
    mockServer({
      plans: [() => jsonResponse(200, { data: planWith(OLD_MONTHLY) })],
      changes: [() => jsonResponse(409, { error: { code: PRICE_UNCHANGED_CODE, message: PRICE_UNCHANGED_MESSAGE } })],
    });
    await renderPage();

    await execute();

    expect(routerPush).toHaveBeenCalledWith(HISTORY_PATH);
    expect(text()).not.toContain('失敗しました');
    expectNoLeak();
  });

  it('ほかの 409 (価格の変更が進行中) はこれまでどおり本文の文を出し、履歴へ移らない (プランを読み直さない)', async () => {
    const IN_PROGRESS = PRICE_CHANGE_IN_PROGRESS_MESSAGE;
    mockServer({
      plans: [() => jsonResponse(200, { data: planWith(OLD_MONTHLY) })],
      changes: [() => jsonResponse(409, { error: { code: 'CONFLICT_STALE_DATA', message: IN_PROGRESS } })],
    });
    await renderPage();

    await execute();

    expect(routerPush).not.toHaveBeenCalled();
    expect(text()).toContain(IN_PROGRESS);
    expect(callsOf('GET', PLAN_PATH)).toHaveLength(1);
    expectNoLeak();
  });

  it('本文に API の文がある 502 (Stripe の同期の失敗) は失敗として本文の文を出す (読み直さない)', async () => {
    const SYNC_FAILED = 'Stripe との価格同期に失敗しました (HTTP 500)。DB は更新していません。';
    mockServer({
      plans: [() => jsonResponse(200, { data: planWith(OLD_MONTHLY) })],
      changes: [() => jsonResponse(502, { error: { code: 'OP_STRIPE_SYNC_FAILED', message: SYNC_FAILED } })],
    });
    await renderPage();

    await execute();

    expect(routerPush).not.toHaveBeenCalled();
    expect(text()).toContain(SYNC_FAILED);
    expect(callsOf('GET', PLAN_PATH)).toHaveLength(1);
    expect(buttonWith('価格変更を実行する')?.disabled).toBe(false);
  });
});
