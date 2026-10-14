/**
 * お知らせ管理 (/admin/announcements) の画面のテスト
 * operator/03-ui-spec.md §21
 *
 * お知らせの API (GET / POST /api/announcements) はあったが、使う画面が無かった (モバイルの管理画面は #1389 で削除済み)。
 * 画面で確かめること:
 *   - 一覧: GET /api/announcements (管理用 = mode なし) の結果を、API が返した順 (作成が新しい順) のまま、
 *     タイトル・公開/下書き・公開日時・作成日時で表示する。読み込み中・0 件・失敗の表示がある
 *   - 作成: タイトル・本文・「公開する」を POST /api/announcements に送り (isPublic)、成功したら一覧を取り直す。
 *     400 (入力の誤り) は API のメッセージをそのまま出し、それ以外の失敗は汎用の日本語のメッセージを出す
 *   - 二重送信しない。遅れて届いた古い一覧で、新しい一覧を上書きしない
 *   - 入力欄はラベルと結びつき、ボタンには type がある
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { default: AnnouncementsManager } = await import('@/app/admin/announcements/AnnouncementsManager');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─────────────────────────────────────────────────────────────────────────────
// 道具
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/announcements が返す 1 件 (select('*') なので画面で使わない列も含む)。時刻は UTC (日本時間 = +9 時間) */
function announcement(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `ann-${n}`,
    title: `お知らせ${n}`,
    content: `本文${n}`,
    is_public: true,
    published_at: '2026-10-08T05:00:00.000Z', // 日本時間 2026/10/08 14:00
    created_at: '2026-10-08T04:30:00.000Z', // 日本時間 2026/10/08 13:30
    updated_at: '2026-10-08T04:30:00.000Z',
    created_by: 'admin-1',
    category: 'general',
    priority: 0,
    target_audience: 'all',
    expires_at: null,
    image_url: null,
    ...overrides,
  };
}

const listBody = (announcements: unknown[]) => ({ announcements });

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
  list?: () => Response | Promise<Response>;
  create?: (body: Record<string, unknown>) => Response | Promise<Response>;
}

