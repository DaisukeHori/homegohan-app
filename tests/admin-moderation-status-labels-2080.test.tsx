/**
 * #2080 U6 (10/29 の整合ゲート 1029a・1029b の候補・triage-1029b) のテスト
 *
 * 運営の審査の画面 (/admin/moderation/{type}/{id}) の審査の欄が、審査済みのアイテムの状態を「ステータス: rejected」と
 * 内部の英字の値のまま出していた。同じ型で、審査の一覧 (/admin/moderation) のステータスの列・件数の見出し、詳細の「ステータス」の項目、
 * 審査を確定したあとの結果の文 (表に無い値はそのまま出していた) と、タイプの札 (food / recipe) も内部の値のまま出していた。
 * 直したあとは、状態・タイプを日本語の表示名にする対応表 (src/lib/admin/moderation-labels.ts) に通し、表に無い値は固定の文にする。
 *
 * 審査の欄 (クライアントの部品) は react-dom/client + act で、一覧・詳細 (async の Server Component) は renderToStaticMarkup で描く
 * (tests/admin-moderation-review-form.test.tsx・tests/admin-moderation-hidden-pages.test.tsx と同じ形)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireRoleForPage = vi.hoisted(() => vi.fn());
const adminFetch = vi.hoisted(() => vi.fn());

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/lib/auth/page-guard', () => ({ requireRoleForPage }));
vi.mock('@/lib/admin/fetch', () => ({ adminFetch }));

const { default: ModerationReviewForm } = await import('@/components/operator/moderation/ModerationReviewForm');
const { default: AdminModerationPage } = await import('@/app/admin/moderation/page');
const { default: AdminModerationDetailPage } = await import('@/app/admin/moderation/[type]/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FLAG_ID = '00000000-0000-4000-8000-000000000001';
const adminActor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['admin'], email: 'admin@example.com' };

/** 画面に出す日本語 (画面と同じもの) */
const EXPECTED_STATUS_LABELS: Record<string, string> = {
  pending: '未審査',
  approved: '承認済み',
  rejected: '却下済み',
  escalated: 'エスカレーション',
};
const UNKNOWN_STATUS_LABEL = '不明な状態';
const EXPECTED_TYPE_LABELS: Record<string, string> = { food: '食事画像', recipe: 'レシピ' };
const UNKNOWN_TYPE_LABEL = '不明な種類';

const ENGLISH_STATUS_VALUES = ['pending', 'approved', 'rejected', 'escalated', 'archived'];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function queueItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'food',
    content_url: null,
    reporter_count: 1,
    user_id: 'user-1',
    status: 'rejected',
    created_at: '2026-10-01T00:00:00Z',
    hidden_at: null,
    ...overrides,
  };
}

function detailItem(overrides: Record<string, unknown> = {}) {
  return {
    id: FLAG_ID,
    type: 'food',
    content_id: '00000000-0000-4000-8000-0000000000aa',
    content_url: null,
    reporter_count: 1,
    user_id: '00000000-0000-4000-8000-0000000000bb',
    status: 'rejected',
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

async function renderDetail(item: Record<string, unknown>, type = 'food'): Promise<HTMLDivElement> {
  adminFetch.mockResolvedValue(jsonResponse({ data: item }));
  const markup = renderToStaticMarkup(await AdminModerationDetailPage({ params: Promise.resolve({ type, id: FLAG_ID }) }));
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host;
}

function definitionOf(host: HTMLElement, term: string): string | null {
  const dt = Array.from(host.querySelectorAll('dt')).find((el) => el.textContent === term);
  return dt?.parentElement?.querySelector('dd')?.textContent?.trim() ?? null;
}

/** 英字の内部の値が、語として (前後が英字でない形で) 文の中に出ていないか */
function containsEnglishValue(text: string, value: string): boolean {
  return new RegExp(`(^|[^A-Za-z])${value}([^A-Za-z]|$)`).test(text);
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleForPage.mockResolvedValue(adminActor);
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
});

async function renderForm(status: string) {
  await act(async () => {
    root.render(<ModerationReviewForm type="food" id="flag-1" status={status} isSuperAdmin={false} />);
  });
}

describe('#2080 U6 審査の欄: 審査済みのアイテムの状態を日本語で出す', () => {
  it.each(['approved', 'rejected', 'escalated'])('ステータス %s は日本語の表示名で出し、英字の値を出さない', async (status) => {
    await renderForm(status);

    const text = container.textContent ?? '';
    expect(text).toContain('このアイテムは既に審査済みです');
    expect(text).toContain(`ステータス: ${EXPECTED_STATUS_LABELS[status]}`);
    expect(containsEnglishValue(text, status)).toBe(false);
  });

  it('表に無い状態の値 (将来の値・壊れた応答) は、内部の値を出さず固定の文を出す', async () => {
    await renderForm('archived');

    const text = container.textContent ?? '';
    expect(text).toContain(`ステータス: ${UNKNOWN_STATUS_LABEL}`);
    expect(containsEnglishValue(text, 'archived')).toBe(false);
  });

  it('審査を確定した応答の状態が表に無い値でも、結果の文に内部の値を出さない', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { success: true, status: 'archived', ban_applied: null } }));
    await renderForm('pending');

    const select = container.querySelector<HTMLSelectElement>('select#action')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(select, 'approve');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('審査を確定'));
    await act(async () => {
      button!.click();
    });

    const status = container.querySelector('[role="status"]')?.textContent ?? '';
    expect(status).toContain('審査を確定しました');
    expect(status).toContain(`ステータス: ${UNKNOWN_STATUS_LABEL}`);
    expect(containsEnglishValue(status, 'archived')).toBe(false);
  });

  it('審査を確定した応答の状態 (rejected) は日本語の表示名で出す', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { success: true, status: 'rejected', ban_applied: null } }));
    await renderForm('pending');

    const select = container.querySelector<HTMLSelectElement>('select#action')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(select, 'delete_only');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('審査を確定'));
    await act(async () => {
      button!.click();
    });

    expect(container.querySelector('[role="status"]')?.textContent ?? '').toContain(`ステータス: ${EXPECTED_STATUS_LABELS.rejected}`);
  });
});

