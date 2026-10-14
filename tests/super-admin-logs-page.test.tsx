/**
 * #1157 (T23) 運用ログ画面 (/super-admin/logs) の表示テスト
 *
 * 画面は GET /api/super-admin/logs を呼んで、ログを新しい順に表示する (読み取り専用)。確かめること:
 *   - 初回表示: 条件なしで 50 件ずつ取り、日本時間で表示する
 *   - 絞り込み: 「絞り込む」を押したときだけ検索する。日本時間で入力した期間を UTC の ISO 8601 にして渡す。
 *     誤った入力 (UUID でないユーザー ID、開始が終了より後) は API に送らない
 *   - ページ送り: 「さらに読み込む」が API の返したカーソルと、検索に使った条件 (入力途中の条件ではない) を渡す
 *   - 詳細: メッセージ全文・エラー・スタック・付随情報を開ける。その行の値で絞り込める
 *   - 安全: ログに入っている HTML は文字として表示する (実行しない)
 *   - 失敗: API のエラー・通信の失敗を表示する。遅れて返ってきた古い応答で、新しい検索結果を上書きしない
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_LOG_LEVELS } from '@/lib/super-admin/app-logs';

const { default: AppLogsPage } = await import('@/app/super-admin/logs/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER_A = '00000000-0000-4000-8000-0000000000b1';

interface Entry {
  id: string;
  created_at: string;
  level: string;
  source: string;
  function_name: string | null;
  user_id: string | null;
  request_id: string | null;
  message: string;
  error_message: string | null;
  error_stack: string | null;
  metadata: unknown;
}

/** i 秒目 (UTC 05:00:ii = 日本時間 14:00:ii) のログ */
function entry(i: number, overrides: Partial<Entry> = {}): Entry {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    created_at: `2026-10-08T05:00:${String(i).padStart(2, '0')}.123456+00:00`,
    level: 'info',
    source: 'api-route',
    function_name: 'GET /api/example',
    user_id: null,
    request_id: null,
    message: `message ${i}`,
    error_message: null,
    error_stack: null,
    metadata: {},
    ...overrides,
  };
}

function page(rows: Entry[], nextCursor: string | null = null) {
  return { data: rows, meta: { limit: 50, has_more: nextCursor !== null, next_cursor: nextCursor } };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

const text = () => container.textContent ?? '';
const paramsOf = (url: unknown) => new URL(String(url), 'http://localhost').searchParams;
/** これまでに API へ出したリクエストの、クエリパラメータ */
const requests = () => fetchMock.mock.calls.map((call) => paramsOf(call[0]));
const lastRequest = () => requests().at(-1)!;

async function renderPage() {
  await act(async () => {
    root.render(<AppLogsPage />);
  });
}

/** テキストが完全に一致するボタン */
function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
  expect(found, `ボタン「${label}」が見つからない`).toBeDefined();
  return found as HTMLButtonElement;
}

async function click(target: HTMLButtonElement) {
  await act(async () => {
    target.click();
  });
}

async function type(id: string, value: string) {
  const input = container.querySelector(`#${id}`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(id: string, value: string) {
  const select = container.querySelector(`#${id}`) as HTMLSelectElement;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const valueOf = (id: string) => (container.querySelector(`#${id}`) as HTMLInputElement | HTMLSelectElement).value;

beforeEach(async () => {
  fetchMock = vi.fn(async () => jsonResponse(page([entry(2), entry(1)])));
  vi.stubGlobal('fetch', fetchMock);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await renderPage();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('運用ログ画面: 初回表示', () => {
  it('条件なしで 50 件ずつ取り、新しい順の行を表示する', async () => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/super-admin/logs?limit=50');
    expect(Array.from(lastRequest().keys())).toEqual(['limit']);

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('message 2');
    expect(rows[1].textContent).toContain('message 1');
    expect(text()).toContain('2 件を表示中');
  });

  it('日時は日本時間で (UTC 05:00:07 は 14:00:07)、ミリ秒まで表示する', async () => {
    expect(text()).toContain('2026/10/08 14:00:02.123');
    expect(text()).toContain('2026/10/08 14:00:01.123');
  });

  it('レベル・発生元・関数名を表示する。関数名が無い行は「—」', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(page([entry(2, { level: 'error', source: 'edge-function', function_name: null }), entry(1)])),
    );
    await click(button('再読み込み'));

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows[0].textContent).toContain('error');
    expect(rows[0].textContent).toContain('edge-function');
    expect(rows[0].textContent).toContain('—');
    expect(rows[1].textContent).toContain('info');
    expect(rows[1].textContent).toContain('GET /api/example');
  });

  it('続きが無ければ「さらに読み込む」を出さず、終わりを示す', async () => {
    expect(container.textContent).not.toContain('さらに読み込む');
    expect(text()).toContain('これ以上ログはありません');
  });

  it('1 件も無ければ、その旨を表示する', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(page([])));
    await click(button('再読み込み'));

    expect(text()).toContain('条件に合うログはありません');
    expect(text()).toContain('0 件を表示中');
    expect(text()).not.toContain('これ以上ログはありません');
  });

  it('読み取り専用: ログを変更するボタン (削除など) は無い', async () => {
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(labels.filter((l) => /削除|消去|編集|保存/.test(l ?? ''))).toEqual([]);
  });
});

