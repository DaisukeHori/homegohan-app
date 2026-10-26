/**
 * #2050 (P1 と同じ型) 運営の画面の、確認つきの操作が応答を待つ間もボタンを止めていなかった件のテスト
 *
 * 組織の招待の「取消」・部署の「削除」と同じく、次の操作は応答を待つ間もボタンを押せた。
 * 二度押しで 2 本目を送ると、1 本目で済んでいるのに 2 本目が断られて失敗の文 (alert) が出る。
 *   - 機能フラグの「削除」(/super-admin/flags)
 *   - A/B テストの「実験開始」・「完了」・「中止」(/super-admin/experiments/[id])
 *   - プランの「公開する」・「非公開にする」・「再公開する」・「廃止する」・「廃止を取り消す」(/super-admin/plans/[id])
 * (クーポンの停止・再開と機能パッケージの廃止は、もともと isChangingStatus / isDeprecating で止めている)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'plan-1' }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: FlagsPage } = await import('@/app/super-admin/flags/page');
const { default: ExperimentDetailPage } = await import('@/app/super-admin/experiments/[id]/page');
const { default: PlanDetailPage } = await import('@/app/super-admin/plans/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** あとで返す応答 (応答を待つ間の画面を確かめるため) */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'prompt').mockReturnValue('2027-01-01');
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

describe('機能フラグ: 削除の応答を待つ間はボタンを止める', () => {
  const FLAG = {
    key: 'new_feature',
    description: '',
    enabled: true,
    rollout_strategy: null,
    constraints: null,
    active_user_count: 0,
    updated_at: '2026-10-10T00:00:00Z',
  };
  const DELETE_PATH = `/api/super-admin/flags/${FLAG.key}`;

  it('二度押ししても 2 本目の DELETE を送らず、削除できたのに失敗の文を出さない', async () => {
    const del = deferred<Response>();
    let deleteCount = 0;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/super-admin/flags') return jsonResponse(200, { data: [FLAG] });
      if (method === 'DELETE' && url.pathname === DELETE_PATH) {
        deleteCount += 1;
        if (deleteCount > 1) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'フラグが見つかりません' } });
        return del.promise;
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FlagsPage));

    await click(findButton('削除'), '「削除」ボタン');
    expect(findButton('削除')!.disabled).toBe(true);
    await click(findButton('削除'), '「削除」ボタン (2 回目)');
    expect(callsOf('DELETE', DELETE_PATH)).toHaveLength(1);

    await act(async () => {
      del.resolve(jsonResponse(200, { data: { key: FLAG.key } }));
    });
    await settle();

    expect(callsOf('DELETE', DELETE_PATH)).toHaveLength(1);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(findButton('削除')).toBeUndefined();
  });

  it('削除が断られたら、ボタンを戻してもう一度押せる', async () => {
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/super-admin/flags') return jsonResponse(200, { data: [FLAG] });
      if (method === 'DELETE' && url.pathname === DELETE_PATH) return jsonResponse(500, { error: { message: 'サーバーエラーが発生しました' } });
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FlagsPage));

    await click(findButton('削除'), '「削除」ボタン');
    expect(alertSpy).toHaveBeenCalledWith('サーバーエラーが発生しました');
    expect(findButton('削除')!.disabled).toBe(false);
  });
});

