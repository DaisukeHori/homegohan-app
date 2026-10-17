/**
 * #1538 運営が隠したコンテンツを戻す操作 (段 B) — 一覧の「非表示中」のバッジと、詳細の「表示」の項目・「非表示の解除」のカード
 * 設計: docs/design/operator/13-hidden-content-restore.md §9.1・§9.3・§13.2 (PG-1〜PG-4)
 *
 * tests/admin-user-login-history-page.test.tsx と同じ形: 入口 (requireRoleForPage) と adminFetch を mock し、
 * async の Server Component を renderToStaticMarkup で HTML にして確かめる。「今」は vi.setSystemTime で固定する。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireRoleForPage = vi.hoisted(() => vi.fn());
const adminFetch = vi.hoisted(() => vi.fn());
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/auth/page-guard', () => ({ requireRoleForPage }));
vi.mock('@/lib/admin/fetch', () => ({ adminFetch }));

const { default: AdminModerationPage } = await import('@/app/admin/moderation/page');
const { default: AdminModerationDetailPage } = await import('@/app/admin/moderation/[type]/[id]/page');

/** 「今」。vi.setSystemTime で固定する */
const NOW = new Date('2026-10-18T03:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** 隠してから 3 日 (戻せる期間の中) */
const HIDDEN_RECENT = new Date(NOW.getTime() - 3 * MS_PER_DAY).toISOString();
/** 隠してから 90 日 (戻せる期間 89 日の外) */
const HIDDEN_EXPIRED = new Date(NOW.getTime() - 90 * MS_PER_DAY).toISOString();

const FLAG_ID = '00000000-0000-4000-8000-000000000001';
const BADGE = '非表示中';
const RESTORE_CARD_TITLE = '非表示の解除';
const REVIEWED_NOTICE = 'このアイテムは既に審査済みです';

const adminActor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['admin'], email: 'admin@example.com' };

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

/** 「コンテンツ情報」の dl から、項目名 (dt) に対応する値 (dd) の文字列 */
function definitionOf(host: HTMLElement, term: string): string | null {
  const dt = Array.from(host.querySelectorAll('dt')).find((el) => el.textContent === term);
  return dt?.parentElement?.querySelector('dd')?.textContent ?? null;
}