describe('運用ログ画面: 絞り込み', () => {
  it('入力しただけでは検索しない。「絞り込む」を押したときに、入力した条件で検索する', async () => {
    await choose('log-level', 'error');
    await choose('log-source', 'edge-function');
    await type('log-function-name', '  generate-menu-v4  ');
    await type('log-user-id', ` ${USER_A} `);
    await type('log-request-id', 'req_1728360000000_ab12cd3');
    expect(fetchMock).toHaveBeenCalledTimes(1); // 初回表示の 1 回だけ

    await click(button('絞り込む'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const params = lastRequest();
    expect(params.get('level')).toBe('error');
    expect(params.get('source')).toBe('edge-function');
    expect(params.get('function_name')).toBe('generate-menu-v4'); // 前後の空白は取り除く
    expect(params.get('user_id')).toBe(USER_A);
    expect(params.get('request_id')).toBe('req_1728360000000_ab12cd3');
    expect(params.get('limit')).toBe('50');
    expect(params.has('cursor')).toBe(false);
    expect(params.has('from')).toBe(false);
    expect(params.has('to')).toBe(false);
  });

  it('期間は日本時間で入力し、UTC の ISO 8601 にして渡す。終了はその分の終わりまで含める', async () => {
    await type('log-from', '2026-10-08T14:00');
    await type('log-to', '2026-10-08T15:30');
    await click(button('絞り込む'));

    const params = lastRequest();
    expect(params.get('from')).toBe('2026-10-08T05:00:00.000Z'); // 14:00 JST
    expect(params.get('to')).toBe('2026-10-08T06:30:59.999Z'); // 15:30 JST の終わり (15:30:59.999)
  });

  it('日付をまたぐ入力も日本時間で扱う (日本時間 00:00 は前日の 15:00 UTC)', async () => {
    await type('log-from', '2026-10-08T00:00');
    await click(button('絞り込む'));

    expect(lastRequest().get('from')).toBe('2026-10-07T15:00:00.000Z');
  });

  it('絞り込むと、一覧を新しい結果に置き換える', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(page([entry(9, { message: 'only error' })])));
    await choose('log-level', 'error');
    await click(button('絞り込む'));

    expect(text()).toContain('only error');
    expect(text()).not.toContain('message 2');
    expect(text()).toContain('1 件を表示中');
  });

  it('ユーザー ID が UUID でなければ、API に送らずに説明を表示する', async () => {
    await type('log-user-id', 'not-a-uuid');
    await click(button('絞り込む'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text()).toContain('ユーザー ID は UUID の形式');
  });

  it('開始が終了より後なら、API に送らずに説明を表示する。直せば検索できて、説明は消える', async () => {
    await type('log-from', '2026-10-08T16:00');
    await type('log-to', '2026-10-08T15:00');
    await click(button('絞り込む'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text()).toContain('開始日時は終了日時より前にしてください');

    await type('log-from', '2026-10-08T14:00');
    await click(button('絞り込む'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain('開始日時は終了日時より前にしてください');
  });

  it('開始と終了が同じ分でも検索できる', async () => {
    await type('log-from', '2026-10-08T14:00');
    await type('log-to', '2026-10-08T14:00');
    await click(button('絞り込む'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('条件をクリアすると、入力欄を空にして条件なしで検索し直す', async () => {
    await choose('log-level', 'warn');
    await type('log-request-id', 'req_x');
    await click(button('絞り込む'));
    expect(lastRequest().get('level')).toBe('warn');

    await click(button('条件をクリア'));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(Array.from(lastRequest().keys())).toEqual(['limit']);
    expect(valueOf('log-level')).toBe('');
    expect(valueOf('log-request-id')).toBe('');
  });

  it('再読み込みは、検索に使った条件で先頭から取り直す (入力途中の条件は使わない)', async () => {
    await choose('log-level', 'error');
    await click(button('絞り込む'));
    await choose('log-level', 'debug'); // 入力しただけ (反映していない)

    await click(button('再読み込み'));

    expect(lastRequest().get('level')).toBe('error');
    expect(lastRequest().has('cursor')).toBe(false);
  });

  it('レベルの選択肢は、API が受け付けるレベルと同じ (画面だけ増減して食い違わない)', async () => {
    const options = Array.from(container.querySelectorAll('#log-level option'))
      .map((o) => (o as HTMLOptionElement).value)
      .filter((value) => value !== '');

    expect(options).toEqual([...APP_LOG_LEVELS]);
  });

  it('関数名の候補 (datalist) に、表示中の行の関数名を出す', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(page([entry(3, { function_name: 'fn-b' }), entry(2, { function_name: 'fn-a' }), entry(1, { function_name: 'fn-a' })])),
    );
    await click(button('再読み込み'));

    const options = Array.from(container.querySelectorAll('#log-function-names option')).map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['fn-b', 'fn-a']);
  });
});

describe('運用ログ画面: さらに読み込む', () => {
  it('API が返したカーソルと、検索に使った条件を渡して続きを足す。続きが無くなればボタンを消す', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(page([entry(4), entry(3)], 'CURSOR_1')))
      .mockResolvedValueOnce(jsonResponse(page([entry(2), entry(1)], null)));
    await choose('log-level', 'error');
    await click(button('絞り込む'));
    expect(text()).toContain('(続きあり)');

    await click(button('さらに読み込む'));

    const params = lastRequest();
    expect(params.get('cursor')).toBe('CURSOR_1');
    expect(params.get('level')).toBe('error');
    const rows = Array.from(container.querySelectorAll('tbody tr')).map((r) => r.textContent ?? '');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('message 4');
    expect(rows[3]).toContain('message 1');
    expect(text()).toContain('4 件を表示中');
    expect(text()).not.toContain('さらに読み込む');
    expect(text()).toContain('これ以上ログはありません');
  });

  it('入力途中で変えた条件は使わない (一覧と同じ条件で続きを取る)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(page([entry(4), entry(3)], 'CURSOR_1')));
    await choose('log-level', 'error');
    await click(button('絞り込む'));
    await choose('log-level', 'debug');
    await type('log-request-id', 'typed-but-not-applied');

    await click(button('さらに読み込む'));

    expect(lastRequest().get('level')).toBe('error');
    expect(lastRequest().has('request_id')).toBe(false);
  });

  it('続きの取得に失敗しても、すでに表示した行は消さない。ボタンはそのままで、押せば取り直せる', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(page([entry(4), entry(3)], 'CURSOR_1')))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'アプリログの取得に失敗しました' } }, 500))
      .mockResolvedValueOnce(jsonResponse(page([entry(2)], null)));
    await click(button('再読み込み'));

    await click(button('さらに読み込む'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('アプリログの取得に失敗しました');
    expect(text()).toContain('message 4');
    expect(text()).toContain('message 3');

    await click(button('さらに読み込む'));
    expect(lastRequest().get('cursor')).toBe('CURSOR_1');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain('message 2');
    expect(text()).toContain('3 件を表示中');
  });
});