/** API ごとの応答を決める。想定外の呼び出しはテストを失敗させる */
function mockApi(api: Api) {
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (input === '/api/announcements' && method === 'GET' && api.list) return api.list();
    if (input === '/api/announcements' && method === 'POST' && api.create) {
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

const titleInput = () => container.querySelector('#announcement-title') as HTMLInputElement;
const contentInput = () => container.querySelector('#announcement-content') as HTMLTextAreaElement;
const publicCheckbox = () => container.querySelector('#announcement-is-public') as HTMLInputElement;

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
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
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** タイトルと本文を入れる (公開するかどうかは触らない) */
async function fillForm(title: string, content: string) {
  await type(titleInput(), title);
  await type(contentInput(), content);
}

/** fetch の呼び出しのうち、メソッドが合うもの */
const callsOf = (method: string) =>
  fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === method);

const postBody = (callIndex = 0) => JSON.parse(String((callsOf('POST')[callIndex][1] as RequestInit).body));

async function renderPage() {
  await act(async () => {
    root.render(<AnnouncementsManager />);
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
  it('管理用の GET /api/announcements (mode なし) で取得し、新しい順に、公開/下書き・公開日時・作成日時を日本時間で出す', async () => {
    mockApi({
      list: () =>
        jsonResponse(
          200,
          listBody([
            announcement(3, { title: '新しいお知らせ', created_at: '2026-10-08T04:30:00.000Z' }),
            announcement(2, {
              title: '下書きのお知らせ',
              is_public: false,
              published_at: null,
              created_at: '2026-10-07T00:05:00.000Z', // 日本時間 2026/10/07 09:05
            }),
            announcement(1, { title: '古いお知らせ', is_public: null, published_at: null, created_at: '2026-10-01T15:00:00.000Z' }), // 日本時間 2026/10/02 00:00
          ]),
        ),
    });
    await renderPage();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/announcements');
    expect(alerts()).toEqual([]);
    expect(rows()).toEqual([
      ['新しいお知らせ', '公開', '2026/10/08 14:00', '2026/10/08 13:30'],
      ['下書きのお知らせ', '下書き', '-', '2026/10/07 09:05'],
      ['古いお知らせ', '下書き', '-', '2026/10/02 00:00'], // is_public が null も下書き
    ]);
    expect(text()).toContain('全 3 件');
    expect(Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent)).toEqual([
      'タイトル',
      '状態',
      '公開日時',
      '作成日時',
    ]);
  });

  it('API が並べ替えずに返しても、作成日時の新しい順に出す。作成日時が無いものは末尾、同じ日時は API の順のまま', async () => {
    mockApi({
      list: () =>
        jsonResponse(
          200,
          listBody([
            announcement(1, { title: '古い', created_at: '2026-10-01T00:00:00.000Z' }),
            announcement(2, { title: '日時なし', created_at: null }),
            announcement(3, { title: '新しい', created_at: '2026-10-08T00:00:00.000Z' }),
            announcement(4, { title: '同じ日時のA', created_at: '2026-10-05T00:00:00.000Z' }),
            announcement(5, { title: '読めない日時', created_at: 'not-a-date' }),
            announcement(6, { title: '同じ日時のB', created_at: '2026-10-05T00:00:00.000Z' }),
          ]),
        ),
    });
    await renderPage();

    expect(rows().map((cells) => cells[0])).toEqual(['新しい', '同じ日時のA', '同じ日時のB', '古い', '日時なし', '読めない日時']);
  });

  it('取得している間は「読み込み中...」を出し、届いたら消える', async () => {
    const slow = deferred<Response>();
    mockApi({ list: () => slow.promise });
    await renderPage();

    expect(statuses()).toContain('読み込み中...');
    expect(text()).not.toContain('お知らせはまだありません');
    expect(container.querySelector('table')).toBeNull();

    await act(async () => {
      slow.resolve(jsonResponse(200, listBody([announcement(1)])));
    });
    await settle();
    expect(statuses()).not.toContain('読み込み中...');
    expect(rows()).toHaveLength(1);
  });

  it('本当に 0 件のときだけ「お知らせはまだありません」を出す', async () => {
    mockApi({ list: () => jsonResponse(200, listBody([])) });
    await renderPage();

    expect(text()).toContain('お知らせはまだありません');
    expect(text()).toContain('全 0 件');
    expect(alerts()).toEqual([]);
    expect(container.querySelector('table')).toBeNull();
  });

  it('取得に失敗したら、0 件に見せずに汎用の日本語のエラーを出す。API の生のエラー文は出さない', async () => {
    mockApi({ list: () => jsonResponse(500, { error: 'Internal server error' }) });
    await renderPage();

    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('お知らせ一覧を取得できませんでした');
    expect(alerts()[0]).not.toContain('Internal server error');
    expect(text()).not.toContain('お知らせはまだありません');
    expect(text()).not.toContain('全 0 件');
  });

  it('権限が無い (403) ときは「権限がありません」、ログインが切れた (401) ときはその旨を出す', async () => {
    mockApi({ list: () => jsonResponse(403, { error: 'Forbidden' }) });
    await renderPage();
    expect(alerts()[0]).toContain('権限がありません');

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    mockApi({ list: () => jsonResponse(401, { error: 'Unauthorized' }) });
    await renderPage();
    expect(alerts()[0]).toContain('ログインの有効期限が切れました');
  });

  it('通信エラー (fetch が失敗) でも汎用のエラーを出す', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await renderPage();
    expect(alerts()[0]).toContain('お知らせ一覧を取得できませんでした');
    expect(text()).not.toContain('お知らせはまだありません');
  });

  it('想定外の形の応答 (announcements が配列でない) を「0 件」と見せず、エラーにする', async () => {
    mockApi({ list: () => jsonResponse(200, { announcements: null }) });
    await renderPage();
    expect(alerts()[0]).toContain('お知らせ一覧を取得できませんでした');
    expect(text()).not.toContain('お知らせはまだありません');
  });

  it('「再読み込み」で取り直せて、成功するとエラー表示が消える', async () => {
    let calls = 0;
    mockApi({
      list: () => (++calls === 1 ? jsonResponse(500, { error: 'Internal server error' }) : jsonResponse(200, listBody([announcement(1)]))),
    });
    await renderPage();
    expect(alerts()).toHaveLength(1);

    await click(findButton('再読み込み'), '再読み込みボタン');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(alerts()).toEqual([]);
    expect(rows()).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 作成
// ─────────────────────────────────────────────────────────────────────────────

describe('作成', () => {
  it('タイトル・本文・公開するを POST し (前後の空白は除く)、成功したら一覧を取り直して、フォームを空に戻す', async () => {
    let created = false;
    mockApi({
      list: () =>
        jsonResponse(
          200,
          listBody(created ? [announcement(2, { title: '新機能のお知らせ' }), announcement(1)] : [announcement(1)]),
        ),
      create: () => {
        created = true;
        return jsonResponse(200, { announcement: announcement(2, { title: '新機能のお知らせ' }) });
      },
    });
    await renderPage();
    expect(rows()).toHaveLength(1);

    await fillForm('  新機能のお知らせ  ', '  新しい機能を追加しました。\n詳しくはヘルプをご覧ください。\n');
    await click(publicCheckbox(), '「公開する」');
    await click(findButton('作成する'), '作成ボタン');

    // 送った内容
    expect(callsOf('POST')).toHaveLength(1);
    const [url, init] = callsOf('POST')[0] as [string, RequestInit];
    expect(url).toBe('/api/announcements');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(postBody()).toEqual({
      title: '新機能のお知らせ',
      content: '新しい機能を追加しました。\n詳しくはヘルプをご覧ください。',
      isPublic: true,
    });

    // 成功したら一覧を取り直し、新しいお知らせが出る
    expect(callsOf('GET')).toHaveLength(2);
    expect(rows().map((cells) => cells[0])).toEqual(['新機能のお知らせ', 'お知らせ1']);
    // フォームは空に戻り、結果を知らせる
    expect(titleInput().value).toBe('');
    expect(contentInput().value).toBe('');
    expect(publicCheckbox().checked).toBe(false);
    expect(statuses()).toContain('お知らせを公開しました。');
    expect(alerts()).toEqual([]);
  });

  it('「公開する」を付けなければ isPublic: false (下書き) で送る', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([])),
      create: () => jsonResponse(200, { announcement: announcement(1, { is_public: false, published_at: null }) }),
    });
    await renderPage();

    expect(publicCheckbox().checked).toBe(false); // 初期値は公開しない
    await fillForm('下書き', '本文');
    await click(findButton('作成する'), '作成ボタン');

    expect(postBody()).toEqual({ title: '下書き', content: '本文', isPublic: false });
    expect(statuses()).toContain('お知らせを下書きとして保存しました。');
  });

  it('作成している間は入力欄とボタンを止め、二重に送らない。終わったら戻る', async () => {
    const slow = deferred<Response>();
    mockApi({
      list: () => jsonResponse(200, listBody([])),
      create: () => slow.promise,
    });
    await renderPage();
    await fillForm('題名', '本文');

    await click(findButton('作成する'), '作成ボタン'); // 応答待ち
    expect(findButton('作成中...')?.disabled).toBe(true);
    expect(titleInput().disabled).toBe(true);
    expect(contentInput().disabled).toBe(true);
    expect(publicCheckbox().disabled).toBe(true);

    await click(findButton('作成中...'), '作成中のボタン'); // 止まっているので送られない
    expect(callsOf('POST')).toHaveLength(1);

    await act(async () => {
      slow.resolve(jsonResponse(200, { announcement: announcement(1) }));
    });
    await settle();
    expect(findButton('作成する')?.disabled).toBe(false);
    expect(titleInput().disabled).toBe(false);
    expect(callsOf('POST')).toHaveLength(1);
  });

  it('400 (入力の誤り) のときは、API が返したメッセージをそのまま出す。入力は消さず、一覧も取り直さない', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([announcement(1)])),
      create: () => jsonResponse(400, { error: 'title and content are required' }),
    });
    await renderPage();
    await fillForm('題名', '本文');
    await click(publicCheckbox(), '「公開する」');
    await click(findButton('作成する'), '作成ボタン');

    expect(callsOf('POST')).toHaveLength(1);
    expect(alerts()).toEqual(['title and content are required']);
    expect(statuses()).toEqual([]);
    // 入力は残る (直してもう一度送れる)
    expect(titleInput().value).toBe('題名');
    expect(contentInput().value).toBe('本文');
    expect(publicCheckbox().checked).toBe(true);
    expect(findButton('作成する')?.disabled).toBe(false);
    // 作成されていないので、一覧は取り直さない
    expect(callsOf('GET')).toHaveLength(1);
  });

  it('メッセージを読み取れない 400 は、汎用の日本語のメッセージを出す', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([])),
      create: () => new Response('<html>Bad Request</html>', { status: 400 }),
    });
    await renderPage();
    await fillForm('題名', '本文');
    await click(findButton('作成する'), '作成ボタン');

    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('お知らせを作成できませんでした');
    expect(alerts()[0]).not.toContain('Bad Request');
  });

  it('400 以外の失敗 (500) は、API の生のエラー文を出さず、汎用の日本語のメッセージを出す', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([])),
      create: () => jsonResponse(500, { error: 'Internal server error' }),
    });
    await renderPage();
    await fillForm('題名', '本文');
    await click(findButton('作成する'), '作成ボタン');

    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('お知らせを作成できませんでした');
    expect(alerts()[0]).not.toContain('Internal server error');
    expect(titleInput().value).toBe('題名'); // 入力は残る
    expect(callsOf('GET')).toHaveLength(1);
  });

  it('権限が無い (403) ときは「権限がありません」を出す', async () => {
    mockApi({
      list: () => jsonResponse(200, listBody([])),
      create: () => jsonResponse(403, { error: 'Forbidden' }),
    });
    await renderPage();
    await fillForm('題名', '本文');
    await click(findButton('作成する'), '作成ボタン');
    expect(alerts()).toEqual(['権限がありません。']);
  });

  it('通信エラー (fetch が失敗) でも汎用のメッセージを出し、入力を残す', async () => {
    fetchMock.mockImplementation(async (_input: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new TypeError('Failed to fetch');
      return jsonResponse(200, listBody([]));
    });
    await renderPage();
    await fillForm('題名', '本文');
    await click(findButton('作成する'), '作成ボタン');

    expect(alerts()[0]).toContain('お知らせを作成できませんでした');
    expect(titleInput().value).toBe('題名');
    expect(findButton('作成する')?.disabled).toBe(false);
  });

  it('空白だけのタイトル・本文は送らず、日本語のメッセージを出す', async () => {
    mockApi({ list: () => jsonResponse(200, listBody([])) });
    await renderPage();

    await fillForm('   ', 'x');
    await click(findButton('作成する'), '作成ボタン');
    await fillForm('x', '\n  \n');
    await click(findButton('作成する'), '作成ボタン');

    expect(callsOf('POST')).toHaveLength(0);
    expect(alerts()).toEqual(['タイトルと本文を入力してください。']);
  });

  it('作成できたあとに一覧の取り直しに失敗したら、作成できたことと、一覧のエラーの両方を出す', async () => {
    let calls = 0;
    mockApi({
      list: () => (++calls === 1 ? jsonResponse(200, listBody([announcement(1)])) : jsonResponse(500, { error: 'Internal server error' })),
      create: () => jsonResponse(200, { announcement: announcement(2) }),
    });
    await renderPage();
    await fillForm('題名', '本文');
    await click(findButton('作成する'), '作成ボタン');

    expect(statuses()).toContain('お知らせを下書きとして保存しました。');
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('お知らせ一覧を取得できませんでした');
    expect(titleInput().value).toBe(''); // 作成はできているので、フォームは空に戻る
  });

  it('次の作成を始めると、前の結果の表示 (通知・エラー) は消える', async () => {
    let calls = 0;
    mockApi({
      list: () => jsonResponse(200, listBody([])),
      create: () => (++calls === 1 ? jsonResponse(200, { announcement: announcement(1) }) : jsonResponse(400, { error: 'title and content are required' })),
    });
    await renderPage();
    await fillForm('題名', '本文');
    await click(findButton('作成する'), '作成ボタン');
    expect(statuses()).toContain('お知らせを下書きとして保存しました。');

    await fillForm('題名2', '本文2');
    await click(findButton('作成する'), '作成ボタン');
    expect(statuses()).toEqual([]); // 前の「保存しました」は消える
    expect(alerts()).toEqual(['title and content are required']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 古い応答
// ─────────────────────────────────────────────────────────────────────────────

describe('古い応答', () => {
  it('はじめの一覧が遅れて届いても、作成後に取り直した新しい一覧を上書きしない', async () => {
    const slowFirstList = deferred<Response>();
    let listCalls = 0;
    mockApi({
      list: () =>
        ++listCalls === 1
          ? slowFirstList.promise // はじめの一覧: 遅い (作成前の状態)
          : jsonResponse(200, listBody([announcement(2, { title: '作成したお知らせ' })])),
      create: () => jsonResponse(200, { announcement: announcement(2) }),
    });
    await renderPage();
    expect(statuses()).toContain('読み込み中...');

    // はじめの一覧がまだ届かないうちに作成する → 取り直した一覧が先に届く
    await fillForm('作成したお知らせ', '本文');
    await click(findButton('作成する'), '作成ボタン');
    expect(rows().map((cells) => cells[0])).toEqual(['作成したお知らせ']);

    // そのあとで、古い一覧 (作成前) が届いても上書きしない
    await act(async () => {
      slowFirstList.resolve(jsonResponse(200, listBody([announcement(1, { title: '古い一覧のお知らせ' })])));
    });
    await settle();
    expect(rows().map((cells) => cells[0])).toEqual(['作成したお知らせ']);
    expect(text()).not.toContain('古い一覧のお知らせ');
    expect(statuses()).not.toContain('読み込み中...');
  });

  it('失敗した古い応答で、新しい一覧にエラーを出さない', async () => {
    const slowFirstList = deferred<Response>();
    let listCalls = 0;
    mockApi({
      list: () => (++listCalls === 1 ? slowFirstList.promise : jsonResponse(200, listBody([announcement(2)]))),
      create: () => jsonResponse(200, { announcement: announcement(2) }),
    });
    await renderPage();
    await fillForm('題名', '本文');
    await click(findButton('作成する'), '作成ボタン');
    expect(rows()).toHaveLength(1);

    await act(async () => {
      slowFirstList.resolve(jsonResponse(500, { error: 'Internal server error' }));
    });
    await settle();
    expect(alerts()).toEqual([]);
    expect(rows()).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// アクセシビリティ
// ─────────────────────────────────────────────────────────────────────────────

describe('アクセシビリティ', () => {
  beforeEach(async () => {
    mockApi({ list: () => jsonResponse(200, listBody([announcement(1)])) });
    await renderPage();
  });

  it('すべての入力欄はラベルと結びついている', () => {
    const fields = Array.from(container.querySelectorAll('input, textarea, select'));
    expect(fields.length).toBeGreaterThanOrEqual(3);
    for (const field of fields) {
      expect(field.id, '入力欄に id が無い').toBeTruthy();
      const label = container.querySelector(`label[for="${field.id}"]`);
      expect(label, `#${field.id} のラベルが無い`).not.toBeNull();
      expect(label!.textContent?.trim(), `#${field.id} のラベルが空`).toBeTruthy();
    }
  });

  it('すべてのボタンに type がある', async () => {
    // 失敗の表示にある「再読み込み」ボタンも対象にする
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    mockApi({ list: () => jsonResponse(500, { error: 'Internal server error' }) });
    await renderPage();

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent)).toEqual(expect.arrayContaining(['作成する', '再読み込み']));
    for (const button of buttons) {
      expect(button.getAttribute('type'), `「${button.textContent}」に type が無い`).toMatch(/^(button|submit)$/);
    }
  });

  it('見出しは h1「お知らせ管理」の下に、作成と一覧の h2 がある。一覧の表には読み上げ用の見出しがある', () => {
    expect(container.querySelector('h1')?.textContent).toBe('お知らせ管理');
    expect(Array.from(container.querySelectorAll('h2')).map((h) => h.textContent)).toEqual(['お知らせを作成', 'お知らせ一覧']);
    expect(container.querySelector('table caption')?.textContent).toContain('お知らせの一覧');
    for (const th of Array.from(container.querySelectorAll('thead th'))) {
      expect(th.getAttribute('scope')).toBe('col');
    }
  });

  it('公開するの説明が、チェックボックスに結びついている (公開すると利用者に表示され、あとから直せないこと)', () => {
    const describedBy = publicCheckbox().getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const help = container.querySelector(`#${describedBy}`);
    expect(help?.textContent).toContain('利用者のホーム画面に表示されます');
    expect(help?.textContent).toContain('編集・削除はできません');
  });
});