/** 「非表示の解除」の見出しを持つカード (section) */
function restoreCard(host: HTMLElement): HTMLElement | null {
  const heading = Array.from(host.querySelectorAll('h2')).find((el) => el.textContent === RESTORE_CARD_TITLE);
  return heading?.parentElement ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Date だけを固定する (Promise・setTimeout は本物のまま。async の Server Component を待つため)
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  requireRoleForPage.mockResolvedValue(adminActor);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/admin/moderation (一覧) の「非表示中」のバッジ', () => {
  it('PG-1: hidden_at がある項目 (status rejected と pending) のステータスの欄に「非表示中」のバッジ。hidden_at が null の項目には出ない。status の絞り込みの選択肢は変わらない', async () => {
    adminFetch.mockResolvedValue(
      jsonResponse({
        data: [
          queueItem('flag-rejected-hidden', { status: 'rejected', hidden_at: HIDDEN_RECENT }),
          queueItem('flag-pending-hidden', { status: 'pending', hidden_at: HIDDEN_RECENT }),
          queueItem('flag-approved-visible', { status: 'approved', hidden_at: null }),
        ],
        meta: { total: 3, page: 1, per_page: 30 },
      }),
    );

    const page = await renderList({ status: 'rejected' });

    const rows = Array.from(page.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(3);
    const statusCell = (row: Element) => row.querySelectorAll('td')[3];
    expect(statusCell(rows[0]).textContent).toContain('rejected');
    expect(statusCell(rows[0]).textContent).toContain(BADGE);
    expect(statusCell(rows[1]).textContent).toContain('pending');
    expect(statusCell(rows[1]).textContent).toContain(BADGE);
    expect(statusCell(rows[2]).textContent).toContain('approved');
    expect(statusCell(rows[2]).textContent).not.toContain(BADGE);

    // 絞り込み (status の select) は変えない
    const options = Array.from(page.querySelectorAll<HTMLOptionElement>('select[name="status"] option')).map((o) => o.value);
    expect(options).toEqual(['pending', 'approved', 'rejected', 'escalated']);
  });

  it('PG-1: API の応答に hidden_at が無い (undefined) 項目にもバッジを出さない', async () => {
    const withoutHiddenAt: Record<string, unknown> = queueItem('flag-legacy');
    delete withoutHiddenAt.hidden_at;
    adminFetch.mockResolvedValue(jsonResponse({ data: [withoutHiddenAt], meta: { total: 1, page: 1, per_page: 30 } }));

    const page = await renderList();

    expect(page.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(page.textContent).not.toContain(BADGE);
  });
});

describe('/admin/moderation/[type]/[id] (詳細)', () => {
  it('PG-2: 「コンテンツ情報」の「表示」の項目は、hidden_at があれば「非表示中 (隠した日時: <JST>)」、null なら「表示中」', async () => {
    const hiddenPage = await renderDetail(detailItem({ hidden_at: HIDDEN_RECENT }));
    const expectedJst = new Date(HIDDEN_RECENT).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    expect(definitionOf(hiddenPage, '表示')).toBe(`非表示中 (隠した日時: ${expectedJst})`);

    const visiblePage = await renderDetail(detailItem({ hidden_at: null }));
    expect(definitionOf(visiblePage, '表示')).toBe('表示中');
  });

  it('PG-3: status pending で hidden_at がある (89 日以内) と、審査の欄 (入力) と「非表示の解除」のカード (textarea#restore_note と「表示に戻す」) の両方が出る', async () => {
    const page = await renderDetail(detailItem({ status: 'pending', hidden_at: HIDDEN_RECENT }));

    // 審査の欄: pending なので ModerationReviewForm の入力が出る
    expect(page.textContent).toContain('審査アクション');
    expect(page.textContent).toContain('審査を確定');
    expect(page.textContent).not.toContain(REVIEWED_NOTICE);
    // 解除のカード
    const card = restoreCard(page);
    expect(card, '「非表示の解除」のカードが無い').not.toBeNull();
    expect(card!.querySelector('textarea#restore_note')).not.toBeNull();
    expect(Array.from(card!.querySelectorAll('button')).map((b) => b.textContent)).toContain('表示に戻す');
  });

  it('PG-3: status rejected なら「このアイテムは既に審査済みです」と解除のカード', async () => {
    const page = await renderDetail(detailItem({ status: 'rejected', hidden_at: HIDDEN_RECENT }));

    expect(page.textContent).toContain(REVIEWED_NOTICE);
    const card = restoreCard(page);
    expect(card).not.toBeNull();
    expect(card!.querySelector('textarea#restore_note')).not.toBeNull();
  });

  it('PG-3: hidden_at が null なら解除のカードが無い (見出しも出ない)', async () => {
    const page = await renderDetail(detailItem({ status: 'approved', hidden_at: null }));

    expect(restoreCard(page)).toBeNull();
    expect(page.textContent).not.toContain(RESTORE_CARD_TITLE);
    expect(page.querySelector('textarea#restore_note')).toBeNull();
    // 審査の欄は従来どおり
    expect(page.textContent).toContain(REVIEWED_NOTICE);
  });

  it('PG-4: hidden_at が 90 日前なら「非表示の解除」のカードはあるが、textarea#restore_note とボタンが無く、89 日を過ぎた案内だけ', async () => {
    const page = await renderDetail(detailItem({ status: 'rejected', hidden_at: HIDDEN_EXPIRED }));

    const card = restoreCard(page);
    expect(card, '「非表示の解除」のカードが無い').not.toBeNull();
    expect(card!.querySelector('textarea#restore_note')).toBeNull();
    expect(Array.from(card!.querySelectorAll('button'))).toHaveLength(0);
    expect(card!.textContent).toContain('隠してから 89 日を過ぎたため戻せません');
    expect(card!.textContent).toContain('保管期間 (90 日)');
  });

  it('PG-4: 戻せる期間の境 (ちょうど 89 日前) は戻せる', async () => {
    const boundary = new Date(NOW.getTime() - 89 * MS_PER_DAY).toISOString();
    const page = await renderDetail(detailItem({ hidden_at: boundary }));

    expect(restoreCard(page)!.querySelector('textarea#restore_note')).not.toBeNull();
  });

  it('レシピの詳細: 食事の複製の説明は出さない', async () => {
    const page = await renderDetail(detailItem({ type: 'recipe', hidden_at: HIDDEN_RECENT }), 'recipe');

    const card = restoreCard(page);
    expect(card).not.toBeNull();
    expect(card!.textContent).not.toContain('家族への貼り付けの複製のうち');
  });
});