describe('運用ログ画面: 詳細', () => {
  const detailed = entry(5, {
    level: 'error',
    function_name: 'GET /api/health/insights',
    user_id: USER_A,
    request_id: 'req_detail_1',
    message: 'failed to build insights\nsecond line',
    error_message: 'relation "x" does not exist',
    error_stack: 'Error: boom\n    at handler (route.js:1:1)',
    metadata: { pg_code: '42P01', nested: { items: [1, 2] } },
  });

  beforeEach(async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(page([detailed, entry(1)])));
    await click(button('再読み込み'));
  });

  it('「開く」でメッセージ全文・エラー・スタック・付随情報・ID を表示し、「閉じる」で畳む', async () => {
    const toggle = button('開く'); // 1 行目 (最初に見つかるもの)
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(text()).not.toContain('スタックトレース');

    await click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('閉じる');
    expect(text()).toContain('second line');
    expect(text()).toContain('relation "x" does not exist');
    expect(text()).toContain('at handler (route.js:1:1)');
    expect(text()).toContain('"pg_code": "42P01"');
    expect(text()).toContain(detailed.id);
    expect(text()).toContain(USER_A);
    expect(text()).toContain('req_detail_1');
    // aria-controls が指す詳細の行が実在する
    const controlled = container.querySelector(`#${toggle.getAttribute('aria-controls')}`);
    expect(controlled?.textContent).toContain('スタックトレース');

    await click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(text()).not.toContain('スタックトレース');
  });

  it('空の付随情報 ({}) とエラーの無い行では、その欄を出さない', async () => {
    await click(Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === '開く')[1]);

    expect(text()).toContain('メッセージ');
    expect(text()).not.toContain('付随情報');
    expect(text()).not.toContain('エラー内容');
    expect(text()).not.toContain('スタックトレース');
  });

  it('詳細の「この値で絞り込む」で、その行の値を今の条件に足して検索し直す', async () => {
    await choose('log-level', 'error');
    await click(button('絞り込む'));
    fetchMock.mockResolvedValueOnce(jsonResponse(page([detailed, entry(1)])));
    await click(button('再読み込み'));
    await click(button('開く'));
    fetchMock.mockResolvedValueOnce(jsonResponse(page([detailed])));

    const filterButton = container.querySelector(`button[aria-label="リクエスト ID「req_detail_1」で絞り込む"]`) as HTMLButtonElement;
    expect(filterButton).not.toBeNull();
    await click(filterButton);

    const params = lastRequest();
    expect(params.get('request_id')).toBe('req_detail_1');
    expect(params.get('level')).toBe('error'); // 今の条件は残る
    expect(valueOf('log-request-id')).toBe('req_detail_1'); // 入力欄にも反映される
    expect(text()).toContain('1 件を表示中');
  });

  it('ユーザー ID・関数名でも絞り込める。値の無い項目には絞り込みのボタンを出さない', async () => {
    await click(button('開く'));
    fetchMock.mockResolvedValueOnce(jsonResponse(page([detailed])));

    await click(container.querySelector(`button[aria-label="ユーザー ID「${USER_A}」で絞り込む"]`) as HTMLButtonElement);
    expect(lastRequest().get('user_id')).toBe(USER_A);

    await click(button('開く'));
    fetchMock.mockResolvedValueOnce(jsonResponse(page([detailed])));
    await click(container.querySelector(`button[aria-label="関数「GET /api/health/insights」で絞り込む"]`) as HTMLButtonElement);
    expect(lastRequest().get('function_name')).toBe('GET /api/health/insights');
    expect(lastRequest().get('user_id')).toBe(USER_A);

    // user_id / request_id の無い行を開く
    fetchMock.mockResolvedValueOnce(jsonResponse(page([entry(1)])));
    await click(button('再読み込み'));
    await click(button('開く'));
    expect(container.querySelectorAll('button[aria-label$="で絞り込む"]')).toHaveLength(1); // 関数だけ
  });
});

