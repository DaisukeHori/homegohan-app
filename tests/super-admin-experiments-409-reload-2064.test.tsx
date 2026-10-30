/**
 * #2064 (R3) A/B テストの画面で、状態の変更が 409 で断られたあと状態を読み直さず、英字の状態名の文を出していた件のテスト
 *
 * 別のタブ・別の運営が先に実験の状態を変えると、画面は古い状態のボタンを出したままになる。押すと route は
 * 409 (遷移表に無い変更 OP_EXPERIMENT_INVALID_TRANSITION・読んでから書くまでに状態が変わった CONFLICT_STALE_DATA) で断り、
 * 画面は「実験の状態は running から completed へは変えられません (…)」のような英字の状態名の文を alert で出すだけで、
 * 実験を読み直さなかった。直したあとは:
 *   - 詳細 (/super-admin/experiments/[id]): 409 のあと実験を読み直し、読み直した旨と今の状態を日本語の表示名で画面の上に出す。
 *     読み直しに失敗したら画面を残して「再試行」を出す。読み直しが 404 なら「見つかりません」を出す (「再試行」は出さない)。
 *     確認の文・状態のバッジも英字の状態名を出さない。二度押しの守りは ref でも行う (再描画の前の続けての押下)
 *   - 一覧 (/super-admin/experiments): 409 のあと一覧を読み直し、実験の名前と今の状態を日本語の表示名で出す。
 *     読み直しに失敗したら一覧を残して「再試行」を出す
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => {
  // 一覧 (/super-admin/experiments) は URL の page を useSearchParams で読み、件数より後ろのページを router.replace で移す (#2107 Y9)。
  // router は描画のたびに同じものを返す (一覧の読み込みの useCallback が router に依存するので、毎回別の値だと読み込みが止まらない)
  const router = { push: () => undefined, replace: () => undefined, refresh: () => undefined };
  return { useRouter: () => router, useSearchParams: () => new URLSearchParams() };
});

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: ExperimentDetailPage } = await import('@/app/super-admin/experiments/[id]/page');
const { default: ExperimentsPage } = await import('@/app/super-admin/experiments/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 状態の DB の値 (英字)。画面の文・バッジにこれらが出ないことを確かめる */
const RAW_STATUS_WORDS = ['draft', 'running', 'completed', 'cancelled'];

/** route が遷移表に無い変更を断るときの本文 (src/lib/super-admin/experiments-schemas.ts の文の形) */
function invalidTransitionBody(from: string, to: string) {
  return {
    error: {
      code: 'OP_EXPERIMENT_INVALID_TRANSITION',
      message: `実験の状態は ${from} から ${to} へは変えられません (変えられるのは draft → running・running → completed・running → cancelled だけです)`,
    },
  };
}

/** route が読んでから書くまでに状態が変わったときに断る本文 */
const STALE_BODY = {
  error: { code: 'CONFLICT_STALE_DATA', message: '別の操作で実験の状態が先に変わりました。読み込み直してください' },
};

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
let confirmSpy: ReturnType<typeof vi.spyOn>;

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

/** 画面の上の、読み直しについての文 */
const noticeText = () => container.querySelector('[data-testid="experiment-reload-notice"]')?.textContent ?? null;

