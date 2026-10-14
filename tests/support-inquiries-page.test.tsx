/**
 * #1121 Web の問い合わせ管理画面 (/support/inquiries) の表示テスト
 *
 * 従来は一覧の取得に失敗しても !res.ok を握りつぶしていたため、サポート担当者には
 * 「該当する問い合わせはありません」と出て、問い合わせがゼロに見えた (API 自体が無かった)。
 * 更新 (PUT) の失敗も握りつぶしていた。修正後は次のようになる。
 *   - 一覧の取得に失敗したら、エラー (理由つき) と「再読み込み」を出し、「該当なし」は出さない
 *   - 本当に 0 件のときだけ「該当する問い合わせはありません」を出す
 *   - 1 ページ (50 件) を超える分は「さらに読み込む」で追加できる (件数の表示は total を使う)
 *   - 絞り込みを素早く切り替えても、古い応答 (失敗の本文を読んでいる間に切り替わった場合を含む) で一覧を上書きしない
 *   - 一覧は概要だけ。問い合わせを開いたときに詳細 API から本文と管理者メモを取る (取得した時点で API が閲覧を監査ログに残す)。
 *     取得できるまで (または失敗したとき) は、見えていないメモを上書きしないよう、メモの編集とステータス変更を止める。
 *     問い合わせを素早く選び直したり閉じたりしても、古い詳細・古い失敗でパネルを上書きしない
 *   - 更新に失敗したら詳細パネルにエラーを出し、ステータス表示は変えず、一覧も取り直さない
 *   - 更新している間は、別の問い合わせへ切り替えたり詳細パネルを閉じたりできない (更新の結果を別のパネルに書き込まないため)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// アニメーションは本題ではないので、motion.* は同じタグの素の要素、AnimatePresence は子をそのまま返す
vi.mock('framer-motion', () => {
  const MOTION_ONLY_PROPS = ['initial', 'animate', 'exit'];
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!cache.has(tag)) {
          cache.set(tag, (props: Record<string, unknown>) =>
            createElement(
              tag,
              Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'children' && !MOTION_ONLY_PROPS.includes(key))),
              props.children as React.ReactNode,
            ),
          );
        }
        return cache.get(tag);
      },
    },
  );
  return { motion, AnimatePresence: (props: { children?: React.ReactNode }) => props.children ?? null };
});

const { default: SupportInquiriesPage } = await import('@/app/(support)/support/inquiries/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─────────────────────────────────────────────────────────────────────────────
// 道具
// ─────────────────────────────────────────────────────────────────────────────

/** 一覧が返す 1 件 (概要)。本文と管理者メモは含まない */
function summary(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `inq-${n}`,
    userId: null,
    userName: null,
    inquiryType: 'general',
    email: `user${n}@example.com`,
    subject: `件名${n}`,
    status: 'pending',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  };
}

/** 詳細・更新が返す 1 件 (概要 + 本文 + 管理者メモ) */
function detail(n: number, overrides: Record<string, unknown> = {}) {
  return { ...summary(n), message: `本文${n}`, adminNotes: null, ...overrides };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** ステータスは先に届くが、本文は release() を呼ぶまで届かない失敗の応答 (本文を読んでいる間に状況が変わる場合の再現用) */
function gatedFailure(status: number, body: unknown) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await gate;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
      controller.close();
    },
  });
  const response = new Response(stream, { status, headers: { 'content-type': 'application/json' } });
  return { response, release };
}

const listBody = (inquiries: unknown[], total = inquiries.length) => ({ inquiries, total, page: 1, limit: 50 });
const errorBody = (code: string, message: string) => ({ error: { code, message } });

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
  detail?: (id: string) => Response | Promise<Response>;
  put?: (id: string, body: Record<string, unknown>) => Response | Promise<Response>;
}

/** API ごとの応答を決める。想定外の呼び出しはテストを失敗させる */
function mockApi(api: Api) {
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const one = url.pathname.match(/^\/api\/admin\/inquiries\/([^/]+)$/);
    if (url.pathname === '/api/admin/inquiries' && method === 'GET' && api.list) return api.list(url);
    if (one && method === 'GET' && api.detail) return api.detail(one[1]);
    if (one && method === 'PUT' && api.put) return api.put(one[1], JSON.parse(String(init?.body)));
    throw new Error(`想定していない fetch: ${method} ${input}`);
  });
}

const text = () => container.textContent ?? '';
const alerts = () => Array.from(container.querySelectorAll('[role="alert"]')).map((el) => el.textContent ?? '');

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
}