describe('運用ログ画面: 安全', () => {
  it('ログに入っている HTML は文字として表示し、要素にしない (実行されない)', async () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    fetchMock.mockResolvedValueOnce(
      jsonResponse(page([entry(1, { message: payload, error_message: payload, error_stack: payload, metadata: { html: payload } })])),
    );
    await click(button('再読み込み'));
    await click(button('開く'));

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(text()).toContain(payload);
  });

  it('ログの文面は保存されたまま表示する (伏せ字や [email] はそのまま)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(page([entry(1, { message: 'token=*** sent to [email]' })])));
    await click(button('再読み込み'));

    expect(text()).toContain('token=*** sent to [email]');
  });
});

describe('運用ログ画面: 失敗', () => {
  it('権限が無い (403) ときは、運用者に分かる説明を出す。API の英語のコードは出さない。一覧は空で、「条件に合うログはありません」とは言わない', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'FORBIDDEN', message: 'Requires one of: super_admin' } }, 403));
    await click(button('再読み込み'));

    const alert = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('権限がありません');
    expect(alert).not.toContain('Requires one of');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(text()).not.toContain('条件に合うログはありません');
  });

  it('ログインの有効期限が切れた (401) ときは、ログインし直すよう説明する', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'AUTH_UNAUTHENTICATED' } }, 401));
    await click(button('再読み込み'));

    const alert = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('ログインし直してください');
    expect(alert).not.toContain('AUTH_UNAUTHENTICATED');
  });

  it('サーバーのエラー (500) は、API が返した日本語のメッセージをそのまま表示する', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'アプリログの取得に失敗しました' } }, 500));
    await click(button('再読み込み'));

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('アプリログの取得に失敗しました');
  });

  it('時間切れ (504) の案内をそのまま表示する', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'QUERY_TIMEOUT', message: '検索に時間がかかりすぎました。期間 (開始・終了) などの条件を絞って、もう一度お試しください' } }, 504),
    );
    await click(button('再読み込み'));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('期間 (開始・終了)');
  });

  it('本文が JSON でない失敗 (HTML のエラーページなど) でも、HTTP ステータスを表示する', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError('Unexpected token <')) });
    await click(button('再読み込み'));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('HTTP 502');
  });

  it('通信そのものの失敗も表示する', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await click(button('再読み込み'));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('通信に失敗しました');
  });

  it('次の検索が成功すれば、エラーの表示は消える', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'boom' } }, 500));
    await click(button('再読み込み'));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await click(button('再読み込み'));

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain('message 2');
  });

  it('「さらに読み込む」の返事を待つ間に別の条件で検索し直したら、遅れて返ってきた古い続きを足さない', async () => {
    // 続きがある一覧を出し、行の詳細を開いておく (詳細の「この値で絞り込む」は、読み込み中でも押せる)
    fetchMock.mockResolvedValueOnce(jsonResponse(page([entry(4, { request_id: 'req_new' }), entry(3)], 'CURSOR_1')));
    await click(button('再読み込み'));
    await click(button('開く'));

    let resolveSlow!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSlow = resolve;
      }),
    );
    await click(button('さらに読み込む')); // 返事が遅い
    expect(text()).toContain('読み込み中');

    fetchMock.mockResolvedValueOnce(jsonResponse(page([entry(9, { message: 'newer search result' })])));
    await click(container.querySelector('button[aria-label="リクエスト ID「req_new」で絞り込む"]') as HTMLButtonElement);
    expect(text()).toContain('newer search result');

    await act(async () => {
      resolveSlow(jsonResponse(page([entry(2, { message: 'stale rows from the old search' })], 'CURSOR_2')));
    });

    expect(text()).toContain('newer search result');
    expect(text()).not.toContain('stale rows from the old search');
    expect(text()).toContain('1 件を表示中');
    expect(text()).not.toContain('(続きあり)'); // 古い検索のカーソルも引き継がない
  });
});