function expectNoRawStatusWord(text: string | null | undefined) {
  for (const word of RAW_STATUS_WORDS) {
    expect(text ?? '', `英字の状態名 ${word} を出している`).not.toContain(word);
  }
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
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

describe('A/B テストの詳細: 409 のあと実験を読み直し、日本語の状態名で知らせる (#2064)', () => {
  const EXPERIMENT = {
    id: '11111111-1111-4111-8111-111111111111',
    key: 'onboarding_copy',
    name: 'オンボーディングの文言',
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
  const PATH = `/api/super-admin/experiments/${EXPERIMENT.id}`;

  /**
   * サーバーの実験 (別のタブ・別の運営が先に変えた状態)。GET はこの値を返す。
   * getFailures 回ぶんは GET を getFailureStatus で断る (読み直しの失敗)
   */
  function mockDetailApi(options: {
    initialStatus?: string;
    serverStatusAfterLoad: string | null;
    onPatch: (body: unknown) => Response | Promise<Response>;
    getFailures?: number;
    getFailureStatus?: number;
  }) {
    let getCount = 0;
    let failuresLeft = options.getFailures ?? 0;
    mockFetch((method, url, body) => {
      if (method === 'GET' && url.pathname === PATH) {
        getCount += 1;
        if (getCount === 1) return jsonResponse(200, { data: { ...EXPERIMENT, status: options.initialStatus ?? EXPERIMENT.status } });
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return jsonResponse(options.getFailureStatus ?? 500, { error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' } });
        }
        if (options.serverStatusAfterLoad === null) {
          return jsonResponse(404, { error: { code: 'NOT_FOUND', message: '実験が見つかりません' } });
        }
        return jsonResponse(200, { data: { ...EXPERIMENT, status: options.serverStatusAfterLoad } });
      }
      if (method === 'GET' && url.pathname === `${PATH}/results`) return jsonResponse(404, { error: { message: 'not found' } });
      if (method === 'PATCH' && url.pathname === PATH) return options.onPatch(body);
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  const renderDetail = () => renderElement(createElement(ExperimentDetailPage, { params: Promise.resolve({ id: EXPERIMENT.id }) }));

  it('「完了」が 409 OP_EXPERIMENT_INVALID_TRANSITION で断られたら、実験を読み直して今の状態のボタンにし、日本語の状態名で知らせる', async () => {
    mockDetailApi({ serverStatusAfterLoad: 'completed', onPatch: () => jsonResponse(409, invalidTransitionBody('completed', 'completed')) });
    await renderDetail();
    expect(callsOf('GET', PATH)).toHaveLength(1);

    await click(findButton('完了'), '「完了」ボタン');

    // 英字の状態名の文を alert で出さない
    expect(alertSpy).not.toHaveBeenCalled();
    // 実験を読み直した
    expect(callsOf('GET', PATH)).toHaveLength(2);
    // 読み直した今の状態 (完了) のボタンにする (実行中のボタンは消える)
    expect(findButton('完了')).toBeUndefined();
    expect(findButton('中止')).toBeUndefined();
    const notice = noticeText();
    expect(notice).toContain('別の操作で実験の状態が先に変わっていました');
    expect(notice).toContain('今の状態: 完了');
    expect(notice).toContain('最新の内容を読み込み直した');
    expectNoRawStatusWord(notice);
    // 画面の状態のバッジも表示名 (英字の completed を出さない)
    expectNoRawStatusWord(container.querySelector('h1')?.parentElement?.textContent);
  });

  it('「中止」が 409 CONFLICT_STALE_DATA で断られても、読み直して今の状態で知らせる', async () => {
    mockDetailApi({ serverStatusAfterLoad: 'cancelled', onPatch: () => jsonResponse(409, STALE_BODY) });
    await renderDetail();

    await click(findButton('中止'), '「中止」ボタン');

    expect(alertSpy).not.toHaveBeenCalled();
    expect(callsOf('GET', PATH)).toHaveLength(2);
    expect(findButton('完了')).toBeUndefined();
    expect(noticeText()).toContain('今の状態: 中止');
    expectNoRawStatusWord(noticeText());
  });

  it('409 のあとの読み直しを待つ間は、状態のボタンを止めたままにする', async () => {
    const reload = deferred<Response>();
    let getCount = 0;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === PATH) {
        getCount += 1;
        if (getCount === 1) return jsonResponse(200, { data: EXPERIMENT });
        return reload.promise;
      }
      if (method === 'GET' && url.pathname === `${PATH}/results`) return jsonResponse(404, { error: { message: 'not found' } });
      if (method === 'PATCH' && url.pathname === PATH) return jsonResponse(409, STALE_BODY);
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderDetail();

    await click(findButton('完了'), '「完了」ボタン');
    expect(findButton('完了')!.disabled).toBe(true);
    expect(findButton('中止')!.disabled).toBe(true);
    await click(findButton('中止'), '「中止」ボタン (読み直しを待つ間)');
    expect(callsOf('PATCH', PATH)).toHaveLength(1);

    await act(async () => {
      reload.resolve(jsonResponse(200, { data: { ...EXPERIMENT, status: 'completed' } }));
    });
    await settle();
    expect(noticeText()).toContain('今の状態: 完了');
  });

  it('409 のあとの読み直しに失敗したら、画面を残して「再試行」を出し、再試行で読み直せたら今の状態で知らせる', async () => {
    mockDetailApi({
      serverStatusAfterLoad: 'completed',
      onPatch: () => jsonResponse(409, STALE_BODY),
      getFailures: 1,
    });
    await renderDetail();

    await click(findButton('完了'), '「完了」ボタン');

    expect(alertSpy).not.toHaveBeenCalled();
    // 画面を外さない (見出しが残る)
    expect(container.querySelector('h1')?.textContent).toBe(EXPERIMENT.name);
    expect(noticeText()).toContain('最新の内容を読み込み直せませんでした');
    expect(noticeText()).not.toContain('今の状態');

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(callsOf('GET', PATH)).toHaveLength(3);
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('完了')).toBeUndefined();
    expect(noticeText()).toContain('今の状態: 完了');
  });

  it('409 のあとの読み直しが 404 なら「見つかりません」を出し、「再試行」は出さない', async () => {
    mockDetailApi({ serverStatusAfterLoad: null, onPatch: () => jsonResponse(409, STALE_BODY) });
    await renderDetail();

    await click(findButton('完了'), '「完了」ボタン');

    expect(noticeText()).toContain('実験が見つかりません');
    expect(findButton('再試行')).toBeUndefined();
  });

  it('409 のあとの読み直しが 403 なら権限の文を出し、「再試行」は出さない', async () => {
    mockDetailApi({
      serverStatusAfterLoad: 'completed',
      onPatch: () => jsonResponse(409, STALE_BODY),
      getFailures: 1,
      getFailureStatus: 403,
    });
    await renderDetail();

    await click(findButton('完了'), '「完了」ボタン');

    expect(noticeText()).toContain('権限がありません');
    expect(findButton('再試行')).toBeUndefined();
  });

  it('409 でない失敗 (500) は今までどおり API の文を alert で出し、読み直さず、ボタンを戻す', async () => {
    mockDetailApi({
      serverStatusAfterLoad: 'running',
      onPatch: () => jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' } }),
    });
    await renderDetail();

    await click(findButton('完了'), '「完了」ボタン');

    expect(alertSpy).toHaveBeenCalledWith('サーバーエラーが発生しました');
    expect(callsOf('GET', PATH)).toHaveLength(1);
    expect(noticeText()).toBeNull();
    expect(findButton('完了')!.disabled).toBe(false);
  });

  it('状態の変更に成功したら、前の 409 の文を消す', async () => {
    let patchCount = 0;
    mockDetailApi({
      initialStatus: 'draft',
      serverStatusAfterLoad: 'draft',
      onPatch: () => {
        patchCount += 1;
        if (patchCount === 1) return jsonResponse(409, STALE_BODY);
        return jsonResponse(200, { data: { ...EXPERIMENT, status: 'running' } });
      },
    });
    await renderDetail();

    await click(findButton('実験開始'), '「実験開始」ボタン');
    expect(noticeText()).toContain('今の状態: 下書き');
    await click(findButton('実験開始'), '「実験開始」ボタン (2 回目)');
    expect(noticeText()).toBeNull();
    expect(findButton('完了')).toBeDefined();
  });

  it('確認の文に英字の状態名を出さない', async () => {
    mockDetailApi({ serverStatusAfterLoad: 'completed', onPatch: () => jsonResponse(200, { data: { ...EXPERIMENT, status: 'completed' } }) });
    await renderDetail();

    await click(findButton('完了'), '「完了」ボタン');
    expect(confirmSpy).toHaveBeenCalledWith('この実験を完了にしますか？');
  });

  it.each([
    ['実験開始', 'draft', 'この実験を開始しますか？'],
    ['中止', 'running', 'この実験を中止しますか？'],
  ])('「%s」の確認の文は日本語 (%s から)', async (label, initialStatus, message) => {
    confirmSpy.mockReturnValue(false);
    mockDetailApi({ initialStatus, serverStatusAfterLoad: initialStatus, onPatch: () => jsonResponse(500, {}) });
    await renderDetail();

    await click(findButton(label), `「${label}」ボタン`);
    expect(confirmSpy).toHaveBeenCalledWith(message);
    for (const word of RAW_STATUS_WORDS) {
      expect(String(confirmSpy.mock.calls[0]?.[0])).not.toContain(word);
    }
    // 確認で取り消したら送らない
    expect(callsOf('PATCH', PATH)).toHaveLength(0);
  });

  it.each([
    ['draft', '下書き'],
    ['running', '実行中'],
    ['completed', '完了'],
    ['cancelled', '中止'],
  ])('状態のバッジは表示名で出す (%s → %s)', async (status, label) => {
    mockDetailApi({ initialStatus: status, serverStatusAfterLoad: status, onPatch: () => jsonResponse(500, {}) });
    await renderDetail();

    const heading = container.querySelector('h1')?.parentElement;
    expect(heading?.querySelector('span')?.textContent).toBe(label);
  });

  it('再描画の前に続けて押しても (同じ act の中の 2 回の押下)、2 本目の PATCH を送らない', async () => {
    const patch = deferred<Response>();
    mockDetailApi({ serverStatusAfterLoad: 'completed', onPatch: () => patch.promise });
    await renderDetail();

    const button = findButton('完了');
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
      button!.click();
    });
    await settle();
    expect(callsOf('PATCH', PATH)).toHaveLength(1);

    await act(async () => {
      patch.resolve(jsonResponse(200, { data: { ...EXPERIMENT, status: 'completed' } }));
    });
    await settle();
    expect(callsOf('PATCH', PATH)).toHaveLength(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe('A/B テストの一覧: 409 のあと一覧を読み直し、日本語の状態名で知らせる (#2064)', () => {
  const LIST_PATH = '/api/super-admin/experiments';
  const pathOf = (id: string) => `${LIST_PATH}/${id}`;

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

  /** 一覧の GET を、1 回目は lists[0]、2 回目以降は順に返す (最後の要素を返し続ける)。null は 500 で断る */
  function mockListApi(lists: Array<Array<Record<string, unknown>> | null>, onPatch: (id: string) => Response | Promise<Response>) {
    let getCount = 0;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === LIST_PATH) {
        const list = lists[Math.min(getCount, lists.length - 1)];
        getCount += 1;
        if (list === null) return jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' } });
        return jsonResponse(200, { data: list });
      }
      if (method === 'PATCH' && url.pathname.startsWith(`${LIST_PATH}/`)) {
        return onPatch(url.pathname.slice(LIST_PATH.length + 1));
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  it('「開始」が 409 OP_EXPERIMENT_INVALID_TRANSITION で断られたら、一覧を読み直して今の状態のボタンにし、日本語の状態名で知らせる', async () => {
    mockListApi(
      [[listExperiment()], [listExperiment({ status: 'running' })]],
      () => jsonResponse(409, invalidTransitionBody('running', 'running')),
    );
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('開始'), '「開始」ボタン');

    expect(alertSpy).not.toHaveBeenCalled();
    expect(callsOf('GET', LIST_PATH)).toHaveLength(2);
    expect(findButton('開始')).toBeUndefined();
    expect(findButton('完了')!.disabled).toBe(false);
    const notice = noticeText();
    expect(notice).toContain('「オンボーディングの文言」の状態が先に変わっていました');
    expect(notice).toContain('今の状態: 実行中');
    expect(notice).toContain('一覧を読み込み直した');
    expectNoRawStatusWord(notice);
  });

  it('「完了」が 409 CONFLICT_STALE_DATA で断られても、読み直して今の状態で知らせる', async () => {
    mockListApi(
      [[listExperiment({ status: 'running' })], [listExperiment({ status: 'cancelled' })]],
      () => jsonResponse(409, STALE_BODY),
    );
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('完了'), '「完了」ボタン');

    expect(alertSpy).not.toHaveBeenCalled();
    expect(findButton('完了')).toBeUndefined();
    expect(noticeText()).toContain('今の状態: 中止');
  });

  it('409 のあと読み直した一覧にその実験が無ければ、見つからない旨を出す', async () => {
    mockListApi([[listExperiment()], []], () => jsonResponse(409, STALE_BODY));
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('開始'), '「開始」ボタン');

    expect(noticeText()).toContain('この実験は見つかりませんでした');
    expectNoRawStatusWord(noticeText());
  });

  it('409 のあとの一覧の読み直しに失敗したら、一覧を残して「再試行」を出し、再試行で読み直せたら今の状態で知らせる', async () => {
    mockListApi(
      [[listExperiment()], null, [listExperiment({ status: 'running' })]],
      () => jsonResponse(409, STALE_BODY),
    );
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('開始'), '「開始」ボタン');

    expect(alertSpy).not.toHaveBeenCalled();
    // 一覧を外さない
    expect(container.querySelector('table')).not.toBeNull();
    expect(noticeText()).toContain('一覧を読み込み直せませんでした');

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(callsOf('GET', LIST_PATH)).toHaveLength(3);
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('開始')).toBeUndefined();
    expect(noticeText()).toContain('今の状態: 実行中');
  });

  it('409 のあとの読み直しを待つ間は、一覧の状態のボタンを止めたままにする', async () => {
    const reload = deferred<Response>();
    let getCount = 0;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === LIST_PATH) {
        getCount += 1;
        if (getCount === 1) {
          return jsonResponse(200, { data: [listExperiment(), listExperiment({ id: 'exp-2', key: 'second', name: '2 つ目の実験' })] });
        }
        return reload.promise;
      }
      if (method === 'PATCH') return jsonResponse(409, STALE_BODY);
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(ExperimentsPage));

    const starts = () => Array.from(container.querySelectorAll('button')).filter((b) => b.textContent?.trim() === '開始');
    await click(starts()[0], '1 つ目の「開始」ボタン');
    expect(starts().every((b) => b.disabled)).toBe(true);
    await click(starts()[1], '2 つ目の「開始」ボタン (読み直しを待つ間)');
    expect(callsOf('PATCH', pathOf('exp-2'))).toHaveLength(0);

    await act(async () => {
      reload.resolve(jsonResponse(200, { data: [listExperiment({ status: 'running' }), listExperiment({ id: 'exp-2', key: 'second', name: '2 つ目の実験' })] }));
    });
    await settle();
    expect(starts()).toHaveLength(1);
    expect(starts()[0].disabled).toBe(false);
  });

  it('409 でない失敗 (500) は今までどおり API の文を alert で出し、読み直さない', async () => {
    mockListApi([[listExperiment()]], () => jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' } }));
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('開始'), '「開始」ボタン');

    expect(alertSpy).toHaveBeenCalledWith('サーバーエラーが発生しました');
    expect(callsOf('GET', LIST_PATH)).toHaveLength(1);
    expect(noticeText()).toBeNull();
  });

  it('状態の変更に成功したら、前の 409 の文を消す', async () => {
    let patchCount = 0;
    mockListApi([[listExperiment()], [listExperiment()]], () => {
      patchCount += 1;
      if (patchCount === 1) return jsonResponse(409, STALE_BODY);
      return jsonResponse(200, { data: listExperiment({ status: 'running' }) });
    });
    await renderElement(createElement(ExperimentsPage));

    await click(findButton('開始'), '「開始」ボタン');
    expect(noticeText()).toContain('今の状態: 下書き');
    await click(findButton('開始'), '「開始」ボタン (2 回目)');
    expect(noticeText()).toBeNull();
    expect(findButton('完了')).toBeDefined();
  });
});
