/**
 * #2050 (P1 と同じ型) 運営の画面の、確認つきの操作が応答を待つ間もボタンを止めていなかった件のテスト
 *
 * 組織の招待の「取消」・部署の「削除」と同じく、次の操作は応答を待つ間もボタンを押せた。
 * 二度押しで 2 本目を送ると、1 本目で済んでいるのに 2 本目が断られて失敗の文 (alert) が出る。
 *   - 機能フラグの「削除」(/super-admin/flags)
 *   - A/B テストの「実験開始」・「完了」・「中止」(/super-admin/experiments/[id])
 *   - プランの「公開する」・「非公開にする」・「再公開する」・「廃止する」・「廃止を取り消す」(/super-admin/plans/[id])
 *   - A/B テストの一覧 (/super-admin/experiments) の「開始」・「完了」(10/26 の整合ゲート 1026e。#2054 で詳細の画面だけ直していた)
 * (クーポンの停止・再開と機能パッケージの廃止は、もともと isChangingStatus / isDeprecating で止めている)
 *
 * 機能フラグの一覧 (/super-admin/flags) では、切り替えと削除を重ねて送れた (切り替えは同じフラグの二度押しだけ止めていた)。
 * 切り替えのあとの一覧の読み直し (対象ユーザー数を新しくする) は待たずに投げていたので、その応答が、後から送った
 * 切り替え・削除より前の古い一覧で表示を上書きしえた (#2053 のクーポン・機能パッケージと同じ型。10/26 の整合ゲート 1026e)。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'plan-1' }),
  // プラン詳細は URL の tab を初めのタブにする (#2107 Y3)
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: FlagsPage } = await import('@/app/super-admin/flags/page');
const { default: ExperimentDetailPage } = await import('@/app/super-admin/experiments/[id]/page');
const { default: PlanDetailPage } = await import('@/app/super-admin/plans/[id]/page');
const { default: ExperimentsPage } = await import('@/app/super-admin/experiments/page');

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

describe('A/B テストの一覧: 状態の変更の応答を待つ間はボタンを止める (10/26 の整合ゲート 1026e)', () => {
  function listExperiment(overrides: Record<string, unknown> = {}) {
    return {
      id: 'exp-1',
      key: 'onboarding_copy',
      name: 'オンボーディングの文言',
      status: 'draft',
      start_date: null,
      end_date: null,
      variants: [
        { key: 'control', weight: 50 },
        { key: 'treatment', weight: 50 },
      ],
      primary_metric: null,
      created_at: '2026-10-01T00:00:00Z',
      ...overrides,
    };
  }
  const LIST_PATH = '/api/super-admin/experiments';
  const pathOf = (id: string) => `${LIST_PATH}/${id}`;
  const buttonsLabeled = (label: string) =>
    Array.from(container.querySelectorAll('button')).filter((b) => b.textContent?.trim() === label);

  it('「開始」を二度押ししても 2 本目の PATCH を送らず、開始できたのに失敗の文を出さない', async () => {
    const patch = deferred<Response>();
    let patchCount = 0;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === LIST_PATH) return jsonResponse(200, { data: [listExperiment()] });
      if (method === 'PATCH' && url.pathname === pathOf('exp-1')) {
        patchCount += 1;
        // 2 本目は、開始済みの実験として断られる (running → running)
        if (patchCount > 1) return jsonResponse(409, { error: { message: 'この状態からは変更できません' } });
        return patch.promise;
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('開始'), '「開始」ボタン');
    expect(findButton('開始')!.disabled).toBe(true);
    await click(findButton('開始'), '「開始」ボタン (2 回目)');
    expect(callsOf('PATCH', pathOf('exp-1'))).toHaveLength(1);

    await act(async () => {
      patch.resolve(jsonResponse(200, { data: listExperiment({ status: 'running' }) }));
    });
    await settle();

    expect(callsOf('PATCH', pathOf('exp-1'))).toHaveLength(1);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(findButton('開始')).toBeUndefined();
    expect(findButton('完了')!.disabled).toBe(false);
  });

  it('応答を待つ間は、ほかの実験の「開始」・「完了」も止め、押されても送らない', async () => {
    const patch = deferred<Response>();
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === LIST_PATH) {
        return jsonResponse(200, {
          data: [
            listExperiment(),
            listExperiment({ id: 'exp-2', key: 'second', name: '2 つ目の実験' }),
            listExperiment({ id: 'exp-3', key: 'third', name: '3 つ目の実験', status: 'running' }),
          ],
        });
      }
      if (method === 'PATCH' && url.pathname === pathOf('exp-1')) return patch.promise;
      if (method === 'PATCH') return jsonResponse(200, { data: {} });
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(ExperimentsPage));

    await click(buttonsLabeled('開始')[0], '1 つ目の「開始」ボタン');
    expect(buttonsLabeled('開始')[1].disabled).toBe(true);
    expect(findButton('完了')!.disabled).toBe(true);
    await click(buttonsLabeled('開始')[1], '2 つ目の「開始」ボタン');
    await click(findButton('完了'), '3 つ目の「完了」ボタン');
    expect(callsOf('PATCH', pathOf('exp-2'))).toHaveLength(0);
    expect(callsOf('PATCH', pathOf('exp-3'))).toHaveLength(0);

    await act(async () => {
      patch.resolve(jsonResponse(200, { data: listExperiment({ status: 'running' }) }));
    });
    await settle();

    expect(buttonsLabeled('開始')).toHaveLength(1);
    expect(buttonsLabeled('開始')[0].disabled).toBe(false);
    expect(buttonsLabeled('完了').every((b) => !b.disabled)).toBe(true);
  });

  it('状態の変更が断られたら、ボタンを戻してもう一度押せる', async () => {
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === LIST_PATH) return jsonResponse(200, { data: [listExperiment()] });
      if (method === 'PATCH' && url.pathname === pathOf('exp-1')) {
        return jsonResponse(500, { error: { message: 'サーバーエラーが発生しました' } });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('開始'), '「開始」ボタン');
    expect(alertSpy).toHaveBeenCalledWith('サーバーエラーが発生しました');
    expect(findButton('開始')!.disabled).toBe(false);

    await click(findButton('開始'), '「開始」ボタン (2 回目)');
    expect(callsOf('PATCH', pathOf('exp-1'))).toHaveLength(2);
  });
});

describe('機能フラグ: 切り替え・削除を重ねて送らず、古い一覧で表示を上書きしない (10/26 の整合ゲート 1026e)', () => {
  const LIST_PATH = '/api/super-admin/flags';
  /** サーバーのフラグ (切り替え・削除で変わる)。一覧の GET は、受け取った時点のこの値を返す */
  let server: Map<string, boolean>;

  function flagRow(key: string, enabled: boolean) {
    return {
      key,
      description: '',
      enabled,
      rollout_strategy: null,
      constraints: null,
      active_user_count: 0,
      updated_at: '2026-10-10T00:00:00Z',
    };
  }
  const snapshot = () => Array.from(server.entries()).map(([key, enabled]) => flagRow(key, enabled));

  /** 一覧の行 (key で探す) */
  function rowOf(key: string): HTMLTableRowElement | undefined {
    return Array.from(container.querySelectorAll('tbody tr')).find(
      (tr) => tr.querySelector('code')?.textContent === key,
    ) as HTMLTableRowElement | undefined;
  }
  const toggleOf = (key: string) => rowOf(key)?.querySelectorAll('button')[0] as HTMLButtonElement | undefined;
  const deleteOf = (key: string) =>
    Array.from(rowOf(key)?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === '削除');
  const shownStateOf = (key: string) => {
    const row = rowOf(key);
    if (!row) return 'absent';
    return row.textContent?.includes('ON') ? 'ON' : 'OFF';
  };
  const serverStateOf = (key: string) => (server.has(key) ? (server.get(key) ? 'ON' : 'OFF') : 'absent');

  /**
   * 一覧の GET は受け取った時点のサーバーの値を返す。heldGets に入れた番号 (1 始まり) の GET の応答は、返す値を受け取った時点で決め、
   * 返すのは release を呼ぶまで待つ (先に送った読み直しの応答が後から届く順を作るため)。
   * patchGate / deleteGate を渡すと、PATCH / DELETE はそれが解決するまで応答を待つ (サーバーの値もそのときに変える)
   */
  function mockFlagsApi(options: { heldGets?: number[]; patchGate?: Promise<void>; deleteGate?: Promise<void> } = {}) {
    const releases: Array<() => void> = [];
    let getCount = 0;
    mockFetch((method, url, body) => {
      if (method === 'GET' && url.pathname === LIST_PATH) {
        getCount += 1;
        const response = jsonResponse(200, { data: snapshot() });
        if (options.heldGets?.includes(getCount)) {
          const held = deferred<Response>();
          releases.push(() => held.resolve(response));
          return held.promise;
        }
        return response;
      }
      const key = decodeURIComponent(url.pathname.slice(`${LIST_PATH}/`.length));
      if (method === 'PATCH' && url.pathname.startsWith(`${LIST_PATH}/`)) {
        const apply = () => {
          server.set(key, (body as { enabled: boolean }).enabled);
          return jsonResponse(200, { data: flagRow(key, server.get(key)!) });
        };
        return options.patchGate ? options.patchGate.then(apply) : apply();
      }
      if (method === 'DELETE' && url.pathname.startsWith(`${LIST_PATH}/`)) {
        const apply = () => {
          if (!server.has(key)) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'フラグが見つかりません' } });
          server.delete(key);
          return jsonResponse(200, { data: { key } });
        };
        return options.deleteGate ? options.deleteGate.then(apply) : apply();
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    return { releaseAll: () => releases.splice(0).forEach((release) => release()) };
  }

  beforeEach(() => {
    server = new Map([
      ['alpha', true],
      ['beta', false],
    ]);
  });

  it('切り替えのあとの読み直しを待つ間に別のフラグを切り替えようとしても送らず、届いた一覧はサーバーと同じ', async () => {
    // 1 本目 = 画面を開いたときの GET、2 本目 = alpha の切り替えのあとの読み直し (応答を遅らせる)
    const api = mockFlagsApi({ heldGets: [2] });
    await renderElement(createElement(FlagsPage));

    await click(toggleOf('alpha'), 'alpha の切り替え');
    expect(serverStateOf('alpha')).toBe('OFF');
    // 読み直しの応答を待つ間は、ほかのフラグの切り替え・削除も止める
    expect(toggleOf('beta')!.disabled).toBe(true);
    expect(deleteOf('beta')!.disabled).toBe(true);
    await click(toggleOf('beta'), 'beta の切り替え');
    await click(deleteOf('beta'), 'beta の削除');
    expect(callsOf('PATCH', `${LIST_PATH}/beta`)).toHaveLength(0);
    expect(callsOf('DELETE', `${LIST_PATH}/beta`)).toHaveLength(0);

    await act(async () => {
      api.releaseAll();
    });
    await settle();

    // 遅れて届いた一覧で、表示がサーバーと食い違わない
    expect(shownStateOf('alpha')).toBe(serverStateOf('alpha'));
    expect(shownStateOf('beta')).toBe(serverStateOf('beta'));
    expect(toggleOf('beta')!.disabled).toBe(false);

    // 読み直しが済めば、beta を切り替えられる
    await click(toggleOf('beta'), 'beta の切り替え (読み直しのあと)');
    expect(callsOf('PATCH', `${LIST_PATH}/beta`)).toHaveLength(1);
    expect(serverStateOf('beta')).toBe('ON');
    expect(shownStateOf('beta')).toBe('ON');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('切り替えの応答を待つ間は、ほかのフラグの切り替え・削除を止め、押されても送らない', async () => {
    const patch = deferred<void>();
    mockFlagsApi({ patchGate: patch.promise });
    await renderElement(createElement(FlagsPage));

    await click(toggleOf('alpha'), 'alpha の切り替え');
    expect(toggleOf('alpha')!.disabled).toBe(true);
    expect(toggleOf('beta')!.disabled).toBe(true);
    expect(deleteOf('alpha')!.disabled).toBe(true);
    expect(deleteOf('beta')!.disabled).toBe(true);
    await click(toggleOf('beta'), 'beta の切り替え');
    await click(deleteOf('beta'), 'beta の削除');
    expect(callsOf('PATCH', `${LIST_PATH}/beta`)).toHaveLength(0);
    expect(callsOf('DELETE', `${LIST_PATH}/beta`)).toHaveLength(0);

    await act(async () => {
      patch.resolve();
    });
    await settle();

    expect(shownStateOf('alpha')).toBe('OFF');
    expect(shownStateOf('beta')).toBe('OFF');
    expect(toggleOf('beta')!.disabled).toBe(false);
    expect(deleteOf('beta')!.disabled).toBe(false);
  });

  it('削除の応答を待つ間は、ほかのフラグの切り替えを止め、押されても送らない', async () => {
    const del = deferred<void>();
    mockFlagsApi({ deleteGate: del.promise });
    await renderElement(createElement(FlagsPage));

    await click(deleteOf('alpha'), 'alpha の削除');
    expect(toggleOf('beta')!.disabled).toBe(true);
    await click(toggleOf('beta'), 'beta の切り替え');
    expect(callsOf('PATCH', `${LIST_PATH}/beta`)).toHaveLength(0);

    await act(async () => {
      del.resolve();
    });
    await settle();

    expect(shownStateOf('alpha')).toBe('absent');
    expect(serverStateOf('alpha')).toBe('absent');
    expect(toggleOf('beta')!.disabled).toBe(false);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('切り替えが断られたら、ボタンを戻してもう一度押せる', async () => {
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === LIST_PATH) return jsonResponse(200, { data: snapshot() });
      if (method === 'PATCH') return jsonResponse(500, { error: { message: 'サーバーエラーが発生しました' } });
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FlagsPage));

    await click(toggleOf('alpha'), 'alpha の切り替え');
    expect(alertSpy).toHaveBeenCalledWith('サーバーエラーが発生しました');
    expect(toggleOf('alpha')!.disabled).toBe(false);
    expect(deleteOf('beta')!.disabled).toBe(false);

    await click(toggleOf('alpha'), 'alpha の切り替え (2 回目)');
    expect(callsOf('PATCH', `${LIST_PATH}/alpha`)).toHaveLength(2);
  });
});