describe('運用ログ画面: 操作性', () => {
  it('読み込み中は「絞り込む」「再読み込み」を押せない (二重に検索しない)', async () => {
    let resolveSlow!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSlow = resolve;
      }),
    );
    await click(button('再読み込み'));

    expect(button('絞り込む').disabled).toBe(true);
    expect(button('再読み込み').disabled).toBe(true);
    expect(button('条件をクリア').disabled).toBe(true);

    await act(async () => {
      resolveSlow(jsonResponse(page([entry(1)])));
    });

    expect(button('絞り込む').disabled).toBe(false);
  });

  it('詳細ボタンの名前に、どの行か (日時) が入る。見える文字「開く」「閉じる」も含める', async () => {
    const toggle = button('開く');
    expect(toggle.getAttribute('aria-label')).toBe('2026/10/08 14:00:02.123 のログの詳細を開く');
    expect(toggle.getAttribute('aria-label')).toContain(toggle.textContent ?? '');

    await click(toggle);

    expect(toggle.getAttribute('aria-label')).toBe('2026/10/08 14:00:02.123 のログの詳細を閉じる');
    expect(toggle.getAttribute('aria-label')).toContain(toggle.textContent ?? '');
  });

  it('入力欄にはラベルが付いている (スクリーンリーダー向け)', async () => {
    for (const id of ['log-level', 'log-source', 'log-function-name', 'log-user-id', 'log-request-id', 'log-from', 'log-to']) {
      expect(container.querySelector(`label[for="${id}"]`), `${id} のラベル`).not.toBeNull();
    }
    expect(container.querySelector('table caption')?.textContent).toContain('アプリログの一覧');
    expect(container.querySelectorAll('th[scope="col"]').length).toBeGreaterThan(0);
  });
});