describe('#2080 U6 審査の一覧: ステータスの列・件数の見出し・タイプの札を日本語で出す', () => {
  it('ステータスの列は日本語の表示名 (表に無い値は固定の文)、タイプの札も日本語', async () => {
    adminFetch.mockResolvedValue(
      jsonResponse({
        data: [
          queueItem('flag-1', { status: 'rejected' }),
          queueItem('flag-2', { status: 'pending', type: 'recipe' }),
          queueItem('flag-3', { status: 'approved' }),
          queueItem('flag-4', { status: 'escalated' }),
          queueItem('flag-5', { status: 'archived', type: 'video' }),
        ],
        meta: { total: 5, page: 1, per_page: 30 },
      }),
    );

    const page = await renderList({ status: 'rejected' });

    const rows = Array.from(page.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(5);
    const statusCell = (row: Element) => row.querySelectorAll('td')[3].textContent ?? '';
    const typeCell = (row: Element) => row.querySelectorAll('td')[0].textContent?.trim() ?? '';
    expect(statusCell(rows[0])).toContain(EXPECTED_STATUS_LABELS.rejected);
    expect(statusCell(rows[1])).toContain(EXPECTED_STATUS_LABELS.pending);
    expect(statusCell(rows[2])).toContain(EXPECTED_STATUS_LABELS.approved);
    expect(statusCell(rows[3])).toContain(EXPECTED_STATUS_LABELS.escalated);
    expect(statusCell(rows[4])).toContain(UNKNOWN_STATUS_LABEL);
    expect(typeCell(rows[0])).toBe(EXPECTED_TYPE_LABELS.food);
    expect(typeCell(rows[1])).toBe(EXPECTED_TYPE_LABELS.recipe);
    expect(typeCell(rows[4])).toBe(UNKNOWN_TYPE_LABEL);
    const tbodyText = page.querySelector('tbody')?.textContent ?? '';
    for (const value of [...ENGLISH_STATUS_VALUES, 'food', 'recipe', 'video']) {
      expect(containsEnglishValue(tbodyText, value), `一覧に ${value} が出ている`).toBe(false);
    }
  });

  it.each(['approved', 'rejected', 'escalated', 'pending'])('件数の見出しは絞り込みの状態 %s を日本語で出す', async (status) => {
    adminFetch.mockResolvedValue(jsonResponse({ data: [], meta: { total: 0, page: 1, per_page: 30 } }));

    const page = await renderList({ status });

    const heading = page.querySelector('h1')?.parentElement?.querySelector('span')?.textContent ?? '';
    expect(heading).toContain(`${EXPECTED_STATUS_LABELS[status]} 件数: 0`);
    expect(containsEnglishValue(heading, status)).toBe(false);
  });
});

describe('#2080 U6 審査の詳細: 「ステータス」「タイプ」の項目を日本語で出す', () => {
  it.each(Object.keys(EXPECTED_STATUS_LABELS))('ステータス %s は日本語の表示名', async (status) => {
    const page = await renderDetail(detailItem({ status }));

    expect(definitionOf(page, 'ステータス')).toBe(EXPECTED_STATUS_LABELS[status]);
  });

  it('表に無い状態の値は固定の文。タイプは日本語の表示名', async () => {
    const page = await renderDetail(detailItem({ status: 'archived', type: 'recipe' }), 'recipe');

    expect(definitionOf(page, 'ステータス')).toBe(UNKNOWN_STATUS_LABEL);
    expect(definitionOf(page, 'タイプ')).toBe(EXPECTED_TYPE_LABELS.recipe);
    expect(containsEnglishValue(page.textContent ?? '', 'archived')).toBe(false);
  });
});
