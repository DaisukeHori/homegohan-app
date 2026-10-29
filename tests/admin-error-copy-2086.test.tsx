/**
 * #2086 V6: 運営の画面 (super-admin・admin) の失敗の文に、「HTTP 502」だけの文・ブラウザの英字の例外の文・JSON の SyntaxError を出さない
 *
 * 以前の画面は:
 *   - 本文に文の無い失敗 (プロキシの 502 など) を `HTTP ${status}` だけで出した (機能フラグ・A/B テスト・監査ログ・インフラ・LLM・CSV の書き出しなど)
 *   - fetch の reject (オフライン・接続が切れたなど) を `err.message` / `String(e)` で「Failed to fetch」「TypeError: Failed to fetch」と出した
 *   - 機能フラグの画面などは !res.ok のとき await res.json() を catch なしで読むので、本文が JSON でない (プロキシの 502 の HTML 等) と
 *     英字の SyntaxError の文が alert / エラー欄に出た
 * 直したあと (不変条件):
 *   - 画面に出すのは日本語の文だけ (src/lib/admin/admin-screen-messages.ts の AdminScreenError の文と、画面ごとの固定の文)
 *   - 本文に日本語の文が無い失敗は「<対象>を読み込めませんでした (HTTP <番号>)」「<操作>に失敗しました (HTTP <番号>)」
 *   - 通信そのものの失敗は「…（通信エラー）」
 *   - 失敗の応答の本文は .catch(() => null) で読む (JSON でない本文で SyntaxError を投げない)
 * 新しい英字の文が入らないことは tests/org-ui-no-english-copy.test.ts の運営の画面の走査 (F1〜F3) が見る。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminScreenError,
  adminActionHttpFailedMessage,
  adminActionNoResponseMessage,
  adminLoadFailedFallback,
  adminLoadFailedMessage,
  displayableAdminError,
  fetchAdminJson,
  screenApiErrorMessage,
  sendAdminRequest,
} from '@/lib/admin/admin-screen-messages';

const ROW_ID = '20862086-2086-4086-8086-208620862186';
const routerPush = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: ROW_ID }),
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: FlagsPage } = await import('@/app/super-admin/flags/page');
const { default: NewFlagPage } = await import('@/app/super-admin/flags/new/page');
const { default: ExperimentDetailPage } = await import('@/app/super-admin/experiments/[id]/page');
const { default: ExportsPage } = await import('@/app/admin/finance/exports/page');
const { default: FinanceDashboardPage } = await import('@/app/admin/finance/page');
const { default: TicketDetailPage } = await import('@/app/admin/support/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 本文が JSON でない失敗の応答 (プロキシの 502 の HTML) */
const proxyBadGateway = () => new Response('<html><body>Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
/** 通信の reject (応答が切れた・届かなかった) */
const networkFailure = () => new TypeError('Failed to fetch');
function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 画面に出てはいけない英字の文 (以前の画面が出していたもの) */
const ENGLISH_LEAKS = ['Failed to fetch', 'SyntaxError', 'TypeError', 'Unexpected token', 'Bad Gateway'];

let container: HTMLDivElement;
let root: Root;
let alertSpy: ReturnType<typeof vi.fn>;

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

const text = () => container.textContent ?? '';
const alertTexts = () => alertSpy.mock.calls.map(([message]) => String(message));

function expectNoEnglishLeak(shown: string) {
  for (const leak of ENGLISH_LEAKS) expect(shown, `「${leak}」が出ている`).not.toContain(leak);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  alertSpy = vi.fn();
  vi.stubGlobal('alert', alertSpy);
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

describe('admin-screen-messages: 画面に出す失敗の文の部品 (#2086 V6)', () => {
  it('screenApiErrorMessage は日本語を含む本文の文だけを返し、英字だけの文・読めない本文は null', () => {
    expect(screenApiErrorMessage({ error: { code: 'X', message: 'プランが見つかりません' } })).toBe('プランが見つかりません');
    expect(screenApiErrorMessage({ error: 'タイトルを入力してください' })).toBe('タイトルを入力してください');
    expect(screenApiErrorMessage({ error: { message: 'Bad Gateway' } })).toBeNull();
    expect(screenApiErrorMessage(null)).toBeNull();
  });

  it('displayableAdminError は AdminScreenError の文だけを出し、ほかの例外 (英字の文) は固定の文にする', () => {
    expect(displayableAdminError(new AdminScreenError('読み込めませんでした'), '固定の文')).toBe('読み込めませんでした');
    expect(displayableAdminError(networkFailure(), '固定の文')).toBe('固定の文');
    expect(displayableAdminError(new SyntaxError('Unexpected token <'), '固定の文')).toBe('固定の文');
  });

  it('文の形: 読み込みは「<対象>を読み込めませんでした (HTTP n)」・通信は「（通信エラー）」、書き込みは「<操作>に失敗しました (HTTP n)」・「<操作>の応答を受け取れませんでした（通信エラー）」', () => {
    expect(adminLoadFailedMessage('機能フラグ', 502)).toBe('機能フラグを読み込めませんでした (HTTP 502)');
    expect(adminLoadFailedMessage('機能フラグ', null)).toBe('機能フラグを読み込めませんでした（通信エラー）');
    expect(adminLoadFailedFallback('機能フラグ')).toBe('機能フラグを読み込めませんでした');
    expect(adminActionHttpFailedMessage('保存', 502)).toBe('保存に失敗しました (HTTP 502)');
    expect(adminActionNoResponseMessage('保存')).toBe('保存の応答を受け取れませんでした（通信エラー）');
  });

  it('fetchAdminJson: 失敗の応答 (JSON でない本文)・通信の reject・200 の読めない本文を、日本語の文の AdminScreenError にする', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => proxyBadGateway()));
    await expect(fetchAdminJson('/api/x', '一覧')).rejects.toEqual(new AdminScreenError('一覧を読み込めませんでした (HTTP 502)'));

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: { message: '一覧の取得に失敗しました' } })));
    await expect(fetchAdminJson('/api/x', '一覧')).rejects.toEqual(new AdminScreenError('一覧の取得に失敗しました'));

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: { message: 'internal error' } })));
    await expect(fetchAdminJson('/api/x', '一覧')).rejects.toEqual(new AdminScreenError('一覧を読み込めませんでした (HTTP 500)'));

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw networkFailure();
    }));
    await expect(fetchAdminJson('/api/x', '一覧')).rejects.toEqual(new AdminScreenError('一覧を読み込めませんでした（通信エラー）'));

    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>ok</html>', { status: 200 })));
    await expect(fetchAdminJson('/api/x', '一覧')).rejects.toEqual(new AdminScreenError('一覧を読み込めませんでした（通信エラー）'));

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: [1] })));
    await expect(fetchAdminJson('/api/x', '一覧')).resolves.toEqual({ data: [1] });
  });

  it('sendAdminRequest: 失敗の応答は「<操作>に失敗しました (HTTP n)」、通信の reject は「<操作>の応答を受け取れませんでした（通信エラー）」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => proxyBadGateway()));
    await expect(sendAdminRequest('/api/x', { method: 'POST' }, '作成')).rejects.toEqual(
      new AdminScreenError('作成に失敗しました (HTTP 502)'),
    );

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw networkFailure();
    }));
    await expect(sendAdminRequest('/api/x', { method: 'POST' }, '作成')).rejects.toEqual(
      new AdminScreenError('作成の応答を受け取れませんでした（通信エラー）'),
    );

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 204 })));
    await expect(sendAdminRequest('/api/x', { method: 'DELETE' }, '削除')).resolves.toBeNull();
  });
});

