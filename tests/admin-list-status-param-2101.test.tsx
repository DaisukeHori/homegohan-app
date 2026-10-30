/**
 * #2101 X7 (triage-1030b) のテスト: 審査の一覧・ユーザーの一覧の URL の status の読み方
 *
 * 以前: 審査の一覧 (/admin/moderation) とユーザーの一覧 (/admin/users) は、URL の status を検査せずに一覧の API へ送っていた。
 * ?status=foo のように手で書き換えると、API の enum (審査 = pending / approved / rejected / escalated、
 * ユーザー = active / banned / deleted) に無いので 400 になり、「読み込めませんでした」と「再読み込み」を出すが、
 * 押しても同じ URL を読むので同じ 400 になっていた (#2093 W8 の ?page=abc と同じ型)。
 *
 * 直したあと:
 *  - URL の status が API の enum に無ければ、既定 (審査は pending・ユーザーは active) として API に送る (#2093 W8 の
 *    parsePageParam と同じ扱い)。絞り込みの選択・前後のページ・最後のページへの移動も、その既定の値で作る
 *  - enum の値はそのまま送る。ユーザーの一覧の空の status (「全ステータス」) は、今までどおり status を付けずに送る (全件)
 *
 * 画面 (async の Server Component) は renderToStaticMarkup で描く (tests/admin-users-load-failure-2093.test.tsx と同じ形)。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireRoleForPage = vi.hoisted(() => vi.fn());
const adminFetch = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
/** Next の redirect と同じく例外で抜ける (呼ばれた先の URL を例外の文に入れる) */
const REDIRECT_ERROR_PREFIX = 'NEXT_REDIRECT:';
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ redirect, notFound: vi.fn(), useRouter: () => router }));
vi.mock('@/lib/auth/page-guard', () => ({ requireRoleForPage }));
vi.mock('@/lib/admin/fetch', () => ({ adminFetch }));

const { default: AdminUsersPage } = await import('@/app/admin/users/page');
const { default: AdminModerationPage } = await import('@/app/admin/moderation/page');
const { MODERATION_QUEUE_STATUSES, ModerationQueueSearchSchema } = await import('@/lib/admin/moderation-schemas');
const { USER_LIST_STATUSES, UsersSearchSchema } = await import('@/lib/admin/users-schemas');

const adminActor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['admin'], email: 'admin@example.com' };

/** ユーザーの一覧・審査の一覧の 1 ページの件数 (画面の perPage と同じ) */
const USERS_PER_PAGE = 50;
const MODERATION_PER_PAGE = 30;
/** 前後のページのリンクを出すための件数 (3 ページぶん) */
const PAGES_FOR_LINKS = 3;

const HTTP_OK = 200;

function jsonResponse(body: unknown) {
  return { ok: true, status: HTTP_OK, json: () => Promise.resolve(body) };
}

function listUser(n: number) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    email: `user${n}@example.com`,
    nickname: `利用者${n}`,
    roles: ['user'],
    plan_key: 'free',
    is_banned: false,
    frozen_at: null,
    frozen_reason: null,
    frozen_by: null,
    unban_at: null,
    last_login_at: null,
    registered_at: '2026-01-01T00:00:00+00:00',
    meal_count: 0,
    organization_id: null,
  };
}

function moderationItem(n: number) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    type: 'food',
    content_url: null,
    reporter_count: 1,
    user_id: 'user-1',
    status: 'pending',
    created_at: '2026-10-01T00:00:00Z',
    hidden_at: null,
  };
}

function hostOf(markup: string): HTMLDivElement {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host;
}

/** adminFetch に渡した URL の query (最初の呼び出し) */
function apiQuery(): Record<string, string> {
  const url = new URL(String(adminFetch.mock.calls[0]?.[0]), 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

/** 画面の中のリンク (前へ・次へ) の query の status */
function linkStatuses(page: HTMLElement, pathname: string): Array<string | null> {
  return Array.from(page.querySelectorAll('a'))
    .map((a) => new URL(a.getAttribute('href') ?? '', 'http://localhost'))
    .filter((u) => u.pathname === pathname && u.searchParams.has('page'))
    .map((u) => u.searchParams.get('status'));
}

/** 絞り込みの status の選択で選ばれている値 (defaultValue の option) */
function selectedStatus(page: HTMLElement): string | null {
  return page.querySelector<HTMLOptionElement>('select[name="status"] option[selected]')?.getAttribute('value') ?? null;
}

async function renderOrRedirect(render: () => Promise<React.ReactElement>): Promise<{ redirectedTo: string | null; page: HTMLDivElement | null }> {
  try {
    return { redirectedTo: null, page: hostOf(renderToStaticMarkup(await render())) };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(REDIRECT_ERROR_PREFIX)) {
      return { redirectedTo: err.message.slice(REDIRECT_ERROR_PREFIX.length), page: null };
    }
    throw err;
  }
}

const renderUsers = (searchParams: Record<string, string>) =>
  renderOrRedirect(() => AdminUsersPage({ searchParams: Promise.resolve(searchParams) }));
const renderModeration = (searchParams: Record<string, string>) =>
  renderOrRedirect(() => AdminModerationPage({ searchParams: Promise.resolve(searchParams) }));

/** API の enum に無い status (手で書き換えた URL) */
const INVALID_STATUSES = ['foo', 'PENDING', 'Active', ' active', 'all', 'ai_content'];

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleForPage.mockResolvedValue(adminActor);
});

