/**
 * #2107 (triage-1030c) Y9・Y11 のテスト: 運営の一覧の画面のページ送りと、読み込みの失敗で前の条件の行を出さないこと
 *
 * Y9: A/B テストの一覧 (/super-admin/experiments) は、以前は一覧の API を page / per_page なしで呼び (API の既定は 50 件)、
 *     51 件目より後ろの実験を画面に出さず、件数もページ送りも無かった。
 *     直したあと: URL の page (parsePageParam で読む) のページを読み、meta.total で件数とページ送り (前へ・次へ) を出す。
 *     件数より後ろのページは、空のページを見せずに最後のページへ移す (lastPageToRefetch・router.replace)。
 *     ページを移した先の読み込みが失敗したら、前のページの行を出さずに失敗の文を出す。
 * Y11: 営業 (/admin/sales)・問い合わせ (/admin/support) の一覧は、以前は絞り込み・ページを変えた後の読み込みが失敗すると、
 *     前の条件の行と件数を失敗の文と一緒に出していた (新しい条件の結果と見誤りうる)。
 *     直したあと: 条件を変えて読み込みを始めるときに行を空にする。失敗 (500・403・通信の失敗) では前の条件の行も件数も出さない。
 *     読み込みを重ねたとき、古い読み込みの結果で新しい条件の画面を上書きしない。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 描画のたびに同じ router を返す (画面の useCallback が router に依存するので、毎回別の値を返すと読み込みが止まらない)
const nav = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  searchParams: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  usePathname: () => '/admin',
  useSearchParams: () => nav.searchParams,
  useParams: () => ({}),
}));
vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_INTERNAL_ERROR = 500;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const SERVER_ERROR_BODY = { error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' } };
const FORBIDDEN_BODY = { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } };

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  nav.searchParams = new URLSearchParams();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderPage(Page: ComponentType) {
  await act(async () => {
    root.render(createElement(Page));
  });
  await flush();
}

/** fetch の呼び出しのうち、パスが apiPath のものの URL (呼んだ順) */
function requestedUrls(apiPath: string): URL[] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter((url) => url.pathname === apiPath);
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  if (!button) throw new Error(`ボタン「${text}」がありません`);
  return button;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await flush();
}