describe('機能フラグの一覧: 失敗の文を日本語にする (#2086 V6)', () => {
  const FLAG = {
    key: 'flag_2086',
    description: '説明',
    enabled: false,
    rollout_strategy: null,
    constraints: null,
    active_user_count: 0,
    updated_at: '2026-10-29T00:00:00.000Z',
  };

  it('一覧の読み込みが本文の無い 502 (HTML) なら「機能フラグを読み込めませんでした (HTTP 502)」を出す (SyntaxError・「HTTP 502」だけの文を出さない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => proxyBadGateway()));
    await renderElement(createElement(FlagsPage));

    expect(text()).toContain('機能フラグを読み込めませんでした (HTTP 502)');
    expectNoEnglishLeak(text());
  });

  it('一覧の読み込みの通信が reject されたら「機能フラグを読み込めませんでした（通信エラー）」を出す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw networkFailure();
    }));
    await renderElement(createElement(FlagsPage));

    expect(text()).toContain('機能フラグを読み込めませんでした（通信エラー）');
    expectNoEnglishLeak(text());
  });

  it('切り替えが本文の無い 502 (HTML) で断られたら、alert に「「<key>」の切り替えに失敗しました (HTTP 502)」を出す。削除も同じ', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      return method === 'GET' ? jsonResponse(200, { data: [FLAG] }) : proxyBadGateway();
    }));
    await renderElement(createElement(FlagsPage));

    // 切り替えのボタンは文字の無いスイッチ (行の中の、文字の無いボタン)
    const toggleButton = Array.from(container.querySelectorAll<HTMLButtonElement>('tbody button')).find(
      (b) => (b.textContent ?? '').trim() === '',
    );
    await click(toggleButton, '切り替えのボタン');
    await click(findButton('削除'), '「削除」ボタン');

    expect(alertTexts()).toEqual([
      '「flag_2086」の切り替えに失敗しました (HTTP 502)',
      '「flag_2086」の削除に失敗しました (HTTP 502)',
    ]);
  });
});