/** 一覧の行 (クリックで詳細パネルが開く) */
function findRow(subject: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('div.cursor-pointer')).find((el) => el.textContent?.includes(subject));
}

const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement;

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

async function selectFilter(value: string) {
  const select = container.querySelector('select') as HTMLSelectElement;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function typeNote(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea(), value);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** fetch の呼び出しのうち、メソッドと URL (パス) に合うもの */
function callsOf(method: string, matches: (url: URL) => boolean) {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const m = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    return m === method && matches(new URL(String(input), 'http://localhost'));
  });
}

const listCalls = () => callsOf('GET', (url) => url.pathname === '/api/admin/inquiries');
const detailCalls = (id: string) => callsOf('GET', (url) => url.pathname === `/api/admin/inquiries/${id}`);
const putCalls = (id: string) => callsOf('PUT', (url) => url.pathname === `/api/admin/inquiries/${id}`);
const listParams = (callIndex: number) => new URL(String(listCalls()[callIndex][0]), 'http://localhost').searchParams;
const putBody = (id: string, callIndex = 0) => JSON.parse(String((putCalls(id)[callIndex][1] as RequestInit).body));

async function renderPage() {
  await act(async () => {
    root.render(createElement(SupportInquiriesPage));
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

describe('一覧の取得', () => {
  it('取得に失敗したら、「該当する問い合わせはありません」ではなく理由つきのエラーを出す', async () => {
    mockApi({ list: () => jsonResponse(500, errorBody('INTERNAL_ERROR', '問い合わせの取得に失敗しました')) });
    await renderPage();

    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('問い合わせを取得できませんでした');
    expect(alerts()[0]).toContain('問い合わせの取得に失敗しました');
    expect(text()).not.toContain('該当する問い合わせはありません');
    expect(text()).not.toContain('0件の問い合わせ');
    expect(findButton('再読み込み')).toBeDefined();
  });

  it('権限が無いとき (403) は、その理由を出す', async () => {
    mockApi({ list: () => jsonResponse(403, errorBody('OP_PERMISSION_DENIED', '権限がありません')) });
    await renderPage();
    expect(alerts()[0]).toContain('権限がありません');
    expect(text()).not.toContain('該当する問い合わせはありません');
  });

  it('本文が JSON でない失敗 (プロキシの 502 など) でも、HTTP ステータスつきのエラーを出す', async () => {
    mockApi({ list: () => new Response('<html>Bad Gateway</html>', { status: 502 }) });
    await renderPage();
    expect(alerts()[0]).toContain('HTTP 502');
    expect(text()).not.toContain('該当する問い合わせはありません');
  });

  it('通信エラー (fetch が失敗) でもエラーを出す', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await renderPage();
    expect(alerts()[0]).toContain('通信エラー');
    expect(text()).not.toContain('該当する問い合わせはありません');
  });

  it('「再読み込み」で取り直せて、成功するとエラー表示が消える', async () => {
    let calls = 0;
    mockApi({
      list: () =>
        ++calls === 1
          ? jsonResponse(500, errorBody('INTERNAL_ERROR', '問い合わせの取得に失敗しました'))
          : jsonResponse(200, listBody([summary(1), summary(2)])),
    });
    await renderPage();
    expect(alerts()).toHaveLength(1);

    await click(findButton('再読み込み'), '再読み込みボタン');
    expect(alerts()).toEqual([]);
    expect(text()).toContain('件名1');
    expect(text()).toContain('件名2');
    expect(text()).toContain('2件の問い合わせ');
  });

  it('取得できたら一覧と件数を出す。エラー表示は出さず、本文は一覧には出さない', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([summary(1, { userName: 'たろう' }), summary(2, { status: 'resolved' })])),
    });
    await renderPage();

    expect(alerts()).toEqual([]);
    expect(text()).toContain('件名1');
    expect(text()).toContain('たろう'); // 会員はニックネーム
    expect(text()).toContain('user2@example.com'); // ゲストはメールアドレス
    expect(text()).toContain('2件の問い合わせ');
    expect(text()).not.toContain('該当する問い合わせはありません');
    expect(text()).not.toContain('本文1');
  });

  it('本当に 0 件のときだけ「該当する問い合わせはありません」を出す', async () => {
    mockApi({ list: () => jsonResponse(200, listBody([])) });
    await renderPage();
    expect(alerts()).toEqual([]);
    expect(text()).toContain('該当する問い合わせはありません');
  });

  it('最初の取得は 1 ページ目・50 件で、絞り込みなし', async () => {
    mockApi({ list: () => jsonResponse(200, listBody([summary(1)])) });
    await renderPage();
    expect(listCalls()).toHaveLength(1);
    expect(Object.fromEntries(listParams(0))).toEqual({ page: '1', limit: '50' });
  });

  it('ステータスで絞り込むと、status を付けて 1 ページ目から取り直す', async () => {
    mockApi({ list: () => jsonResponse(200, listBody([summary(1)])) });
    await renderPage();
    await selectFilter('in_progress');
    await settle();
    expect(listCalls()).toHaveLength(2);
    expect(Object.fromEntries(listParams(1))).toEqual({ page: '1', limit: '50', status: 'in_progress' });
  });

  it('絞り込みを素早く切り替えても、古い応答で一覧を上書きしない', async () => {
    const slow = deferred<Response>();
    mockApi({
      list: (url) => {
        const status = url.searchParams.get('status');
        if (status === 'in_progress') return slow.promise; // 遅い応答
        if (status === 'pending') return jsonResponse(200, listBody([summary(2)]));
        return jsonResponse(200, listBody([summary(1)]));
      },
    });
    await renderPage();
    expect(text()).toContain('件名1');

    await selectFilter('in_progress'); // 応答待ち
    await selectFilter('pending'); // こちらが先に返る
    await settle();
    expect(text()).toContain('件名2');

    await act(async () => {
      slow.resolve(jsonResponse(200, listBody([summary(3)])));
    });
    await settle();
    expect(text()).toContain('件名2');
    expect(text()).not.toContain('件名3');
  });

  it('失敗の本文を読んでいる間に絞り込みが切り替わったら、古い失敗で一覧を消したりエラーを出したりしない', async () => {
    const stale = gatedFailure(500, errorBody('INTERNAL_ERROR', '問い合わせの取得に失敗しました'));
    mockApi({
      list: (url) => {
        const status = url.searchParams.get('status');
        if (status === 'in_progress') return stale.response; // 失敗。ただし本文はまだ届かない
        if (status === 'pending') return jsonResponse(200, listBody([summary(2)]));
        return jsonResponse(200, listBody([summary(1)]));
      },
    });
    await renderPage();

    await selectFilter('in_progress'); // 失敗の本文を待っている
    await settle();
    await selectFilter('pending'); // こちらは成功して一覧に反映される
    await settle();
    expect(text()).toContain('件名2');
    expect(alerts()).toEqual([]);

    await act(async () => {
      stale.release();
    });
    await settle();
    expect(text()).toContain('件名2'); // 一覧は空にならない
    expect(alerts()).toEqual([]); // 古い失敗のエラー表示は出ない
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 「さらに読み込む」
// ─────────────────────────────────────────────────────────────────────────────

describe('ページ送り', () => {
  const page1 = Array.from({ length: 50 }, (_, i) => summary(i + 1));
  // 2 ページ目の先頭は、1 ページ目の最後と同じ行 (読み込み中に新しい問い合わせが入ってずれた場合)
  const page2 = Array.from({ length: 11 }, (_, i) => summary(i + 50));

  it('50 件を超える分は「さらに読み込む」で追加する。件数は total、重複は 1 行にまとめ、最後のページでボタンが消える', async () => {
    mockApi({
      list: (url) => {
        const pageParam = url.searchParams.get('page');
        return jsonResponse(200, { ...listBody(pageParam === '2' ? page2 : page1, 60), page: Number(pageParam) });
      },
    });
    await renderPage();

    expect(text()).toContain('60件の問い合わせ'); // 表示中の 50 件ではなく total
    expect(container.querySelectorAll('div.cursor-pointer')).toHaveLength(50);
    expect(findButton('さらに読み込む')).toBeDefined();

    await click(findButton('さらに読み込む'), '「さらに読み込む」ボタン');
    expect(listCalls()).toHaveLength(2);
    expect(Object.fromEntries(listParams(1))).toEqual({ page: '2', limit: '50' });
    // 50 + 11 - 重複 1 = 60 行
    expect(container.querySelectorAll('div.cursor-pointer')).toHaveLength(60);
    expect(text()).toContain('件名60');
    expect(findButton('さらに読み込む')).toBeUndefined();
  });

  it('全件が 1 ページに収まるときは「さらに読み込む」を出さない', async () => {
    mockApi({ list: () => jsonResponse(200, listBody(page1, 50)) });
    await renderPage();
    expect(findButton('さらに読み込む')).toBeUndefined();
  });

  it('追加の読み込みに失敗しても、表示済みの一覧は残し、エラーを出す', async () => {
    let calls = 0;
    mockApi({
      list: () =>
        ++calls === 1
          ? jsonResponse(200, listBody(page1, 60))
          : jsonResponse(500, errorBody('INTERNAL_ERROR', '問い合わせの取得に失敗しました')),
    });
    await renderPage();

    await click(findButton('さらに読み込む'), '「さらに読み込む」ボタン');
    expect(alerts()[0]).toContain('問い合わせを取得できませんでした');
    expect(container.querySelectorAll('div.cursor-pointer')).toHaveLength(50);
    expect(findButton('さらに読み込む')).toBeDefined(); // もう一度試せる
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 問い合わせを開く (詳細の取得)
// ─────────────────────────────────────────────────────────────────────────────

describe('問い合わせを開く', () => {
  it('開いた問い合わせの本文と管理者メモを詳細 API から取得して出し、メモを入力欄に入れる', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([summary(1)])),
      detail: () => jsonResponse(200, { inquiry: detail(1, { adminNotes: '調査中' }) }),
    });
    await renderPage();
    expect(detailCalls('inq-1')).toHaveLength(0); // 一覧を出しただけでは詳細を取らない

    await click(findRow('件名1'), '一覧の行');

    expect(detailCalls('inq-1')).toHaveLength(1);
    expect(text()).toContain('本文1');
    expect(textarea().value).toBe('調査中');
    expect(textarea().disabled).toBe(false);
    expect(alerts()).toEqual([]);
    // 現在のステータス (未対応) 以外は押せる
    expect(findButton('未対応')!.disabled).toBe(true);
    expect(findButton('対応中')!.disabled).toBe(false);
  });

  it('取得中は「読み込み中」を出し、メモの編集とステータス変更を止める', async () => {
    const slow = deferred<Response>();
    mockApi({
      list: () => jsonResponse(200, listBody([summary(1)])),
      detail: () => slow.promise,
    });
    await renderPage();
    await click(findRow('件名1'), '一覧の行');

    // 概要 (件名・送信者) はすぐ出るが、本文はまだ
    expect(text()).toContain('件名1');
    expect(text()).toContain('読み込み中...');
    expect(text()).not.toContain('本文1');
    expect(textarea().disabled).toBe(true);
    expect(findButton('対応中')!.disabled).toBe(true);

    await act(async () => {
      slow.resolve(jsonResponse(200, { inquiry: detail(1) }));
    });
    await settle();
    expect(text()).toContain('本文1');
    expect(text()).not.toContain('読み込み中...');
    expect(textarea().disabled).toBe(false);
    expect(findButton('対応中')!.disabled).toBe(false);
  });

  it('詳細を取得できなかったら、理由つきのエラーを出し、メモの編集とステータス変更を止める。「再試行」で取り直せる', async () => {
    let calls = 0;
    mockApi({
      list: () => jsonResponse(200, listBody([summary(1)])),
      detail: () =>
        ++calls === 1
          ? jsonResponse(500, errorBody('INTERNAL_ERROR', '問い合わせの取得に失敗しました'))
          : jsonResponse(200, { inquiry: detail(1, { adminNotes: '調査中' }) }),
    });
    await renderPage();
    await click(findRow('件名1'), '一覧の行');

    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('問い合わせの内容を取得できませんでした');
    expect(alerts()[0]).toContain('問い合わせの取得に失敗しました');
    expect(text()).not.toContain('本文1');
    // 見えていないメモを上書きしないよう、編集とステータス変更はできない
    expect(textarea().disabled).toBe(true);
    expect(findButton('対応中')!.disabled).toBe(true);

    await click(findButton('再試行'), '再試行ボタン');
    expect(alerts()).toEqual([]);
    expect(text()).toContain('本文1');
    expect(textarea().value).toBe('調査中');
    expect(findButton('対応中')!.disabled).toBe(false);
  });

  it('通信エラーでも、エラーを出してメモの編集を止める', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockImplementation(async (input: string) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/admin/inquiries') {
        return jsonResponse(200, listBody([summary(1)]));
      }
      throw new TypeError('Failed to fetch');
    });
    await renderPage();
    await click(findRow('件名1'), '一覧の行');
    expect(alerts()[0]).toContain('通信エラー');
    expect(textarea().disabled).toBe(true);
  });

  it('別の問い合わせをすぐ選び直したら、先に選んだ問い合わせの遅い応答では上書きしない', async () => {
    const slow = deferred<Response>();
    mockApi({
      list: () => jsonResponse(200, listBody([summary(1), summary(2)])),
      detail: (id) => (id === 'inq-1' ? slow.promise : jsonResponse(200, { inquiry: detail(2) })),
    });
    await renderPage();
    await click(findRow('件名1'), '1 件目');
    await click(findRow('件名2'), '2 件目');
    expect(text()).toContain('本文2');

    await act(async () => {
      slow.resolve(jsonResponse(200, { inquiry: detail(1) }));
    });
    await settle();
    expect(text()).toContain('本文2');
    expect(text()).not.toContain('本文1');
  });

  it('失敗の本文を読んでいる間に別の問い合わせを開いたら、古い失敗のエラーは出さない', async () => {
    const stale = gatedFailure(500, errorBody('INTERNAL_ERROR', '問い合わせの取得に失敗しました'));
    mockApi({
      list: () => jsonResponse(200, listBody([summary(1), summary(2)])),
      detail: (id) => (id === 'inq-1' ? stale.response : jsonResponse(200, { inquiry: detail(2) })),
    });
    await renderPage();
    await click(findRow('件名1'), '1 件目'); // 失敗の本文を待っている
    await click(findRow('件名2'), '2 件目');
    expect(text()).toContain('本文2');

    await act(async () => {
      stale.release();
    });
    await settle();
    expect(alerts()).toEqual([]);
    expect(text()).toContain('本文2');
    expect(textarea().disabled).toBe(false);
  });

  it('閉じたあとに遅れて届いた詳細では、パネルを開き直さない', async () => {
    const slow = deferred<Response>();
    mockApi({
      list: () => jsonResponse(200, listBody([summary(1)])),
      detail: () => slow.promise,
    });
    await renderPage();
    await click(findRow('件名1'), '一覧の行');
    await click(findButton('✕'), '閉じるボタン');
    expect(text()).not.toContain('管理者メモ');

    await act(async () => {
      slow.resolve(jsonResponse(200, { inquiry: detail(1) }));
    });
    await settle();
    expect(text()).not.toContain('管理者メモ');
    expect(text()).not.toContain('本文1');
  });

  it('別の問い合わせを選ぶと、前のエラー表示は消える', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([summary(1), summary(2)])),
      detail: (id) =>
        id === 'inq-1'
          ? jsonResponse(500, errorBody('INTERNAL_ERROR', '問い合わせの取得に失敗しました'))
          : jsonResponse(200, { inquiry: detail(2) }),
    });
    await renderPage();
    await click(findRow('件名1'), '1 件目');
    expect(alerts()).toHaveLength(1);

    await click(findRow('件名2'), '2 件目');
    expect(alerts()).toEqual([]);
    expect(text()).toContain('本文2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 更新
// ─────────────────────────────────────────────────────────────────────────────

describe('ステータスの更新 (PUT)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('更新に失敗したら、詳細パネルに理由つきのエラーを出し、ステータス表示を変えず、一覧も取り直さない', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([summary(1)])),
      detail: () => jsonResponse(200, { inquiry: detail(1) }),
      put: () => jsonResponse(403, errorBody('OP_PERMISSION_DENIED', '権限がありません')),
    });
    await renderPage();
    await click(findRow('件名1'), '一覧の行');

    await click(findButton('対応中'), '「対応中」ボタン');

    expect(putCalls('inq-1')).toHaveLength(1);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('更新に失敗しました');
    expect(alerts()[0]).toContain('権限がありません');
    // 現在のステータス (未対応) のまま。ボタンも押し直せる
    expect(findButton('未対応')!.disabled).toBe(true);
    expect(findButton('対応中')!.disabled).toBe(false);
    expect(listCalls()).toHaveLength(1);
  });

  it('通信エラーでもエラーを出す', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (init?.method === 'PUT') throw new TypeError('Failed to fetch');
      if (url.pathname === '/api/admin/inquiries') return jsonResponse(200, listBody([summary(1)]));
      return jsonResponse(200, { inquiry: detail(1) });
    });
    await renderPage();
    await click(findRow('件名1'), '一覧の行');
    await click(findButton('完了'), '「完了」ボタン');
    expect(alerts()[0]).toContain('更新に失敗しました（通信エラー）');
  });

  it('更新に失敗したあと、別の問い合わせを選ぶとエラー表示は消える', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([summary(1), summary(2)])),
      detail: (id) => jsonResponse(200, { inquiry: detail(id === 'inq-1' ? 1 : 2) }),
      put: () => jsonResponse(500, errorBody('INTERNAL_ERROR', '問い合わせの更新に失敗しました')),
    });
    await renderPage();
    await click(findRow('件名1'), '1 件目');
    await click(findButton('対応中'), '「対応中」ボタン');
    expect(alerts()).toHaveLength(1);

    await click(findRow('件名2'), '2 件目');
    expect(alerts()).toEqual([]);
  });

  it('更新に成功したら、API が返した更新後の問い合わせで詳細パネルを更新し、一覧を取り直す', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([summary(1)])),
      detail: () => jsonResponse(200, { inquiry: detail(1) }),
      put: () => jsonResponse(200, { inquiry: detail(1, { status: 'in_progress', adminNotes: '確認中です' }) }),
    });
    await renderPage();
    await click(findRow('件名1'), '一覧の行');
    await typeNote('確認中です');

    await click(findButton('対応中'), '「対応中」ボタン');

    expect(putCalls('inq-1')).toHaveLength(1);
    expect(putBody('inq-1')).toEqual({ status: 'in_progress', adminNotes: '確認中です' });
    expect(alerts()).toEqual([]);
    expect(listCalls()).toHaveLength(2); // 更新後に取り直す
    expect(detailCalls('inq-1')).toHaveLength(1); // 更新のあとに詳細を取り直さない (閲覧の記録を増やさない)
    // 現在のステータスが「対応中」になり、押せなくなる
    expect(findButton('対応中')!.disabled).toBe(true);
    expect(findButton('未対応')!.disabled).toBe(false);
    // 入力欄には保存されたメモが残る
    expect(textarea().value).toBe('確認中です');
    expect(text()).toContain('本文1');
  });

  it('更新している間は、別の問い合わせを開いたり詳細パネルを閉じたりできない (結果を別のパネルに書き込まないため)', async () => {
    const slow = deferred<Response>();
    mockApi({
      list: () => jsonResponse(200, listBody([summary(1), summary(2)])),
      detail: (id) => jsonResponse(200, { inquiry: detail(id === 'inq-1' ? 1 : 2) }),
      put: () => slow.promise,
    });
    await renderPage();
    await click(findRow('件名1'), '1 件目');
    await click(findButton('対応中'), '「対応中」ボタン'); // 更新の応答待ち

    await click(findRow('件名2'), '2 件目');
    expect(detailCalls('inq-2')).toHaveLength(0);
    expect(text()).toContain('本文1');
    expect(text()).not.toContain('本文2');
    expect(findButton('✕')!.disabled).toBe(true);

    await act(async () => {
      slow.resolve(jsonResponse(200, { inquiry: detail(1, { status: 'in_progress' }) }));
    });
    await settle();
    // 更新が終われば、結果は更新した問い合わせのパネルに入り、別の問い合わせも開ける
    expect(findButton('対応中')!.disabled).toBe(true);
    expect(findButton('✕')!.disabled).toBe(false);
    await click(findRow('件名2'), '2 件目');
    expect(detailCalls('inq-2')).toHaveLength(1);
    expect(text()).toContain('本文2');
    expect(findButton('未対応')!.disabled).toBe(true); // 件名2 は未対応のまま
  });

  it('メモを入力していなければ、ボディに adminNotes を含めない (既存のメモを消さない)', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([summary(1)])),
      detail: () => jsonResponse(200, { inquiry: detail(1) }),
      put: () => jsonResponse(200, { inquiry: detail(1, { status: 'resolved' }) }),
    });
    await renderPage();
    await click(findRow('件名1'), '一覧の行');
    await click(findButton('解決済'), '「解決済」ボタン');

    expect(putBody('inq-1')).toEqual({ status: 'resolved' });
  });

  it('既存のメモがあれば、読み込んだメモをそのまま送る (入力欄が空のまま上書きしない)', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([summary(1)])),
      detail: () => jsonResponse(200, { inquiry: detail(1, { adminNotes: '調査中' }) }),
      put: () => jsonResponse(200, { inquiry: detail(1, { status: 'resolved', adminNotes: '調査中' }) }),
    });
    await renderPage();
    await click(findRow('件名1'), '一覧の行');
    await click(findButton('解決済'), '「解決済」ボタン');

    expect(putBody('inq-1')).toEqual({ status: 'resolved', adminNotes: '調査中' });
  });
});