async function selectValue(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

// ─── Y9: A/B テストの一覧のページ送り ───────────────────────────────────────────

describe('#2107 Y9 A/B テストの一覧 (/super-admin/experiments) のページ送り', () => {
  const LIST_PATH = '/api/super-admin/experiments';
  /** 画面の 1 ページの件数 (API の既定 EXPERIMENTS_LIST_PER_PAGE_DEFAULT と同じ) */
  const PER_PAGE = 50;
  /** 3 ページぶんの件数 (2 ページ目に前へ・次へが両方出る) */
  const TOTAL_THREE_PAGES = PER_PAGE * 2 + 1;

  function experiment(n: number) {
    return {
      id: `exp-${n}`,
      key: `experiment_${n}`,
      name: `実験${n}`,
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
  }

  /** page のページの行 (件数 total のうち、そのページに入るもの) */
  function pageRows(page: number, total: number) {
    const first = (page - 1) * PER_PAGE + 1;
    const last = Math.min(page * PER_PAGE, total);
    const rows = [];
    for (let n = first; n <= last; n += 1) rows.push(experiment(n));
    return rows;
  }

  function mockList(handler: (page: number, perPage: number) => Response | Promise<Response>) {
    fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname !== LIST_PATH) throw new Error(`想定外の呼び出し: ${url.pathname}`);
      return handler(Number(url.searchParams.get('page')), Number(url.searchParams.get('per_page')));
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  const loadPage = async () => (await import('@/app/super-admin/experiments/page')).default;

  it('URL の page のページを page / per_page つきで読み、件数と前へ・次へ (URL の page) を出す', async () => {
    nav.searchParams = new URLSearchParams({ page: '2' });
    mockList((page) => jsonResponse(HTTP_OK, { data: pageRows(page, TOTAL_THREE_PAGES), meta: { total: TOTAL_THREE_PAGES, page, per_page: PER_PAGE } }));
    await renderPage(await loadPage());

    const [url] = requestedUrls(LIST_PATH);
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('per_page')).toBe(String(PER_PAGE));
    // 2 ページ目の行 (51〜100 件目) を出し、1 ページ目の行は出さない (行のキーで見る)
    const keys = Array.from(container.querySelectorAll('code')).map((c) => c.textContent);
    expect(keys).toContain(`experiment_${PER_PAGE + 1}`);
    expect(keys).not.toContain('experiment_1');
    expect(container.querySelector('[data-testid="experiments-total"]')?.textContent).toContain(String(TOTAL_THREE_PAGES));

    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('[data-testid="experiments-pagination"] a'));
    const hrefs = Object.fromEntries(links.map((a) => [a.textContent?.trim(), a.getAttribute('href')]));
    expect(hrefs['前へ']).toBe('/super-admin/experiments?page=1');
    expect(hrefs['次へ']).toBe('/super-admin/experiments?page=3');
  });

  it('51 件目より後ろの実験は 2 ページ目にある (1 ページ目に「次へ」があり、前へは無い)', async () => {
    mockList((page) => jsonResponse(HTTP_OK, { data: pageRows(page, PER_PAGE + 1), meta: { total: PER_PAGE + 1, page, per_page: PER_PAGE } }));
    await renderPage(await loadPage());

    expect(requestedUrls(LIST_PATH)[0].searchParams.get('page')).toBe('1');
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('[data-testid="experiments-pagination"] a'));
    expect(links.map((a) => [a.textContent?.trim(), a.getAttribute('href')])).toEqual([['次へ', '/super-admin/experiments?page=2']]);
  });

  it.each(['abc', '0', '-1', '1.5', '2abc'])('URL の page が 1 以上の整数でない (%j) なら 1 ページ目を読む', async (raw) => {
    nav.searchParams = new URLSearchParams({ page: raw });
    mockList((page) => jsonResponse(HTTP_OK, { data: pageRows(page, 1), meta: { total: 1, page, per_page: PER_PAGE } }));
    await renderPage(await loadPage());
    expect(requestedUrls(LIST_PATH)[0].searchParams.get('page')).toBe('1');
  });

  it('件数より後ろのページは、「実験がありません」と見せずに最後のページへ移す (router.replace)', async () => {
    nav.searchParams = new URLSearchParams({ page: '9' });
    mockList((page) => jsonResponse(HTTP_OK, { data: [], meta: { total: PER_PAGE + 1, page, per_page: PER_PAGE } }));
    await renderPage(await loadPage());

    expect(nav.router.replace).toHaveBeenCalledWith('/super-admin/experiments?page=2');
    expect(container.textContent).not.toContain('実験がありません');
  });

  it('ページを移した先の読み込みが失敗したら、前のページの行を出さずに失敗の文を出す', async () => {
    nav.searchParams = new URLSearchParams({ page: '1' });
    mockList((page) =>
      page === 1
        ? jsonResponse(HTTP_OK, { data: pageRows(1, TOTAL_THREE_PAGES), meta: { total: TOTAL_THREE_PAGES, page, per_page: PER_PAGE } })
        : jsonResponse(HTTP_INTERNAL_ERROR, SERVER_ERROR_BODY),
    );
    const Page = await loadPage();
    await renderPage(Page);
    expect(Array.from(container.querySelectorAll('code')).map((c) => c.textContent)).toContain('experiment_1');

    // 「次へ」のリンクで URL が ?page=2 になった (Next の遷移は useSearchParams の値が変わって描き直される)
    nav.searchParams = new URLSearchParams({ page: '2' });
    await renderPage(Page);

    expect(requestedUrls(LIST_PATH).map((u) => u.searchParams.get('page'))).toEqual(['1', '2']);
    expect(container.textContent).toContain('サーバーエラーが発生しました');
    // 1 ページ目の行・件数は出さない
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelectorAll('code')).toHaveLength(0);
    expect(container.querySelector('[data-testid="experiments-total"]')).toBeNull();
  });
});

// ─── Y11: 営業・問い合わせの一覧の読み込みの失敗で前の条件の行を出さない ─────────────────

