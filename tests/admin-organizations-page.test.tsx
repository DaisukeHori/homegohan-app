/**
 * 組織管理 (/admin/organizations) の画面のテスト
 * operator/03-ui-spec.md §7
 *
 * 組織の API (GET / POST /api/admin/organizations) はあったが、使う画面が無かった (モバイルの管理画面は #1389 で削除済み)。
 * 画面で確かめること:
 *   - 一覧: GET の結果を、組織名・プラン・作成日時 (日本時間)・ID で表示する。読み込み中・0 件・失敗の表示がある。
 *     失敗したときに「組織が 0 件」に見せない (API が返したメッセージを出す)
 *   - 検索: 組織名 (q) とプラン (plan) を付けて取り直し、1 ページ目に戻る。素早く条件を変えても、古い応答で上書きしない
 *   - ページ送り: 前へ / 次へで page を変え、検索条件は引き継ぐ。範囲と総件数を出す
 *   - 作成: 組織名・プラン・(任意で) オーナーのユーザー ID を POST し、成功したら 1 ページ目から取り直す。
 *     API のエラーメッセージ (同じユーザーが別の組織に所属している、など) をそのまま出す
 *   - 入力欄はラベルと結びつき、ボタンには type がある
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { default: OrganizationsManager } = await import('@/app/admin/organizations/OrganizationsManager');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─────────────────────────────────────────────────────────────────────────────
// 道具
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = '11111111-2222-4333-8444-555555555555';

/** GET /api/admin/organizations が返す 1 件。時刻は UTC (日本時間 = +9 時間) */
function org(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`,
    name: `組織${n}`,
    plan: 'standard',
    created_at: '2026-10-08T04:30:00.000Z', // 日本時間 2026/10/08 13:30
    updated_at: '2026-10-08T04:30:00.000Z',
    ...overrides,
  };
}

/** 一覧の応答の本文 */
const listBody = (organizations: unknown[], total = organizations.length, page = 1) => ({
  organizations,
  meta: { total, page, per_page: 30 },
});

const errorBody = (code: string, message: string) => ({ error: { code, message } });

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

interface Api {
  list?: (url: URL) => Response | Promise<Response>;
  create?: (body: Record<string, unknown>) => Response | Promise<Response>;
}

/** API ごとの応答を決める。想定外の呼び出しはテストを失敗させる */
function mockApi(api: Api) {
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.pathname === '/api/admin/organizations' && method === 'GET' && api.list) return api.list(url);
    if (url.pathname === '/api/admin/organizations' && method === 'POST' && api.create) {
      return api.create(JSON.parse(String(init?.body)));
    }
    throw new Error(`想定していない fetch: ${method} ${input}`);
  });
}

const text = () => container.textContent ?? '';
const alerts = () => Array.from(container.querySelectorAll('[role="alert"]')).map((el) => el.textContent ?? '');
const statuses = () => Array.from(container.querySelectorAll('[role="status"]')).map((el) => el.textContent ?? '');

/** 一覧の各行のセルの文字 */
const rows = () =>
  Array.from(container.querySelectorAll('tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim() ?? ''),
  );
const names = () => rows().map((cells) => cells[0]);

const searchInput = () => container.querySelector('#org-search-q') as HTMLInputElement;
const searchPlan = () => container.querySelector('#org-search-plan') as HTMLSelectElement;
const createName = () => container.querySelector('#org-create-name') as HTMLInputElement;
const createPlan = () => container.querySelector('#org-create-plan') as HTMLSelectElement;
const createOwner = () => container.querySelector('#org-create-owner') as HTMLInputElement;

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(element: HTMLElement | undefined, what = 'クリック対象') {
  expect(element, `${what}が見つからない`).toBeDefined();
  await act(async () => {
    element!.click();
  });
  await settle();
}

/** 入力欄に値を入れる (React の onChange が動くよう、ネイティブの setter と input イベントを使う) */
async function type(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** 検索欄に条件を入れて「検索」を押す */
async function search(q: string, plan = '') {
  await type(searchInput(), q);
  await choose(searchPlan(), plan);
  await click(findButton('検索'), '検索ボタン');
}

/** fetch の呼び出しのうち、メソッドが合うもの */
const callsOf = (method: string) =>
  fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === method);

/** i 回目の一覧の取得のクエリパラメータ (オブジェクトにしたもの) */
const listParams = (callIndex: number) =>
  Object.fromEntries(new URL(String(callsOf('GET')[callIndex][0]), 'http://localhost').searchParams);
const lastListParams = () => listParams(callsOf('GET').length - 1);

const postBody = (callIndex = 0) => JSON.parse(String((callsOf('POST')[callIndex][1] as RequestInit).body));

async function renderPage() {
  await act(async () => {
    root.render(<OrganizationsManager />);
  });
  await settle();
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
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
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 一覧
// ─────────────────────────────────────────────────────────────────────────────

describe('一覧', () => {
  it('はじめは条件なしで 1 ページ目 (30 件) を取り、組織名・プラン・作成日時 (日本時間)・ID を出す', async () => {
    mockApi({
      list: () =>
        jsonResponse(
          200,
          listBody([
            org(2, { name: '株式会社ビー', plan: 'premium', created_at: '2026-10-07T15:30:00.000Z' }), // 日本時間 2026/10/08 00:30
            org(1, { name: '株式会社エー', plan: 'enterprise' }),
            org(3, { name: 'プラン未設定の組織', plan: null, created_at: null }),
          ]),
        ),
    });
    await renderPage();

    expect(callsOf('GET')).toHaveLength(1);
    expect(listParams(0)).toEqual({ page: '1', per_page: '30' });
    expect(alerts()).toEqual([]);
    expect(rows()).toEqual([
      ['株式会社ビー', 'premium', '2026/10/08 00:30', '00000002...'],
      ['株式会社エー', 'enterprise', '2026/10/08 13:30', '00000001...'],
      ['プラン未設定の組織', '-', '-', '00000003...'],
    ]);
    expect(text()).toContain('全 3 件');
    expect(Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent)).toEqual([
      '組織名',
      'プラン',
      '作成日時',
      'ID',
    ]);
  });

  it('取得している間は「読み込み中...」を出し、届いたら消える', async () => {
    const slow = deferred<Response>();
    mockApi({ list: () => slow.promise });
    await renderPage();

    expect(statuses()).toContain('読み込み中...');
    expect(text()).not.toContain('組織はまだありません');
    expect(container.querySelector('table')).toBeNull();

    await act(async () => {
      slow.resolve(jsonResponse(200, listBody([org(1)])));
    });
    await settle();
    expect(statuses()).not.toContain('読み込み中...');
    expect(names()).toEqual(['組織1']);
  });

  it('条件なしで 0 件のときは「組織はまだありません」を出す', async () => {
    mockApi({ list: () => jsonResponse(200, listBody([])) });
    await renderPage();

    expect(text()).toContain('組織はまだありません');
    expect(text()).toContain('全 0 件');
    expect(alerts()).toEqual([]);
    expect(container.querySelector('table')).toBeNull();
  });

  it('取得に失敗したら、0 件に見せずに API が返したメッセージを出す', async () => {
    mockApi({ list: () => jsonResponse(403, errorBody('OP_PERMISSION_DENIED', '権限がありません')) });
    await renderPage();

    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('権限がありません');
    expect(text()).not.toContain('組織はまだありません');
    expect(text()).not.toContain('全 0 件');
    expect(container.querySelector('table')).toBeNull();
  });

  it('本文が JSON でない失敗 (プロキシの 502 など) や通信エラーでは、汎用の日本語のエラーを出す', async () => {
    mockApi({ list: () => new Response('<html>Bad Gateway</html>', { status: 502 }) });
    await renderPage();
    expect(alerts()[0]).toContain('組織の一覧を取得できませんでした');
    expect(alerts()[0]).not.toContain('Bad Gateway');

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await renderPage();
    expect(alerts()[0]).toContain('組織の一覧を取得できませんでした');
    expect(text()).not.toContain('組織はまだありません');
  });

  it('想定外の形の応答 (organizations が配列でない) を「0 件」と見せず、エラーにする', async () => {
    mockApi({ list: () => jsonResponse(200, { organizations: null }) });
    await renderPage();
    expect(alerts()[0]).toContain('組織の一覧を取得できませんでした');
    expect(text()).not.toContain('組織はまだありません');
  });

  it('「再読み込み」で同じ条件のまま取り直せて、成功するとエラー表示が消える', async () => {
    let calls = 0;
    mockApi({
      list: () =>
        ++calls === 1
          ? jsonResponse(500, errorBody('INTERNAL_ERROR', '組織の取得に失敗しました'))
          : jsonResponse(200, listBody([org(1)])),
    });
    await renderPage();
    expect(alerts()[0]).toContain('組織の取得に失敗しました');

    await click(findButton('再読み込み'), '再読み込みボタン');
    expect(callsOf('GET')).toHaveLength(2);
    expect(alerts()).toEqual([]);
    expect(names()).toEqual(['組織1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 検索
// ─────────────────────────────────────────────────────────────────────────────

describe('検索', () => {
  it('組織名 (q) とプラン (plan) を付けて 1 ページ目から取り直す。組織名の前後の空白は除く', async () => {
    mockApi({ list: () => jsonResponse(200, listBody([org(1)])) });
    await renderPage();

    await search('  テスト  ', 'premium');

    expect(callsOf('GET')).toHaveLength(2);
    expect(lastListParams()).toEqual({ q: 'テスト', plan: 'premium', page: '1', per_page: '30' });
  });

  it('プランの選択肢は「すべてのプラン」と、API が受け付ける standard / premium / enterprise', () => {
    mockApi({ list: () => jsonResponse(200, listBody([])) });
    return renderPage().then(() => {
      const options = (select: HTMLSelectElement) => Array.from(select.options).map((o) => [o.value, o.textContent]);
      expect(options(searchPlan())).toEqual([
        ['', 'すべてのプラン'],
        ['standard', 'standard'],
        ['premium', 'premium'],
        ['enterprise', 'enterprise'],
      ]);
      expect(options(createPlan())).toEqual([
        ['standard', 'standard'],
        ['premium', 'premium'],
        ['enterprise', 'enterprise'],
      ]);
    });
  });

  it('入力しただけでは取り直さず、「検索」を押したときだけ取り直す', async () => {
    mockApi({ list: () => jsonResponse(200, listBody([org(1)])) });
    await renderPage();

    await type(searchInput(), 'テスト');
    await choose(searchPlan(), 'enterprise');
    expect(callsOf('GET')).toHaveLength(1);

    await click(findButton('検索'), '検索ボタン');
    expect(callsOf('GET')).toHaveLength(2);
  });

  it('組織名を空にして検索すると q を付けない。プランも「すべて」なら付けない', async () => {
    mockApi({ list: () => jsonResponse(200, listBody([org(1)])) });
    await renderPage();
    await search('テスト', 'premium');
    expect(lastListParams()).toEqual({ q: 'テスト', plan: 'premium', page: '1', per_page: '30' });

    await search('   ', '');
    expect(lastListParams()).toEqual({ page: '1', per_page: '30' });
  });

  it('同じ条件でもう一度「検索」を押すと、取り直す', async () => {
    mockApi({ list: () => jsonResponse(200, listBody([org(1)])) });
    await renderPage();
    await search('テスト');
    await click(findButton('検索'), '検索ボタン');
    expect(callsOf('GET')).toHaveLength(3);
  });

  it('条件に一致する組織が 0 件のときは「条件に一致する組織はありません」を出す', async () => {
    mockApi({
      list: (url) => jsonResponse(200, listBody(url.searchParams.has('q') ? [] : [org(1)])),
    });
    await renderPage();
    await search('存在しない名前');

    expect(text()).toContain('条件に一致する組織はありません');
    expect(text()).not.toContain('組織はまだありません');
    expect(alerts()).toEqual([]);
  });

  it('条件を素早く切り替えても、古い応答で一覧を上書きしない', async () => {
    const slow = deferred<Response>();
    mockApi({
      list: (url) => {
        const q = url.searchParams.get('q');
        if (q === 'ゆっくり') return slow.promise; // 遅い応答
        if (q === 'はやい') return jsonResponse(200, listBody([org(2, { name: 'はやい組織' })]));
        return jsonResponse(200, listBody([org(1, { name: '最初の組織' })]));
      },
    });
    await renderPage();

    await search('ゆっくり'); // 応答待ち
    await search('はやい'); // こちらが先に返る
    expect(names()).toEqual(['はやい組織']);

    await act(async () => {
      slow.resolve(jsonResponse(200, listBody([org(3, { name: '古い応答の組織' })])));
    });
    await settle();
    expect(names()).toEqual(['はやい組織']);
    expect(text()).not.toContain('古い応答の組織');
  });

  it('失敗した古い応答で、新しい一覧にエラーを出さない', async () => {
    const slow = deferred<Response>();
    mockApi({
      list: (url) => {
        const q = url.searchParams.get('q');
        if (q === 'ゆっくり') return slow.promise;
        return jsonResponse(200, listBody([org(1)]));
      },
    });
    await renderPage();
    await search('ゆっくり');
    await search('はやい');

    await act(async () => {
      slow.resolve(jsonResponse(500, errorBody('INTERNAL_ERROR', '組織の取得に失敗しました')));
    });
    await settle();
    expect(alerts()).toEqual([]);
    expect(names()).toEqual(['組織1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ページ送り
// ─────────────────────────────────────────────────────────────────────────────

describe('ページ送り', () => {
  const TOTAL = 65; // 30 件ずつで 3 ページ (30 + 30 + 5)

  /** page ページ目の組織 (n は通し番号) */
  function pageOf(url: URL) {
    const page = Number(url.searchParams.get('page'));
    const count = page === 3 ? 5 : 30;
    return jsonResponse(
      200,
      listBody(
        Array.from({ length: count }, (_, i) => org((page - 1) * 30 + i + 1)),
        TOTAL,
        page,
      ),
    );
  }

  it('範囲と総件数を出し、次へ / 前へで page を変える。最初のページでは前へ、最後のページでは次へが押せない', async () => {
    mockApi({ list: pageOf });
    await renderPage();

    expect(text()).toContain('1〜30 件 / 全 65 件');
    expect(rows()).toHaveLength(30);
    expect(findButton('前へ')?.disabled).toBe(true);
    expect(findButton('次へ')?.disabled).toBe(false);

    await click(findButton('次へ'), '次へ');
    expect(lastListParams()).toEqual({ page: '2', per_page: '30' });
    expect(text()).toContain('31〜60 件 / 全 65 件');
    expect(names()[0]).toBe('組織31');
    expect(findButton('前へ')?.disabled).toBe(false);

    await click(findButton('次へ'), '次へ');
    expect(lastListParams()).toEqual({ page: '3', per_page: '30' });
    expect(text()).toContain('61〜65 件 / 全 65 件');
    expect(rows()).toHaveLength(5);
    expect(findButton('次へ')?.disabled).toBe(true);

    await click(findButton('前へ'), '前へ');
    expect(lastListParams()).toEqual({ page: '2', per_page: '30' });
    expect(names()[0]).toBe('組織31');
  });

  it('ページを送っても、検索条件 (組織名・プラン) は引き継ぐ', async () => {
    mockApi({ list: pageOf });
    await renderPage();
    await search('テスト', 'premium');

    await click(findButton('次へ'), '次へ');
    expect(lastListParams()).toEqual({ q: 'テスト', plan: 'premium', page: '2', per_page: '30' });
  });

  it('2 ページ目以降で検索し直すと、1 ページ目に戻る', async () => {
    mockApi({ list: pageOf });
    await renderPage();
    await click(findButton('次へ'), '次へ');
    expect(lastListParams().page).toBe('2');

    await search('テスト');
    expect(lastListParams()).toEqual({ q: 'テスト', page: '1', per_page: '30' });
  });

  it('1 ページに収まるときは、ページ送りを出さない', async () => {
    mockApi({ list: () => jsonResponse(200, listBody([org(1), org(2)])) });
    await renderPage();
    expect(container.querySelector('nav[aria-label="ページ送り"]')).toBeNull();
    expect(findButton('次へ')).toBeUndefined();
  });

  it('次のページを取得している間は、前のページの表を出さない (ページ送りも押せない)', async () => {
    const slow = deferred<Response>();
    mockApi({
      list: (url) => (url.searchParams.get('page') === '2' ? slow.promise : pageOf(url)),
    });
    await renderPage();
    await click(findButton('次へ'), '次へ'); // 応答待ち

    expect(statuses()).toContain('読み込み中...');
    expect(container.querySelector('table')).toBeNull();
    expect(findButton('次へ')).toBeUndefined();

    await act(async () => {
      slow.resolve(pageOf(new URL('http://localhost/api/admin/organizations?page=2')));
    });
    await settle();
    expect(names()[0]).toBe('組織31');
  });

  it('次のページの取得に失敗したら、エラーを出し、前のページの表は出さない', async () => {
    mockApi({
      list: (url) =>
        url.searchParams.get('page') === '2' ? jsonResponse(500, errorBody('INTERNAL_ERROR', '組織の取得に失敗しました')) : pageOf(url),
    });
    await renderPage();
    await click(findButton('次へ'), '次へ');

    expect(alerts()[0]).toContain('組織の取得に失敗しました');
    expect(container.querySelector('table')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 作成
// ─────────────────────────────────────────────────────────────────────────────

describe('作成', () => {
  it('組織名・プラン・オーナーを POST し、成功したら一覧を取り直して、フォームを初期状態に戻す', async () => {
    let created = false;
    mockApi({
      list: () =>
        jsonResponse(
          200,
          listBody(created ? [org(2, { name: '株式会社テスト', plan: 'premium' }), org(1)] : [org(1)]),
        ),
      create: () => {
        created = true;
        return jsonResponse(200, { organization: org(2, { name: '株式会社テスト', plan: 'premium', owner_id: OWNER_ID }) });
      },
    });
    await renderPage();

    await type(createName(), '  株式会社テスト  ');
    await choose(createPlan(), 'premium');
    await type(createOwner(), `  ${OWNER_ID}  `);
    await click(findButton('作成する'), '作成ボタン');

    // 送った内容
    expect(callsOf('POST')).toHaveLength(1);
    const [url, init] = callsOf('POST')[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/organizations');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(postBody()).toEqual({ name: '株式会社テスト', plan: 'premium', owner_id: OWNER_ID });

    // 一覧を取り直し、作成した組織が出る
    expect(callsOf('GET')).toHaveLength(2);
    expect(names()).toEqual(['株式会社テスト', '組織1']);
    // フォームは初期状態に戻り、結果を知らせる
    expect(createName().value).toBe('');
    expect(createPlan().value).toBe('standard');
    expect(createOwner().value).toBe('');
    expect(statuses()).toContain('組織「株式会社テスト」を作成しました。');
    expect(alerts()).toEqual([]);
  });

  it('オーナーを空にすると owner_id を送らない (API は操作している管理者をオーナーにする)。プランの初期値は standard', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([])),
      create: () => jsonResponse(200, { organization: org(1) }),
    });
    await renderPage();

    expect(createPlan().value).toBe('standard');
    await type(createName(), '株式会社テスト');
    await click(findButton('作成する'), '作成ボタン');

    expect(postBody()).toEqual({ name: '株式会社テスト', plan: 'standard' });
    expect(Object.keys(postBody())).not.toContain('owner_id');
  });

  it('作成後の取り直しは、1 ページ目から行う。今の検索条件は残す', async () => {
    const page = (url: URL) =>
      jsonResponse(200, listBody(Array.from({ length: 30 }, (_, i) => org(i + 1)), 65, Number(url.searchParams.get('page'))));
    mockApi({
      list: page,
      create: () => jsonResponse(200, { organization: org(99) }),
    });
    await renderPage();
    await search('テスト', 'enterprise');
    await click(findButton('次へ'), '次へ');
    expect(lastListParams()).toEqual({ q: 'テスト', plan: 'enterprise', page: '2', per_page: '30' });

    await type(createName(), '新しい組織');
    await click(findButton('作成する'), '作成ボタン');
    expect(lastListParams()).toEqual({ q: 'テスト', plan: 'enterprise', page: '1', per_page: '30' });
  });

  it('API のエラーメッセージ (409: すでに別の組織に所属しているオーナー) をそのまま出す。入力は消さず、一覧も取り直さない', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([org(1)])),
      create: () =>
        jsonResponse(409, errorBody('OWNER_ALREADY_IN_ORG', '指定した owner は既に別の組織に所属しています')),
    });
    await renderPage();
    await type(createName(), '株式会社テスト');
    await choose(createPlan(), 'enterprise');
    await type(createOwner(), OWNER_ID);
    await click(findButton('作成する'), '作成ボタン');

    expect(callsOf('POST')).toHaveLength(1);
    expect(alerts()).toEqual(['指定した owner は既に別の組織に所属しています']);
    expect(statuses()).toEqual([]);
    // 入力は残る (直してもう一度送れる)
    expect(createName().value).toBe('株式会社テスト');
    expect(createPlan().value).toBe('enterprise');
    expect(createOwner().value).toBe(OWNER_ID);
    expect(findButton('作成する')?.disabled).toBe(false);
    // 作成されていないので、一覧は取り直さない
    expect(callsOf('GET')).toHaveLength(1);
  });

  it.each([
    [400, errorBody('VALIDATION_ERROR', 'バリデーションエラー'), 'バリデーションエラー'],
    [403, errorBody('OP_PERMISSION_DENIED', '権限がありません'), '権限がありません'],
    [500, errorBody('INTERNAL_ERROR', '組織の作成に失敗しました'), '組織の作成に失敗しました'],
  ])('%i のときも、API が返したメッセージを出す', async (status, body, message) => {
    mockApi({
      list: () => jsonResponse(200, listBody([])),
      create: () => jsonResponse(status, body),
    });
    await renderPage();
    await type(createName(), '株式会社テスト');
    await click(findButton('作成する'), '作成ボタン');
    expect(alerts()).toEqual([message]);
  });

  it('メッセージを読み取れない失敗や通信エラーでは、汎用の日本語のメッセージを出し、入力を残す', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([])),
      create: () => new Response('<html>Bad Gateway</html>', { status: 502 }),
    });
    await renderPage();
    await type(createName(), '株式会社テスト');
    await click(findButton('作成する'), '作成ボタン');
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('組織を作成できませんでした');
    expect(alerts()[0]).not.toContain('Bad Gateway');

    fetchMock.mockImplementation(async (_input: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new TypeError('Failed to fetch');
      return jsonResponse(200, listBody([]));
    });
    await click(findButton('作成する'), '作成ボタン');
    expect(alerts()[0]).toContain('組織を作成できませんでした');
    expect(createName().value).toBe('株式会社テスト');
  });

  it('組織名が空白だけのときは送らず、日本語のメッセージを出す', async () => {
    mockApi({ list: () => jsonResponse(200, listBody([])) });
    await renderPage();
    await type(createName(), '   ');
    await click(findButton('作成する'), '作成ボタン');

    expect(callsOf('POST')).toHaveLength(0);
    expect(alerts()).toEqual(['組織名を入力してください。']);
  });

  it('オーナーのユーザー ID が UUID の形でないときは送らず、日本語のメッセージを出す', async () => {
    mockApi({ list: () => jsonResponse(200, listBody([])) });
    await renderPage();
    await type(createName(), '株式会社テスト');
    await type(createOwner(), 'not-a-uuid');
    await click(findButton('作成する'), '作成ボタン');

    expect(callsOf('POST')).toHaveLength(0);
    expect(alerts()).toEqual(['オーナーのユーザー ID は UUID の形式で入力してください。']);
  });

  it('作成している間は入力欄とボタンを止め、二重に送らない。終わったら戻る', async () => {
    const slow = deferred<Response>();
    mockApi({
      list: () => jsonResponse(200, listBody([])),
      create: () => slow.promise,
    });
    await renderPage();
    await type(createName(), '株式会社テスト');

    await click(findButton('作成する'), '作成ボタン'); // 応答待ち
    expect(findButton('作成中...')?.disabled).toBe(true);
    expect(createName().disabled).toBe(true);
    expect(createPlan().disabled).toBe(true);
    expect(createOwner().disabled).toBe(true);

    await click(findButton('作成中...'), '作成中のボタン'); // 止まっているので送られない
    expect(callsOf('POST')).toHaveLength(1);

    await act(async () => {
      slow.resolve(jsonResponse(409, errorBody('OWNER_ALREADY_IN_ORG', '指定した owner は既に別の組織に所属しています')));
    });
    await settle();
    expect(findButton('作成する')?.disabled).toBe(false);
    expect(createName().disabled).toBe(false);
    expect(callsOf('POST')).toHaveLength(1);
  });

  it('次の作成を始めると、前の結果の表示 (通知・エラー) は消える', async () => {
    let calls = 0;
    mockApi({
      list: () => jsonResponse(200, listBody([])),
      create: () =>
        ++calls === 1
          ? jsonResponse(200, { organization: org(1) })
          : jsonResponse(409, errorBody('OWNER_ALREADY_IN_ORG', '指定した owner は既に別の組織に所属しています')),
    });
    await renderPage();
    await type(createName(), '一つ目');
    await click(findButton('作成する'), '作成ボタン');
    expect(statuses()).toContain('組織「一つ目」を作成しました。');

    await type(createName(), '二つ目');
    await click(findButton('作成する'), '作成ボタン');
    expect(statuses()).toEqual([]);
    expect(alerts()).toEqual(['指定した owner は既に別の組織に所属しています']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// アクセシビリティ
// ─────────────────────────────────────────────────────────────────────────────

describe('アクセシビリティ', () => {
  beforeEach(async () => {
    mockApi({ list: () => jsonResponse(200, listBody([org(1)], 65)) });
    await renderPage();
  });

  it('すべての入力欄はラベルと結びついている', () => {
    const fields = Array.from(container.querySelectorAll('input, textarea, select'));
    expect(fields.length).toBeGreaterThanOrEqual(5);
    for (const field of fields) {
      expect(field.id, '入力欄に id が無い').toBeTruthy();
      const label = container.querySelector(`label[for="${field.id}"]`);
      expect(label, `#${field.id} のラベルが無い`).not.toBeNull();
      expect(label!.textContent?.trim(), `#${field.id} のラベルが空`).toBeTruthy();
    }
  });

  it('すべてのボタンに type がある', async () => {
    // 失敗の表示にある「再読み込み」ボタンも対象にする
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent)).toEqual(expect.arrayContaining(['作成する', '検索', '前へ', '次へ']));

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    mockApi({ list: () => jsonResponse(500, errorBody('INTERNAL_ERROR', '組織の取得に失敗しました')) });
    await renderPage();
    const withError = Array.from(container.querySelectorAll('button'));
    expect(withError.map((b) => b.textContent)).toContain('再読み込み');

    for (const button of [...buttons, ...withError]) {
      expect(button.getAttribute('type'), `「${button.textContent}」に type が無い`).toMatch(/^(button|submit)$/);
    }
  });

  it('見出しは h1「組織管理」の下に、作成と一覧の h2 がある。検索欄は search のフォーム、ページ送りは nav', () => {
    expect(container.querySelector('h1')?.textContent).toBe('組織管理');
    expect(Array.from(container.querySelectorAll('h2')).map((h) => h.textContent)).toEqual(['組織を作成', '組織一覧']);
    expect(container.querySelector('form[role="search"]')?.getAttribute('aria-label')).toBe('組織の検索');
    expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('ページ送り');
    expect(container.querySelector('table caption')?.textContent).toContain('組織の一覧');
    for (const th of Array.from(container.querySelectorAll('thead th'))) {
      expect(th.getAttribute('scope')).toBe('col');
    }
  });

  it('オーナー欄の説明が結びつき、空欄なら操作している自分がオーナーになることを伝える', () => {
    const describedBy = createOwner().getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const help = container.querySelector(`#${describedBy}`);
    expect(help?.textContent).toContain('空欄のときは');
    expect(help?.textContent).toContain('あなた自身がオーナー');
  });
});
