/**
 * #2107 (triage-1030c) Y9・Y11 のテスト: 運営の一覧の画面のページ送りと、読み込みの失敗で前の条件の行を出さないこと
 *
 * Y9: A/B テストの一覧 (/super-admin/experiments) は、以前は一覧の API を page / per_page なしで呼び (API の既定は 50 件)、
 *     51 件目より後ろの実験を画面に出さず、件数もページ送りも無かった。
 *     直したあと: URL の page (parsePageParam で読む) のページを読み、meta.total で件数とページ送り (前へ・次へ) を出す。
 *     件数より後ろのページは、空のページを見せずに最後のページへ移す (lastPageToRefetch・router.replace)。
 *     ページを移した先の読み込みが失敗したら、前のページの行を出さずに失敗の文を出す。
 *     「開始」の 409・通信の reject のあとに読み直した一覧 (表示しているページ) に押した実験が無くても「見つかりませんでした」と
 *     言わない (応答を待つ間にページを移した・新しい実験が増えて次のページへ押し出された・最後のページへ移した)。
 *     詳細の API で読み、あれば今の状態を添えて「表示しているページにありません」と出し、404 のときだけ「見つかりませんでした」と出す。
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
  // 応答の本文の読み込み (Response.json) をまたぐ読み込みの連鎖 (状態の変更 → 一覧の読み直し → 詳細の読み込み) が終わるまで回す
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
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

  // ─── 状態の変更 (開始) の 409・通信の reject のあとの読み直し: 一覧に無い = 消えた、と言わない ─────────────
  // 一覧はページで送るので、読み直した一覧 (表示しているページ) に押した実験が無くても消えたとは限らない
  // (応答を待つ間にページを移した・新しい実験が増えて次のページへ押し出された・件数より後ろになって最後のページへ移した)。
  // 画面は詳細の API で読み、あれば今の状態を文に添えて「表示しているページにありません」と出し、404 のときだけ「見つかりません」と出す

  const HTTP_CONFLICT = 409;
  const HTTP_NOT_FOUND = 404;
  const STALE_BODY = { error: { code: 'CONFLICT_STALE_DATA', message: '別の操作で実験の状態が先に変わりました。読み込み直してください' } };
  const NOT_FOUND_BODY = { error: { code: 'NOT_FOUND', message: '実験が見つかりません' } };
  const DETAIL_PATH = (id: string) => `${LIST_PATH}/${id}`;
  const OFF_PAGE_TEXT = 'この実験は表示しているページにありません';
  const GONE_TEXT = 'この実験は見つかりませんでした';

  /** 状態の変更の応答 (409 か通信の reject) と、それを受けた画面の文の頭 */
  const PATCH_FAILURES = [
    {
      what: '409',
      settle: (patch: { resolve: (r: Response) => void; reject: (e: Error) => void }) => patch.resolve(jsonResponse(HTTP_CONFLICT, STALE_BODY)),
      offPageText: (name: string) => `別の操作で「${name}」の状態が先に変わっていました（今の状態: 実行中）`,
    },
    {
      what: '通信の reject',
      settle: (patch: { resolve: (r: Response) => void; reject: (e: Error) => void }) => patch.reject(new TypeError('Failed to fetch')),
      offPageText: (name: string) => `「${name}」の状態の変更の応答を受け取れませんでした（通信エラー）。今の状態（実行中）を読み込み直しました`,
    },
  ] as const;

  type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void };
  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** 一覧の GET (page ごと)・詳細の GET (id ごと)・PATCH を分けて返す */
  function mockRoutes(routes: {
    list: (page: number) => Response | Promise<Response>;
    detail?: (id: string) => Response | Promise<Response>;
    patch: () => Response | Promise<Response>;
  }) {
    fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PATCH') return routes.patch();
      if (method === 'GET' && url.pathname === LIST_PATH) return routes.list(Number(url.searchParams.get('page')));
      if (method === 'GET' && routes.detail && url.pathname.startsWith(`${LIST_PATH}/`)) {
        return routes.detail(decodeURIComponent(url.pathname.slice(LIST_PATH.length + 1)));
      }
      throw new Error(`想定外の呼び出し: ${method} ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  const listResponse = (rows: unknown[], page: number, total: number) =>
    jsonResponse(HTTP_OK, { data: rows, meta: { total, page, per_page: PER_PAGE } });
  const detailResponse = (n: number, status: string) => jsonResponse(HTTP_OK, { data: { ...experiment(n), status } });
  const noticeText = () => container.querySelector('[data-testid="experiment-reload-notice"]')?.textContent ?? null;
  const noticeLinkHref = () =>
    container.querySelector<HTMLAnchorElement>('[data-testid="experiment-reload-notice"] a')?.getAttribute('href') ?? null;
  const shownKeys = () => Array.from(container.querySelectorAll('code')).map((c) => c.textContent);
  const detailCalls = (id: string) => fetchMock.mock.calls.filter(([input]) => new URL(String(input), 'http://localhost').pathname === DETAIL_PATH(id));
  const startButtons = () => Array.from(container.querySelectorAll('button')).filter((b) => b.textContent?.trim() === '開始');
  const retryButton = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === '再試行');

  async function settlePatch(patch: Deferred<Response>, failure: (typeof PATCH_FAILURES)[number]) {
    await act(async () => {
      failure.settle(patch);
    });
    await flush();
  }

  it.each(PATCH_FAILURES)(
    '「開始」の応答 ($what) を待つ間にページを移したら、今のページを読み直し、押した実験を「見つかりません」とせず詳細の API の今の状態を出す',
    async (failure) => {
      nav.searchParams = new URLSearchParams({ page: '1' });
      const patch = deferred<Response>();
      mockRoutes({
        list: (page) => listResponse(pageRows(page, TOTAL_THREE_PAGES), page, TOTAL_THREE_PAGES),
        detail: () => detailResponse(1, 'running'),
        patch: () => patch.promise,
      });
      const Page = await loadPage();
      await renderPage(Page);
      await click(startButtons()[0]);

      // 応答を待つ間に「次へ」で 2 ページ目へ移った
      nav.searchParams = new URLSearchParams({ page: '2' });
      await renderPage(Page);
      await settlePatch(patch, failure);

      // 読み直しは今の (2) ページを読み、前のページの行を出さない
      expect(requestedUrls(LIST_PATH).map((u) => u.searchParams.get('page'))).toEqual(['1', '2', '2']);
      expect(shownKeys()).toContain(`experiment_${PER_PAGE + 1}`);
      expect(shownKeys()).not.toContain('experiment_1');
      // 押した実験 (1 ページ目の実験1) は詳細の API で読み、今の状態を文に添える (消えたとは言わない)
      expect(detailCalls('exp-1')).toHaveLength(1);
      const notice = noticeText();
      expect(notice).toContain(failure.offPageText('実験1'));
      expect(notice).toContain(OFF_PAGE_TEXT);
      expect(notice).not.toContain(GONE_TEXT);
      expect(notice).not.toContain('running');
      expect(noticeLinkHref()).toBe('/super-admin/experiments/exp-1');
      // 読み直せたので、状態のボタンは止めない・「再試行」は出さない
      expect(retryButton()).toBeUndefined();
      expect(startButtons().every((b) => !b.disabled)).toBe(true);
    },
  );

  it('ページを移さなくても、新しい実験が増えて押した実験が次のページへ押し出されたら、詳細の API の今の状態を出す (409)', async () => {
    let listCalls = 0;
    mockRoutes({
      list: (page) => {
        listCalls += 1;
        if (listCalls === 1) return listResponse(pageRows(1, PER_PAGE), page, PER_PAGE);
        // 読み直し: 新しい実験 (作成日の降順で先頭) が 1 件増え、実験1 が 2 ページ目へ押し出された
        const pushed = [{ ...experiment(PER_PAGE + 1), name: '新しい実験' }, ...pageRows(1, PER_PAGE).slice(1)];
        return listResponse(pushed, page, PER_PAGE + 1);
      },
      detail: () => detailResponse(1, 'running'),
      patch: () => jsonResponse(HTTP_CONFLICT, STALE_BODY),
    });
    await renderPage(await loadPage());
    await click(startButtons()[0]);

    expect(detailCalls('exp-1')).toHaveLength(1);
    expect(noticeText()).toContain('別の操作で「実験1」の状態が先に変わっていました（今の状態: 実行中）');
    expect(noticeText()).toContain(OFF_PAGE_TEXT);
    expect(noticeText()).not.toContain(GONE_TEXT);
  });

  it('読み直した一覧に押した実験があれば、詳細の API は読まずに一覧の行で知らせる (リンクも出さない)', async () => {
    let listCalls = 0;
    mockRoutes({
      list: (page) => {
        listCalls += 1;
        const rows = pageRows(1, PER_PAGE);
        return listResponse(listCalls === 1 ? rows : [{ ...rows[0], status: 'running' }, ...rows.slice(1)], page, PER_PAGE);
      },
      detail: () => detailResponse(1, 'completed'),
      patch: () => jsonResponse(HTTP_CONFLICT, STALE_BODY),
    });
    await renderPage(await loadPage());
    await click(startButtons()[0]);

    expect(detailCalls('exp-1')).toHaveLength(0);
    expect(noticeText()).toContain('今の状態: 実行中');
    expect(noticeText()).toContain('一覧を読み込み直したので');
    expect(noticeText()).not.toContain(OFF_PAGE_TEXT);
    expect(noticeLinkHref()).toBeNull();
  });

  it.each([
    { what: '409', patch: () => jsonResponse(HTTP_CONFLICT, STALE_BODY), head: '別の操作で「実験1」の状態が先に変わっていました' },
    { what: '通信の reject', patch: () => Promise.reject(new TypeError('Failed to fetch')), head: '「実験1」の状態の変更の応答を受け取れませんでした（通信エラー）' },
  ])('一覧に無く、詳細の API も 404 なら、そのときだけ「見つかりませんでした」を出す ($what)', async ({ patch, head }) => {
    let listCalls = 0;
    mockRoutes({
      list: (page) => {
        listCalls += 1;
        const rows = pageRows(1, PER_PAGE);
        return listCalls === 1 ? listResponse(rows, page, PER_PAGE) : listResponse(rows.slice(1), page, PER_PAGE - 1);
      },
      detail: () => jsonResponse(HTTP_NOT_FOUND, NOT_FOUND_BODY),
      patch,
    });
    await renderPage(await loadPage());
    await click(startButtons()[0]);

    expect(detailCalls('exp-1')).toHaveLength(1);
    expect(noticeText()).toContain(head);
    expect(noticeText()).toContain(GONE_TEXT);
    expect(noticeText()).not.toContain(OFF_PAGE_TEXT);
    expect(noticeLinkHref()).toBeNull();
    expect(retryButton()).toBeUndefined();
  });

  it.each([
    {
      what: '409',
      patch: () => jsonResponse(HTTP_CONFLICT, STALE_BODY),
      failedText: '別の操作で「実験1」の状態が先に変わっていました。今の状態を読み込めませんでした',
      listFailedText: '一覧を読み込み直せませんでした',
      offPageText: '別の操作で「実験1」の状態が先に変わっていました（今の状態: 実行中）',
    },
    {
      what: '通信の reject',
      patch: () => Promise.reject(new TypeError('Failed to fetch')),
      failedText: '「実験1」の状態の変更の応答を受け取れませんでした（通信エラー）。今の状態を読み込めませんでした',
      listFailedText: '一覧を読み込めませんでした',
      offPageText: '「実験1」の状態の変更の応答を受け取れませんでした（通信エラー）。今の状態（実行中）を読み込み直しました',
    },
  ])(
    '一覧に無く、詳細の API の読み込みが失敗したら「再試行」を出して状態のボタンを止め、再試行で読めたら今の状態を出す ($what)',
    async ({ patch, failedText, listFailedText, offPageText }) => {
      let listCalls = 0;
      let detailCount = 0;
      mockRoutes({
        list: (page) => {
          listCalls += 1;
          const rows = pageRows(1, PER_PAGE + 1);
          // 読み直しからは実験1 が 2 ページ目へ押し出されている
          return listCalls === 1 ? listResponse(rows, page, PER_PAGE + 1) : listResponse([experiment(PER_PAGE + 2), ...rows.slice(1)], page, PER_PAGE + 2);
        },
        detail: () => {
          detailCount += 1;
          return detailCount === 1 ? jsonResponse(HTTP_INTERNAL_ERROR, SERVER_ERROR_BODY) : detailResponse(1, 'running');
        },
        patch,
      });
      await renderPage(await loadPage());
      await click(startButtons()[0]);

      // 一覧は読み直せているので「一覧を読み込み直せませんでした」とは言わず、今の状態を読めなかった旨と「再試行」を出す
      expect(noticeText()).toContain(failedText);
      expect(noticeText()).not.toContain(listFailedText);
      expect(noticeText()).not.toContain(GONE_TEXT);
      expect(retryButton()).toBeDefined();
      expect(startButtons().length).toBeGreaterThan(0);
      expect(startButtons().every((b) => b.disabled)).toBe(true);

      await click(retryButton()!);

      expect(detailCalls('exp-1')).toHaveLength(2);
      expect(noticeText()).toContain(offPageText);
      expect(noticeText()).toContain(OFF_PAGE_TEXT);
      expect(retryButton()).toBeUndefined();
      expect(startButtons().every((b) => !b.disabled)).toBe(true);
    },
  );

  it('一覧に無く、詳細の API が 403 なら、理由の文を出し「再試行」は出さず、状態のボタンも止めない', async () => {
    let listCalls = 0;
    mockRoutes({
      list: (page) => {
        listCalls += 1;
        const rows = pageRows(1, PER_PAGE);
        return listCalls === 1 ? listResponse(rows, page, PER_PAGE) : listResponse(rows.slice(1), page, PER_PAGE - 1);
      },
      detail: () => jsonResponse(HTTP_FORBIDDEN, FORBIDDEN_BODY),
      patch: () => jsonResponse(HTTP_CONFLICT, STALE_BODY),
    });
    await renderPage(await loadPage());
    await click(startButtons()[0]);

    expect(noticeText()).toBe('権限がありません');
    expect(retryButton()).toBeUndefined();
    expect(startButtons().every((b) => !b.disabled)).toBe(true);
  });

  it('詳細の API を読む間に運営がページを移したら、移した先の画面に前のページの実験についての文を出さない', async () => {
    nav.searchParams = new URLSearchParams({ page: '1' });
    const detail = deferred<Response>();
    let page1Calls = 0;
    mockRoutes({
      list: (page) => {
        if (page !== 1) return listResponse(pageRows(page, TOTAL_THREE_PAGES), page, TOTAL_THREE_PAGES);
        page1Calls += 1;
        const rows = pageRows(1, TOTAL_THREE_PAGES);
        return page1Calls === 1 ? listResponse(rows, page, TOTAL_THREE_PAGES) : listResponse([experiment(TOTAL_THREE_PAGES + 1), ...rows.slice(1)], page, TOTAL_THREE_PAGES + 1);
      },
      detail: () => detail.promise,
      patch: () => jsonResponse(HTTP_CONFLICT, STALE_BODY),
    });
    const Page = await loadPage();
    await renderPage(Page);
    await click(startButtons()[0]);
    expect(detailCalls('exp-1')).toHaveLength(1);

    nav.searchParams = new URLSearchParams({ page: '2' });
    await renderPage(Page);
    await act(async () => {
      detail.resolve(detailResponse(1, 'running'));
    });
    await flush();

    expect(shownKeys()).toContain(`experiment_${PER_PAGE + 1}`);
    expect(noticeText()).toBeNull();
  });

  it('運営がページを移したら、一覧の上の文を消す (前のページの実験についての文)', async () => {
    nav.searchParams = new URLSearchParams({ page: '1' });
    let page1Calls = 0;
    mockRoutes({
      list: (page) => {
        if (page !== 1) return listResponse(pageRows(page, TOTAL_THREE_PAGES), page, TOTAL_THREE_PAGES);
        page1Calls += 1;
        const rows = pageRows(1, TOTAL_THREE_PAGES);
        return listResponse(page1Calls === 1 ? rows : [{ ...rows[0], status: 'running' }, ...rows.slice(1)], page, TOTAL_THREE_PAGES);
      },
      patch: () => jsonResponse(HTTP_CONFLICT, STALE_BODY),
    });
    const Page = await loadPage();
    await renderPage(Page);
    await click(startButtons()[0]);
    expect(noticeText()).toContain('今の状態: 実行中');

    nav.searchParams = new URLSearchParams({ page: '2' });
    await renderPage(Page);
    expect(noticeText()).toBeNull();
  });

  describe('読み直しで件数より後ろになり、画面が自分で最後のページへ移したとき', () => {
    /** 3 ページ目の唯一の行 (実験101) を押す。読み直しでは件数が 1 減り、3 ページ目は空 → 2 ページ目へ移す */
    const LAST_N = TOTAL_THREE_PAGES;
    const SHRUNK_TOTAL = TOTAL_THREE_PAGES - 1;

    function mockShrink(detail: () => Response | Promise<Response>, page2Rows: () => unknown[]) {
      let page3Calls = 0;
      mockRoutes({
        list: (page) => {
          if (page === 3) {
            page3Calls += 1;
            return page3Calls === 1 ? listResponse(pageRows(3, TOTAL_THREE_PAGES), page, TOTAL_THREE_PAGES) : listResponse([], page, SHRUNK_TOTAL);
          }
          if (page === 2) return listResponse(page2Rows(), page, SHRUNK_TOTAL);
          return listResponse(pageRows(page, SHRUNK_TOTAL), page, SHRUNK_TOTAL);
        },
        detail,
        patch: () => jsonResponse(HTTP_CONFLICT, STALE_BODY),
      });
    }

    it('押した実験が消えていた (詳細の API が 404) なら、移した先の画面にも「見つかりませんでした」を出す', async () => {
      nav.searchParams = new URLSearchParams({ page: '3' });
      mockShrink(() => jsonResponse(HTTP_NOT_FOUND, NOT_FOUND_BODY), () => pageRows(2, SHRUNK_TOTAL));
      const Page = await loadPage();
      await renderPage(Page);
      await click(startButtons()[0]);

      expect(nav.router.replace).toHaveBeenCalledWith('/super-admin/experiments?page=2');
      expect(detailCalls(`exp-${LAST_N}`)).toHaveLength(1);
      // router.replace で URL が ?page=2 になった
      nav.searchParams = new URLSearchParams({ page: '2' });
      await renderPage(Page);

      expect(shownKeys()).toContain(`experiment_${PER_PAGE + 1}`);
      expect(noticeText()).toContain(`別の操作で「実験${LAST_N}」の状態が先に変わっていました`);
      expect(noticeText()).toContain(GONE_TEXT);
    });

    it('押した実験が移した先のページにあれば、その行で今の状態を知らせる (「表示しているページにありません」と言わない)', async () => {
      nav.searchParams = new URLSearchParams({ page: '3' });
      // 別の実験が消えて、押した実験 (実験101) が 2 ページ目の末尾へ繰り上がった
      mockShrink(
        () => detailResponse(LAST_N, 'running'),
        () => [...pageRows(2, TOTAL_THREE_PAGES).slice(1), { ...experiment(LAST_N), status: 'running' }],
      );
      const Page = await loadPage();
      await renderPage(Page);
      await click(startButtons()[0]);
      nav.searchParams = new URLSearchParams({ page: '2' });
      await renderPage(Page);

      expect(shownKeys()).toContain(`experiment_${LAST_N}`);
      expect(noticeText()).toContain(`別の操作で「実験${LAST_N}」の状態が先に変わっていました（今の状態: 実行中）`);
      expect(noticeText()).toContain('一覧を読み込み直したので');
      expect(noticeText()).not.toContain(OFF_PAGE_TEXT);
      expect(noticeLinkHref()).toBeNull();
    });

    it('詳細の API を読む間に運営が別のページへ移したら、文を出さない', async () => {
      nav.searchParams = new URLSearchParams({ page: '3' });
      const detail = deferred<Response>();
      mockShrink(() => detail.promise, () => pageRows(2, SHRUNK_TOTAL));
      const Page = await loadPage();
      await renderPage(Page);
      await click(startButtons()[0]);
      expect(detailCalls(`exp-${LAST_N}`)).toHaveLength(1);

      // 画面が移す 2 ページ目ではなく、運営が 1 ページ目へ移した
      nav.searchParams = new URLSearchParams({ page: '1' });
      await renderPage(Page);
      await act(async () => {
        detail.resolve(jsonResponse(HTTP_NOT_FOUND, NOT_FOUND_BODY));
      });
      await flush();

      expect(shownKeys()).toContain('experiment_1');
      expect(noticeText()).toBeNull();
    });
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