describe('#2101 X7 審査の一覧 (/admin/moderation) の URL の status', () => {
  beforeEach(() => {
    adminFetch.mockResolvedValue(
      jsonResponse({ data: [moderationItem(1)], meta: { total: MODERATION_PER_PAGE * PAGES_FOR_LINKS, page: 2, per_page: MODERATION_PER_PAGE } }),
    );
  });

  it.each(INVALID_STATUSES)('enum に無い status (%j) は既定の pending として API に送り、選択・前後のリンクも pending にする', async (raw) => {
    const { page } = await renderModeration({ status: raw, page: '2' });
    expect(apiQuery().status).toBe('pending');
    // 送った値は API の検査 (ModerationQueueSearchSchema) に通る = 400 の読み込みの失敗にならない
    expect(ModerationQueueSearchSchema.safeParse(apiQuery()).success).toBe(true);
    expect(selectedStatus(page!)).toBe('pending');
    const links = linkStatuses(page!, '/admin/moderation');
    expect(links.length).toBeGreaterThan(0);
    expect(new Set(links)).toEqual(new Set(['pending']));
  });

  it.each(MODERATION_QUEUE_STATUSES.map((s) => [s]))('enum の値 (%s) はそのまま送る', async (status) => {
    const { page } = await renderModeration({ status });
    expect(apiQuery().status).toBe(status);
    expect(selectedStatus(page!)).toBe(status);
  });

  it('status が無ければ pending を送る (今までどおり)', async () => {
    await renderModeration({});
    expect(apiQuery().status).toBe('pending');
  });

  it('件数より後ろのページから最後のページへ移すときも、既定の pending で移す', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ data: [], meta: { total: 1, page: 9, per_page: MODERATION_PER_PAGE } }));
    const { redirectedTo } = await renderModeration({ status: 'foo', page: '9' });
    expect(redirectedTo).not.toBeNull();
    const location = new URL(redirectedTo!, 'http://localhost');
    expect(location.pathname).toBe('/admin/moderation');
    expect(location.searchParams.get('status')).toBe('pending');
    expect(location.searchParams.get('page')).toBe('1');
  });
});

describe('#2101 X7 ユーザーの一覧 (/admin/users) の URL の status', () => {
  beforeEach(() => {
    adminFetch.mockResolvedValue(
      jsonResponse({ data: [listUser(1)], meta: { total: USERS_PER_PAGE * PAGES_FOR_LINKS, page: 2, per_page: USERS_PER_PAGE } }),
    );
  });

  it.each(INVALID_STATUSES)('enum に無い status (%j) は既定の active として API に送り、選択・前後のリンクも active にする', async (raw) => {
    const { page } = await renderUsers({ status: raw, page: '2' });
    expect(apiQuery().status).toBe('active');
    // 送った値は API の検査 (UsersSearchSchema) に通る = 400 の読み込みの失敗にならない
    expect(UsersSearchSchema.safeParse(apiQuery()).success).toBe(true);
    expect(selectedStatus(page!)).toBe('active');
    const links = linkStatuses(page!, '/admin/users');
    expect(links.length).toBeGreaterThan(0);
    expect(new Set(links)).toEqual(new Set(['active']));
  });

  it.each(USER_LIST_STATUSES.map((s) => [s]))('enum の値 (%s) はそのまま送る', async (status) => {
    await renderUsers({ status });
    expect(apiQuery().status).toBe(status);
  });

  it('空の status (「全ステータス」) は、今までどおり status を付けずに送り、選択も「全ステータス」のまま', async () => {
    const { page } = await renderUsers({ status: '' });
    expect('status' in apiQuery()).toBe(false);
    expect(selectedStatus(page!)).toBe('');
  });

  it('status が無ければ active を送る (今までどおり)', async () => {
    await renderUsers({});
    expect(apiQuery().status).toBe('active');
  });

  it('件数より後ろのページから最後のページへ移すときも、既定の active で移す', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ data: [], meta: { total: 1, page: 9, per_page: USERS_PER_PAGE } }));
    const { redirectedTo } = await renderUsers({ status: 'foo', page: '9' });
    expect(redirectedTo).not.toBeNull();
    const location = new URL(redirectedTo!, 'http://localhost');
    expect(location.pathname).toBe('/admin/users');
    expect(location.searchParams.get('status')).toBe('active');
    expect(location.searchParams.get('page')).toBe('1');
  });
});
