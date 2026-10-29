/**
 * #2086 V7 (triage-1029c) のテスト
 *
 * 運営の審査の一覧 (/admin/moderation) は、一覧の API の失敗 (!res.ok)・通信の失敗 (adminFetch の例外) を console.error で捨てて
 * 0 件のまま描き、「審査待ちのアイテムはありません」「未審査 件数: 0」と出していた。運営は審査待ちの通報が 0 件だと思い、
 * 有害なコンテンツの審査が放置されうる。審査の詳細 (/admin/moderation/{type}/{id}) は 404 以外の失敗 (500 など) も notFound() にして、
 * 消えた (無い) と誤解させていた。
 *
 * 直したあと:
 *  - 一覧: 読み込みの失敗 (!res.ok・例外・data が配列でない壊れた応答) は 0 件と分けて「審査の一覧を読み込めませんでした」と
 *    「再読み込み」のボタン (router.refresh()) を出し、件数の見出し・0 件の文・表は出さない。読めた 0 件は従来どおり 0 件の文
 *  - 詳細: 404 だけ notFound()。それ以外の失敗 (500 / 503 / 403・例外・壊れた応答) は「審査のアイテムを読み込めませんでした」と
 *    「再読み込み」を出す (無い (404) の画面にしない)
 *
 * 一覧・詳細 (async の Server Component) は renderToStaticMarkup で描く (tests/admin-moderation-status-labels-2080.test.tsx と同じ形)。
 * 「再読み込み」のボタン (クライアントの部品) は react-dom/client + act で押して router.refresh() を確かめる。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireRoleForPage = vi.hoisted(() => vi.fn());
const adminFetch = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useRouter: () => router,
}));
vi.mock('@/lib/auth/page-guard', () => ({ requireRoleForPage }));
vi.mock('@/lib/admin/fetch', () => ({ adminFetch }));

const { default: AdminModerationPage } = await import('@/app/admin/moderation/page');
const { default: AdminModerationDetailPage } = await import('@/app/admin/moderation/[type]/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FLAG_ID = '00000000-0000-4000-8000-000000000001';
const adminActor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['admin'], email: 'admin@example.com' };

/** 画面に出す文 (画面と同じもの) */
const LIST_LOAD_FAILED_TEXT = '審査の一覧を読み込めませんでした';
const DETAIL_LOAD_FAILED_TEXT = '審査のアイテムを読み込めませんでした';
const RELOAD_LABEL = '再読み込み';
const EMPTY_PENDING_TEXT = '審査待ちのアイテムはありません';
const EMPTY_OTHER_TEXT = 'アイテムが見つかりません';

const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;

function jsonResponse(body: unknown, status = HTTP_OK) {
  return { ok: status >= HTTP_OK && status < 300, status, json: () => Promise.resolve(body) };
}

/** 本文が JSON でない応答 (プロキシの HTML の 502 など。json() が SyntaxError で reject する) */
function nonJsonResponse(status: number) {
  return { ok: status >= HTTP_OK && status < 300, status, json: () => Promise.reject(new SyntaxError('Unexpected token <')) };
}

function detailItem(overrides: Record<string, unknown> = {}) {
  return {
    id: FLAG_ID,
    type: 'food',
    content_id: '00000000-0000-4000-8000-0000000000aa',
    content_url: null,
    reporter_count: 1,
    user_id: '00000000-0000-4000-8000-0000000000bb',
    status: 'pending',
    created_at: '2026-10-01T00:00:00Z',
    resolution_note: null,
    hidden_at: null,
    ...overrides,
  };
}

async function renderList(searchParams: Record<string, string> = {}): Promise<HTMLDivElement> {
  const markup = renderToStaticMarkup(await AdminModerationPage({ searchParams: Promise.resolve(searchParams) }));
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host;
}

async function renderDetail(type = 'food'): Promise<HTMLDivElement> {
  const markup = renderToStaticMarkup(await AdminModerationDetailPage({ params: Promise.resolve({ type, id: FLAG_ID }) }));
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host;
}

function reloadButtonOf(host: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === RELOAD_LABEL) ?? null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleForPage.mockResolvedValue(adminActor);
});

/** 一覧の読み込みの失敗の作り方 (API の失敗・通信の失敗・壊れた応答) */
const LIST_FAILURES: Array<[string, () => void]> = [
  ['API が 500 を返す', () => adminFetch.mockResolvedValue(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: '内部エラー' } }, HTTP_INTERNAL_ERROR))],
  ['API が 403 を返す', () => adminFetch.mockResolvedValue(jsonResponse({ error: { code: 'FORBIDDEN', message: '権限がありません' } }, HTTP_FORBIDDEN))],
  ['本文が JSON でない 502', () => adminFetch.mockResolvedValue(nonJsonResponse(HTTP_BAD_GATEWAY))],
  ['通信の失敗 (adminFetch の例外)', () => adminFetch.mockRejectedValue(new TypeError('fetch failed'))],
  ['200 だが本文が JSON でない', () => adminFetch.mockResolvedValue(nonJsonResponse(HTTP_OK))],
  ['200 だが data が配列でない', () => adminFetch.mockResolvedValue(jsonResponse({ data: null, meta: { total: 0 } }))],
];