describe('A/B テスト: 状態の変更の応答を待つ間はボタンを止める', () => {
  const EXPERIMENT = {
    id: 'exp-1',
    key: 'onboarding_copy',
    name: 'オンボーディングの文言',
    hypothesis: null,
    status: 'draft',
    start_date: null,
    end_date: null,
    variants: [
      { key: 'control', weight: 50 },
      { key: 'treatment', weight: 50 },
    ],
    primary_metric: null,
    created_at: '2026-10-01T00:00:00Z',
  };
  const PATH = `/api/super-admin/experiments/${EXPERIMENT.id}`;

  it('「実験開始」を二度押ししても 2 本目の PATCH を送らず、開始できたのに失敗の文を出さない', async () => {
    const patch = deferred<Response>();
    let patchCount = 0;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === PATH) return jsonResponse(200, { data: EXPERIMENT });
      if (method === 'GET' && url.pathname === `${PATH}/results`) return jsonResponse(404, { error: { message: 'not found' } });
      if (method === 'PATCH' && url.pathname === PATH) {
        patchCount += 1;
        if (patchCount > 1) return jsonResponse(409, { error: { message: 'この状態からは変更できません' } });
        return patch.promise;
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(ExperimentDetailPage, { params: Promise.resolve({ id: EXPERIMENT.id }) }));

    await click(findButton('実験開始'), '「実験開始」ボタン');
    expect(findButton('実験開始')!.disabled).toBe(true);
    await click(findButton('実験開始'), '「実験開始」ボタン (2 回目)');
    expect(callsOf('PATCH', PATH)).toHaveLength(1);

    await act(async () => {
      patch.resolve(jsonResponse(200, { data: { ...EXPERIMENT, status: 'running' } }));
    });
    await settle();

    expect(callsOf('PATCH', PATH)).toHaveLength(1);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(findButton('完了')!.disabled).toBe(false);
    expect(findButton('中止')!.disabled).toBe(false);
  });
});

describe('プランの詳細: 状態の変更の応答を待つ間はボタンを止める', () => {
  const PLAN = {
    id: 'plan-1',
    plan_key: 'pro',
    display_name: 'Pro',
    plan_type: 'personal',
    description: null,
    monthly_price_jpy: 1500,
    yearly_price_jpy: 15000,
    max_members: null,
    stripe_product_id: null,
    stripe_price_id: null,
    status: 'public',
    display_order: 0,
    trial_days: 0,
    feature_packages: [],
    price_history: [],
  };
  const PATH = `/api/super-admin/plans/${PLAN.id}`;

  function mockPlanApi(onPatch: () => Response | Promise<Response>) {
    let status = PLAN.status;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === PATH) return jsonResponse(200, { data: { ...PLAN, status } });
      if (method === 'PATCH' && url.pathname === PATH) {
        return Promise.resolve(onPatch()).then((res) => {
          if (res.ok) status = 'private';
          return res;
        });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  it('「非公開にする」を二度押ししても 2 本目の PATCH を送らず、変えられたのに失敗の文を出さない', async () => {
    const patch = deferred<Response>();
    let patchCount = 0;
    mockPlanApi(() => {
      patchCount += 1;
      if (patchCount > 1) return jsonResponse(422, { error: { message: 'この状態からは変更できません' } });
      return patch.promise;
    });
    await renderElement(createElement(PlanDetailPage));

    await click(findButton('非公開にする'), '「非公開にする」ボタン');
    expect(findButton('非公開にする')!.disabled).toBe(true);
    // 応答を待つ間は、ほかの状態の変更 (廃止) も止める
    expect(findButton('廃止する')!.disabled).toBe(true);
    await click(findButton('非公開にする'), '「非公開にする」ボタン (2 回目)');
    await click(findButton('廃止する'), '「廃止する」ボタン');
    expect(callsOf('PATCH', PATH)).toHaveLength(1);

    await act(async () => {
      patch.resolve(jsonResponse(200, { data: { ...PLAN, status: 'private' } }));
    });
    await settle();

    expect(callsOf('PATCH', PATH)).toHaveLength(1);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(findButton('再公開する')!.disabled).toBe(false);
    expect(findButton('廃止する')!.disabled).toBe(false);
  });

  it('状態の変更が断られたら、ボタンを戻してもう一度押せる', async () => {
    mockPlanApi(() => jsonResponse(500, { error: { message: 'サーバーエラーが発生しました' } }));
    await renderElement(createElement(PlanDetailPage));

    await click(findButton('非公開にする'), '「非公開にする」ボタン');
    expect(alertSpy).toHaveBeenCalledWith('サーバーエラーが発生しました');
    expect(findButton('非公開にする')!.disabled).toBe(false);

    await click(findButton('非公開にする'), '「非公開にする」ボタン (2 回目)');
    expect(callsOf('PATCH', PATH)).toHaveLength(2);
  });
});