describe('機能フラグの作成: 失敗の文を日本語にする (#2086 V6)', () => {
  async function submitNewFlag() {
    await renderElement(createElement(NewFlagPage));
    const keyInput = container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(keyInput).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(keyInput, 'flag_new_2086');
      keyInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = container.querySelector('form');
    await act(async () => {
      form!.requestSubmit();
    });
    await settle();
  }

  it('作成の通信が reject されたら「機能フラグの作成の応答を受け取れませんでした（通信エラー）」を出す (Failed to fetch を出さない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw networkFailure();
    }));
    await submitNewFlag();

    expect(alertTexts()).toEqual(['機能フラグの作成の応答を受け取れませんでした（通信エラー）']);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('作成が本文の無い 502 (HTML) で断られたら「機能フラグの作成に失敗しました (HTTP 502)」を出す。本文の日本語の文があればそれを出す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => proxyBadGateway()));
    await submitNewFlag();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, { error: { code: 'CONFLICT', message: '同じキーのフラグがあります' } })));
    await act(async () => {
      container.querySelector('form')!.requestSubmit();
    });
    await settle();

    expect(alertTexts()).toEqual(['機能フラグの作成に失敗しました (HTTP 502)', '同じキーのフラグがあります']);
  });
});

describe('A/B テストの詳細: 初めの読み込みの失敗の文を日本語にする (#2086 V6)', () => {
  it('本文の無い 502 (HTML) なら「実験を読み込めませんでした (HTTP 502)」、通信の reject なら「（通信エラー）」を出す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => proxyBadGateway()));
    await renderElement(createElement(ExperimentDetailPage, { params: Promise.resolve({ id: ROW_ID }) }));
    expect(text()).toContain('実験を読み込めませんでした (HTTP 502)');
    expectNoEnglishLeak(text());

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw networkFailure();
    }));
    await renderElement(createElement(ExperimentDetailPage, { params: Promise.resolve({ id: ROW_ID }) }));
    expect(text()).toContain('実験を読み込めませんでした（通信エラー）');
    expectNoEnglishLeak(text());
  });
});

describe('売上・経理の画面: 失敗の文を日本語にする (#2086 V6)', () => {
  it('CSV の書き出しが本文の無い 502 (HTML) なら「CSV のエクスポートに失敗しました (HTTP 502)」を出す (「Error: HTTP 502」を出さない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => proxyBadGateway()));
    await renderElement(createElement(ExportsPage));

    const exportButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('CSV ダウンロード'));
    await click(exportButton, '「CSV ダウンロード」ボタン');

    expect(text()).toContain('CSV のエクスポートに失敗しました (HTTP 502)');
    expect(text()).not.toContain('Error:');
    expectNoEnglishLeak(text());
  });

  it('CSV の書き出しの通信が reject されたら「CSV のエクスポートの応答を受け取れませんでした（通信エラー）」を出す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw networkFailure();
    }));
    await renderElement(createElement(ExportsPage));

    const exportButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('CSV ダウンロード'));
    await click(exportButton, '「CSV ダウンロード」ボタン');

    expect(text()).toContain('CSV のエクスポートの応答を受け取れませんでした（通信エラー）');
    expectNoEnglishLeak(text());
  });

  it('ダッシュボードの読み込みが本文の無い 502 (HTML) なら「売上・経理のダッシュボードを読み込めませんでした (HTTP 502)」を出す (SyntaxError を出さない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => proxyBadGateway()));
    await renderElement(createElement(FinanceDashboardPage));

    expect(text()).toContain('売上・経理のダッシュボードを読み込めませんでした (HTTP 502)');
    expectNoEnglishLeak(text());
  });
});

describe('問い合わせの詳細: 書き込みの通信の失敗の文を日本語にする (#2086 V6)', () => {
  const TICKET = {
    id: ROW_ID,
    user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    subject: '通信の切れる問い合わせ',
    category: 'other',
    priority: 'medium',
    status: 'open',
    assignee_id: null,
    first_response_at: null,
    resolved_at: null,
    created_at: '2026-10-29T00:00:00.000Z',
    updated_at: '2026-10-29T00:00:00.000Z',
    messages: [],
  };

  it('ステータスの変更の通信が reject されたら「ステータスの変更の応答を受け取れませんでした（通信エラー）」を出す (Failed to fetch を出さない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') return jsonResponse(200, { data: TICKET });
      throw networkFailure();
    }));
    await renderElement(createElement(TicketDetailPage, { params: Promise.resolve({ id: ROW_ID }) }));

    await click(findButton('対応中'), '「対応中」ボタン');

    expect(text()).toContain('ステータスの変更の応答を受け取れませんでした（通信エラー）');
    expectNoEnglishLeak(text());
  });
});