describe('#2107 Y11 営業の一覧 (/admin/sales): 絞り込みを変えた後の読み込みの失敗', () => {
  const LEADS_PATH = '/api/admin/sales/leads';
  /** 前の条件 (すべて) の件数 */
  const FIRST_TOTAL = 7;

  function lead(n: number, stage = 'approach') {
    return {
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      company_name: `前の条件の会社${n}`,
      industry: null,
      contact_name: null,
      contact_email: null,
      stage,
      assigned_to: null,
      estimated_acv: null,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
    };
  }

  const loadPage = async () => (await import('@/app/admin/sales/page')).default;

  /** すべて の一覧を読み、テーブルに切り替えて、ステージの絞り込みを won に変える。won の読み込みは wonResponse */
  async function changeStageWith(wonResponse: () => Response | Promise<Response>) {
    fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname !== LEADS_PATH) throw new Error(`想定外の呼び出し: ${url.pathname}`);
      if (url.searchParams.get('stage') === 'won') return wonResponse();
      return jsonResponse(HTTP_OK, { data: [lead(1), lead(2)], meta: { total: FIRST_TOTAL, page: 1, per_page: 200 } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderPage(await loadPage());
    expect(container.textContent).toContain('前の条件の会社1');
    expect(container.textContent).toContain(`見込み顧客 ${FIRST_TOTAL} 件`);

    await click(buttonByText('テーブル'));
    const select = container.querySelector<HTMLSelectElement>('#stage-filter');
    expect(select).not.toBeNull();
    await selectValue(select!, 'won');
    expect(requestedUrls(LEADS_PATH).map((u) => u.searchParams.get('stage'))).toEqual([null, 'won']);
  }

  function expectNoPreviousRows() {
    expect(container.textContent).not.toContain('前の条件の会社');
    expect(container.textContent).not.toContain(`見込み顧客 ${FIRST_TOTAL} 件`);
  }

  it('500 なら、前の条件の行と件数を出さずに失敗の文だけを出す', async () => {
    await changeStageWith(() => jsonResponse(HTTP_INTERNAL_ERROR, SERVER_ERROR_BODY));
    expect(container.textContent).toContain('リードの一覧を読み込めませんでした');
    expectNoPreviousRows();
  });

  it('403 なら、前の条件の行と件数を出さずに理由の文だけを出す', async () => {
    await changeStageWith(() => jsonResponse(HTTP_FORBIDDEN, FORBIDDEN_BODY));
    expect(container.textContent).toContain('権限がありません');
    expectNoPreviousRows();
  });

  it('通信の失敗なら、前の条件の行と件数を出さずに失敗の文だけを出す', async () => {
    await changeStageWith(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(container.textContent).toContain('リードの一覧を読み込めませんでした');
    expectNoPreviousRows();
  });

  it('読み込みを重ねたとき、遅れて届いた前の条件の結果で新しい条件の画面を上書きしない', async () => {
    let resolveFirst: (res: Response) => void = () => undefined;
    fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.searchParams.get('stage') === 'won') {
        return jsonResponse(HTTP_OK, { data: [{ ...lead(9, 'won'), company_name: '新しい条件の会社' }], meta: { total: 1, page: 1, per_page: 200 } });
      }
      // すべて の 1 回目の読み込みは、won の読み込みより後に届く
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderPage(await loadPage());
    await click(buttonByText('テーブル'));
    await selectValue(container.querySelector<HTMLSelectElement>('#stage-filter')!, 'won');
    expect(container.textContent).toContain('新しい条件の会社');

    await act(async () => {
      resolveFirst(jsonResponse(HTTP_OK, { data: [lead(1)], meta: { total: FIRST_TOTAL, page: 1, per_page: 200 } }));
    });
    await flush();
    expect(container.textContent).toContain('新しい条件の会社');
    expectNoPreviousRows();
  });
});

describe('#2107 Y11 問い合わせの一覧 (/admin/support): 絞り込み・ページを変えた後の読み込みの失敗', () => {
  const TICKETS_PATH = '/api/admin/support/tickets';
  const PER_PAGE = 50;
  /** 前の条件 (すべて) の件数 (2 ページぶん) */
  const FIRST_TOTAL = PER_PAGE * 2;

  function ticket(n: number) {
    return {
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      user_id: '00000000-0000-4000-8000-0000000000ff',
      subject: `前の条件の件名${n}`,
      category: 'account',
      priority: 'medium',
      status: 'open',
      assignee_id: null,
      created_at: '2026-10-08T04:30:00.000Z',
      updated_at: '2026-10-08T04:30:00.000Z',
    };
  }

  const firstPageRows = Array.from({ length: PER_PAGE }, (_, i) => ticket(i + 1));
  const loadPage = async () => (await import('@/app/admin/support/page')).default;

  /** すべて の 1 ページ目を読み、change で条件を変える。変えた後の読み込みは failure */
  async function changeConditionWith(change: () => Promise<void>, failure: () => Response | Promise<Response>) {
    fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname !== TICKETS_PATH) throw new Error(`想定外の呼び出し: ${url.pathname}`);
      const isFirstCondition = !url.searchParams.has('status') && !url.searchParams.has('priority') && url.searchParams.get('page') === '1';
      if (isFirstCondition) return jsonResponse(HTTP_OK, { data: firstPageRows, meta: { total: FIRST_TOTAL, page: 1, per_page: PER_PAGE } });
      return failure();
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderPage(await loadPage());
    expect(container.textContent).toContain('前の条件の件名1');
    expect(container.textContent).toContain(`全 ${FIRST_TOTAL} 件`);
    await change();
    expect(requestedUrls(TICKETS_PATH)).toHaveLength(2);
  }

  function expectNoPreviousRows() {
    expect(container.textContent).not.toContain('前の条件の件名');
    expect(container.textContent).not.toContain(`全 ${FIRST_TOTAL} 件`);
    expect(container.textContent).not.toContain(`/ ${FIRST_TOTAL} 件`);
  }

  it('状態のタブを変えた後の 500 では、前の条件の行と件数を出さない', async () => {
    await changeConditionWith(() => click(buttonByText('対応中')), () => jsonResponse(HTTP_INTERNAL_ERROR, SERVER_ERROR_BODY));
    expect(container.textContent).toContain('チケット一覧の取得に失敗しました');
    expectNoPreviousRows();
  });

  it('優先度の絞り込みを変えた後の 403 では、前の条件の行と件数を出さない', async () => {
    await changeConditionWith(
      () => selectValue(container.querySelector<HTMLSelectElement>('#priority-filter')!, 'urgent'),
      () => jsonResponse(HTTP_FORBIDDEN, FORBIDDEN_BODY),
    );
    expect(container.textContent).toContain('権限がありません');
    expectNoPreviousRows();
  });

  it('次のページの読み込みが通信の失敗なら、前のページの行と件数を出さない (「前へ」で戻れる)', async () => {
    await changeConditionWith(() => click(buttonByText('次へ')), () => Promise.reject(new TypeError('Failed to fetch')));
    expect(container.textContent).toContain('チケットの一覧を読み込めませんでした');
    expectNoPreviousRows();
    expect(buttonByText('前へ').disabled).toBe(false);
  });

  it('読み込みを重ねたとき、遅れて届いた前の条件の結果で新しい条件の画面を上書きしない', async () => {
    let resolveFirst: (res: Response) => void = () => undefined;
    fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.searchParams.get('status') === 'in_progress') {
        return jsonResponse(HTTP_OK, { data: [{ ...ticket(99), subject: '新しい条件の件名', status: 'in_progress' }], meta: { total: 1, page: 1, per_page: PER_PAGE } });
      }
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderPage(await loadPage());
    await click(buttonByText('対応中'));
    expect(container.textContent).toContain('新しい条件の件名');

    await act(async () => {
      resolveFirst(jsonResponse(HTTP_OK, { data: firstPageRows, meta: { total: FIRST_TOTAL, page: 1, per_page: PER_PAGE } }));
    });
    await flush();
    expect(container.textContent).toContain('新しい条件の件名');
    expectNoPreviousRows();
  });
});