describe('#2086 V7 審査の一覧: 読み込みの失敗を 0 件と分ける', () => {
  it.each(LIST_FAILURES)('%s ときは「読み込めませんでした」と「再読み込み」を出し、0 件の文・件数 0 を出さない', async (_label, arrange) => {
    arrange();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const page = await renderList();
    const text = page.textContent ?? '';

    expect(page.querySelector('[role="alert"]')?.textContent ?? '').toContain(LIST_LOAD_FAILED_TEXT);
    expect(reloadButtonOf(page)).not.toBeNull();
    expect(text).not.toContain(EMPTY_PENDING_TEXT);
    expect(text).not.toContain(EMPTY_OTHER_TEXT);
    expect(text).not.toContain('件数: 0');
    // 表 (0 件の行を含む) を描かない
    expect(page.querySelector('table')).toBeNull();
    // 絞り込みのフォームは残す (別の条件で読み直せる)
    expect(page.querySelector('form select[name="status"]')).not.toBeNull();
  });

  it('絞り込みの状態が pending 以外でも、失敗は「アイテムが見つかりません」にしない', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: '内部エラー' } }, HTTP_INTERNAL_ERROR));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const page = await renderList({ status: 'rejected' });

    expect(page.textContent ?? '').toContain(LIST_LOAD_FAILED_TEXT);
    expect(page.textContent ?? '').not.toContain(EMPTY_OTHER_TEXT);
  });

  it('読めた 0 件は従来どおり 0 件の文と件数を出し、読み込みの失敗の文は出さない', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ data: [], meta: { total: 0, page: 1, per_page: 30 } }));

    const page = await renderList();
    const text = page.textContent ?? '';

    expect(text).toContain(EMPTY_PENDING_TEXT);
    expect(text).toContain('件数: 0');
    expect(text).not.toContain(LIST_LOAD_FAILED_TEXT);
    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(reloadButtonOf(page)).toBeNull();
  });

  it('読めた行は表に出し、読み込みの失敗の文は出さない', async () => {
    adminFetch.mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: FLAG_ID,
            type: 'food',
            content_url: null,
            reporter_count: 2,
            user_id: 'user-1',
            status: 'pending',
            created_at: '2026-10-01T00:00:00Z',
            hidden_at: null,
          },
        ],
        meta: { total: 1, page: 1, per_page: 30 },
      }),
    );

    const page = await renderList();

    expect(page.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(page.textContent ?? '').toContain('件数: 1');
    expect(page.textContent ?? '').not.toContain(LIST_LOAD_FAILED_TEXT);
  });
});

describe('#2086 V7 審査の詳細: 404 だけを「無い」にし、それ以外の失敗は読み込みの失敗として出す', () => {
  it('404 は notFound()', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ error: { code: 'NOT_FOUND', message: '見つかりません' } }, HTTP_NOT_FOUND));

    await expect(renderDetail()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  /** 詳細の読み込みの失敗の作り方 */
  const DETAIL_FAILURES: Array<[string, () => void]> = [
    ['500', () => adminFetch.mockResolvedValue(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: '内部エラー' } }, HTTP_INTERNAL_ERROR))],
    ['503', () => adminFetch.mockResolvedValue(jsonResponse({ error: { code: 'SERVICE_UNAVAILABLE', message: '混雑' } }, HTTP_SERVICE_UNAVAILABLE))],
    ['403', () => adminFetch.mockResolvedValue(jsonResponse({ error: { code: 'FORBIDDEN', message: '権限がありません' } }, HTTP_FORBIDDEN))],
    ['本文が JSON でない 502', () => adminFetch.mockResolvedValue(nonJsonResponse(HTTP_BAD_GATEWAY))],
    ['通信の失敗 (adminFetch の例外)', () => adminFetch.mockRejectedValue(new TypeError('fetch failed'))],
    ['200 だが本文が JSON でない', () => adminFetch.mockResolvedValue(nonJsonResponse(HTTP_OK))],
    ['200 だが data が無い', () => adminFetch.mockResolvedValue(jsonResponse({}))],
  ];

  it.each(DETAIL_FAILURES)('%s は notFound() にせず「読み込めませんでした」と「再読み込み」を出す', async (_label, arrange) => {
    arrange();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const page = await renderDetail();

    expect(page.querySelector('[role="alert"]')?.textContent ?? '').toContain(DETAIL_LOAD_FAILED_TEXT);
    expect(reloadButtonOf(page)).not.toBeNull();
    // 審査の欄・コンテンツの情報は描かない (読めていない値で審査させない)
    expect(page.textContent ?? '').not.toContain('コンテンツ情報');
    // 一覧へ戻る道は残す
    expect(page.querySelector('a[href="/admin/moderation"]')).not.toBeNull();
  });

  it('読めたアイテムは従来どおり描き、読み込みの失敗の文は出さない', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ data: detailItem() }));

    const page = await renderDetail();

    expect(page.textContent ?? '').toContain('コンテンツ情報');
    expect(page.textContent ?? '').not.toContain(DETAIL_LOAD_FAILED_TEXT);
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('#2086 V7 「再読み込み」のボタン', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('押すとサーバーのデータを取り直す (router.refresh())', async () => {
    const { default: ModerationLoadFailure } = await import('@/components/operator/moderation/ModerationLoadFailure');
    await act(async () => {
      root.render(<ModerationLoadFailure message={LIST_LOAD_FAILED_TEXT} />);
    });

    expect(container.querySelector('[role="alert"]')?.textContent ?? '').toContain(LIST_LOAD_FAILED_TEXT);
    const button = reloadButtonOf(container);
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});
