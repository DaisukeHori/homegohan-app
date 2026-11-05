/**
 * #2254 M2 運営の価格の変更の画面 (/super-admin/plans/[id]/price-change) の適用開始日時の回帰テスト。
 *
 * 問題 (直す前): 適用開始日時の既定値は new Date().toISOString().slice(0, 16) (UTC の壁時計) で、送るときは
 *   new Date(欄の値).toISOString() (端末のローカル時刻として読む) にしていた。日本の端末 (Asia/Tokyo) では、JST 15:07 に開くと
 *   欄には 06:07 が出て、06:07 JST (押した時刻の 9 時間前) として送られた。サーバーの schema (z.string().datetime()) は過去の時刻も
 *   通すので止まらない。欄を空にすると new Date('').toISOString() が送信の try の中で投げ、応答を受け取れなかったものとして扱った
 * 直したあと: 運営の画面の日時は日本時間に固定する (src/lib/admin/jst-datetime-local.ts)。既定値は開いた時刻の日本時間の壁時計で、
 *   送る effective_at は欄の値を日本時間として読んだ時刻。どの端末のタイムゾーンでも、既定のまま送ると今の時刻 (分まで) になる。
 *   欄が空なら送らず、文を出す
 *
 * どれも直す前の形で赤になる (日本・西の端末では送る時刻が 9 時間・それ以上ずれ、UTC の端末では欄の値が日本時間の壁時計でない)。
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withTimeZoneAsync } from './helpers/time-zones';

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
const PLAN_PATH = `/api/super-admin/plans/${ROW_ID}`;
const IMPACT_PATH = `/api/super-admin/plans/${ROW_ID}/price-impact`;
const CHANGE_PATH = `/api/super-admin/plans/${ROW_ID}/price-change`;
const CREATE_PRICE_LABEL = 'Stripe の Price を作る';

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


/** 開いた時刻 (JST 2026-11-05 (木) 15:07:42 = UTC 06:07:42) */
const OPENED_AT = '2026-11-05T06:07:42.000Z';
/** 開いた時刻の日本時間の壁時計 (欄の既定値) */
const OPENED_AT_JST_WALL_CLOCK = '2026-11-05T15:07';
/** 既定のまま送ったときの effective_at (開いた時刻の分まで) */
const OPENED_AT_MINUTE_ISO = '2026-11-05T06:07:00.000Z';
/** 欄を空にして押したときの文 */
const EFFECTIVE_AT_INVALID_MESSAGE = '適用開始日時を入力してください';
/** 端末のタイムゾーン: 日本・UTC・UTC より西 (夏時間あり) */
const DEVICE_TIME_ZONES = ['Asia/Tokyo', 'UTC', 'America/Los_Angeles'] as const;

const effectiveAtInput = () => container.querySelector<HTMLInputElement>('input[type="datetime-local"]');

describe('適用開始日時は日本時間で読み書きする (#2254 M2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(OPENED_AT));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const tz of DEVICE_TIME_ZONES) {
    it(`端末が ${tz}: 既定値は開いた時刻の日本時間で、既定のまま送ると effective_at は開いた時刻 (分まで)`, async () => {
      await withTimeZoneAsync(tz, async () => {
        mockServer({ plans: [() => jsonResponse(200, { data: planWith() })], changes: [() => jsonResponse(200, { data: {} })] });
        await renderPage();
        await goToConfirmWithoutChangingPrices();

        expect(effectiveAtInput()?.value, '欄の既定値が日本時間の壁時計でない').toBe(OPENED_AT_JST_WALL_CLOCK);
        await click(buttonWith(CREATE_PRICE_LABEL), '「Stripe の Price を作る」のボタン');

        expect(changeBodies()).toHaveLength(1);
        expect(changeBodies()[0]!.effective_at, '送った適用開始が開いた時刻でない').toBe(OPENED_AT_MINUTE_ISO);
      });
    });
  }

  it('欄に入れた日時は日本時間として送る (端末が UTC より西でも)', async () => {
    await withTimeZoneAsync('America/Los_Angeles', async () => {
      mockServer({ plans: [() => jsonResponse(200, { data: planWith() })], changes: [() => jsonResponse(200, { data: {} })] });
      await renderPage();
      await goToConfirmWithoutChangingPrices();
      await typeInto(effectiveAtInput(), '2026-12-01T00:00', '適用開始日時の欄');
      await click(buttonWith(CREATE_PRICE_LABEL), '「Stripe の Price を作る」のボタン');

      // JST 2026-12-01 0:00 = UTC 2026-11-30 15:00
      expect(changeBodies()[0]!.effective_at).toBe('2026-11-30T15:00:00.000Z');
    });
  });

  it('欄を空にして押すと送らず、文を出す (直す前は送信の中で投げ、応答を受け取れなかったものとして読み直した)', async () => {
    mockServer({ plans: [() => jsonResponse(200, { data: planWith() })], changes: [() => jsonResponse(200, { data: {} })] });
    await renderPage();
    await goToConfirmWithoutChangingPrices();
    await typeInto(effectiveAtInput(), '', '適用開始日時の欄');
    await click(buttonWith(CREATE_PRICE_LABEL), '「Stripe の Price を作る」のボタン');

    expect(changeBodies()).toEqual([]);
    expect(text()).toContain(EFFECTIVE_AT_INVALID_MESSAGE);
    expect(routerPush).not.toHaveBeenCalled();
    // 文を出したあとも押し直せる (送信を止めていない)
    expect(buttonWith(CREATE_PRICE_LABEL)?.disabled).toBe(false);
  });
});
