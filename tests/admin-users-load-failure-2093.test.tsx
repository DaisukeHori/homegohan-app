/**
 * #2093 W3・W8 (triage-1030a) のテスト
 *
 * W3: 運営のユーザーの一覧 (/admin/users) は、一覧の API の失敗 (!res.ok)・通信の失敗 (adminFetch の例外) を console.error で捨てて
 * 0 件のまま描き、「ユーザーが見つかりません」「全 0 件」と出していた (いる利用者をいないと誤る)。
 * ユーザーの詳細 (/admin/users/{id})・凍結 (/admin/users/{id}/freeze) は、404 以外の失敗 (500 / 503 / 403) も notFound() にして、
 * 利用者が消えた (無い) ように見せていた。
 * W8: 審査の一覧 (/admin/moderation) は、最後のページより後ろの page で「審査待ちのアイテムはありません」と出し、
 * URL の page が数でない (?page=abc) と page=NaN を API に送って 400 にしていた (再読み込みしても直らない)。
 *
 * 直したあと:
 *  - ユーザーの一覧: 読み込みの失敗 (!res.ok・例外・壊れた応答) は 0 件と分けて「ユーザーの一覧を読み込めませんでした」と
 *    「再読み込み」を出し、件数の見出し・0 件の文・表は出さない。読めた 0 件は従来どおり 0 件の文
 *  - ユーザーの詳細・凍結: 404 だけ notFound()。それ以外の失敗は「ユーザーを読み込めませんでした」と「再読み込み」を出す
 *  - ユーザーの一覧・審査の一覧: URL の page が 1 以上の整数でなければ 1 ページ目を読む
 *  - 審査の一覧: 読めたのに行が 0 件で、件数が今のページより前で尽きているなら、絞り込みを保ったまま最後のページへ移す
 *    (読み込みの失敗のときは移さない)
 *
 * 画面 (async の Server Component) は renderToStaticMarkup で描く (tests/admin-moderation-load-failure-2086.test.tsx と同じ形)。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireRoleForPage = vi.hoisted(() => vi.fn());
const adminFetch = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
/** Next の redirect と同じく例外で抜ける (呼ばれた先の URL を例外の文に入れる) */
const REDIRECT_ERROR_PREFIX = 'NEXT_REDIRECT:';
const NOT_FOUND_ERROR = 'NEXT_NOT_FOUND';
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ redirect, notFound, useRouter: () => router }));
vi.mock('@/lib/auth/page-guard', () => ({ requireRoleForPage }));
vi.mock('@/lib/admin/fetch', () => ({ adminFetch }));

const { default: AdminUsersPage } = await import('@/app/admin/users/page');
const { default: AdminUserDetailPage } = await import('@/app/admin/users/[id]/page');
const { default: AdminUserFreezePage } = await import('@/app/admin/users/[id]/freeze/page');
const { default: AdminModerationPage } = await import('@/app/admin/moderation/page');
const { parsePageParam, FIRST_PAGE } = await import('@/lib/list-pagination');

const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const adminActor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['admin'], email: 'admin@example.com' };
const superAdminActor = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', roles: ['super_admin'], email: 'sa@example.com' };

/** 画面に出す文 (画面と同じもの) */
const USERS_LIST_LOAD_FAILED_TEXT = 'ユーザーの一覧を読み込めませんでした';
const USER_DETAIL_LOAD_FAILED_TEXT = 'ユーザーを読み込めませんでした';
const RELOAD_LABEL = '再読み込み';
const USERS_EMPTY_TEXT = 'ユーザーが見つかりません';
const MODERATION_EMPTY_PENDING_TEXT = '審査待ちのアイテムはありません';
/** 凍結の欄 (UserFreezeForm) の見出しの一部。読めていない状態では描かない */
const FREEZE_FORM_SUBMIT_TEXT = '凍結する';

/** ユーザーの一覧・審査の一覧の 1 ページの件数 (src/app/admin/users/page.tsx・src/app/admin/moderation/page.tsx の perPage と同じ) */
const USERS_PER_PAGE = 50;
const MODERATION_PER_PAGE = 30;

const HTTP_OK = 200;
const HTTP_OK_MAX_EXCLUSIVE = 300;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;

function jsonResponse(body: unknown, status = HTTP_OK) {
  return { ok: status >= HTTP_OK && status < HTTP_OK_MAX_EXCLUSIVE, status, json: () => Promise.resolve(body) };
}

/** 本文が JSON でない応答 (プロキシの HTML の 502 など。json() が SyntaxError で reject する) */
function nonJsonResponse(status: number) {
  return {
    ok: status >= HTTP_OK && status < HTTP_OK_MAX_EXCLUSIVE,
    status,
    json: () => Promise.reject(new SyntaxError('Unexpected token <')),
  };
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

const detailProfile = {
  id: USER_ID,
  email: 'target@example.com',
  nickname: '対象さん',
  roles: ['user'],
  plan_key: 'free',
  is_banned: false,
  frozen_at: null,
  frozen_reason: null,
  last_login_at: null,
  registered_at: '2026-01-01T00:00:00+00:00',
  active_subscription: null,
  ban_history: [],
};

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

/** 画面を呼び、redirect されたらその URL を、されなければ描いた画面を返す */
async function renderOrRedirect(
  render: () => Promise<React.ReactElement>,
): Promise<{ redirectedTo: string | null; page: HTMLDivElement | null }> {
  try {
    const element = await render();
    return { redirectedTo: null, page: hostOf(renderToStaticMarkup(element)) };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(REDIRECT_ERROR_PREFIX)) {
      return { redirectedTo: err.message.slice(REDIRECT_ERROR_PREFIX.length), page: null };
    }
    throw err;
  }
}

async function renderUsersList(searchParams: Record<string, string> = {}): Promise<HTMLDivElement> {
  return hostOf(renderToStaticMarkup(await AdminUsersPage({ searchParams: Promise.resolve(searchParams) })));
}

async function renderUserDetail(): Promise<HTMLDivElement> {
  return hostOf(renderToStaticMarkup(await AdminUserDetailPage({ params: Promise.resolve({ id: USER_ID }) })));
}

async function renderUserFreeze(): Promise<HTMLDivElement> {
  return hostOf(renderToStaticMarkup(await AdminUserFreezePage({ params: Promise.resolve({ id: USER_ID }) })));
}

function reloadButtonOf(host: HTMLElement): HTMLButtonElement | null {
  return Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === RELOAD_LABEL) ?? null;
}

/** adminFetch に渡した URL の query (呼んだ順の index) */
function apiQueryOf(callIndex = 0): Record<string, string> {
  const url = new URL(String(adminFetch.mock.calls[callIndex]?.[0]), 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

/** redirect の URL の path と query */
function locationOf(url: string): { pathname: string; query: Record<string, string> } {
  const parsed = new URL(url, 'http://localhost');
  return { pathname: parsed.pathname, query: Object.fromEntries(parsed.searchParams.entries()) };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRoleForPage.mockResolvedValue(adminActor);
});

/** 一覧の読み込みの失敗の作り方 (API の失敗・通信の失敗・壊れた応答) */
const LIST_FAILURES: Array<[string, () => void]> = [
  ['API が 500 を返す', () => adminFetch.mockResolvedValue(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: '内部エラー' } }, HTTP_INTERNAL_ERROR))],
  ['API が 403 を返す', () => adminFetch.mockResolvedValue(jsonResponse({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, HTTP_FORBIDDEN))],
  ['本文が JSON でない 502', () => adminFetch.mockResolvedValue(nonJsonResponse(HTTP_BAD_GATEWAY))],
  ['通信の失敗 (adminFetch の例外)', () => adminFetch.mockRejectedValue(new TypeError('fetch failed'))],
  ['200 だが本文が JSON でない', () => adminFetch.mockResolvedValue(nonJsonResponse(HTTP_OK))],
  ['200 だが data が配列でない', () => adminFetch.mockResolvedValue(jsonResponse({ data: null, meta: { total: 0 } }))],
];

describe('#2093 W3 ユーザーの一覧: 読み込みの失敗を 0 件と分ける', () => {
  it.each(LIST_FAILURES)('%s ときは「読み込めませんでした」と「再読み込み」を出し、0 件の文・件数 0 を出さない', async (_label, arrange) => {
    arrange();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const page = await renderUsersList({ page: '3' });
    const text = page.textContent ?? '';

    expect(page.querySelector('[role="alert"]')?.textContent ?? '').toContain(USERS_LIST_LOAD_FAILED_TEXT);
    expect(reloadButtonOf(page)).not.toBeNull();
    expect(text).not.toContain(USERS_EMPTY_TEXT);
    expect(text).not.toContain('全 0 件');
    // 表 (0 件の行を含む) を描かない
    expect(page.querySelector('table')).toBeNull();
    // 検索のフォームは残す (別の条件で読み直せる)
    expect(page.querySelector('form input[name="q"]')).not.toBeNull();
    // 失敗を、何も知らせずにページを移す動きに変えない (#1917)
    expect(redirect).not.toHaveBeenCalled();
  });

  it('読めた 0 件は従来どおり 0 件の文と件数を出し、読み込みの失敗の文は出さない', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ data: [], meta: { total: 0, page: 1, per_page: USERS_PER_PAGE } }));

    const page = await renderUsersList();
    const text = page.textContent ?? '';

    expect(text).toContain(USERS_EMPTY_TEXT);
    expect(text).toContain('全 0 件');
    expect(text).not.toContain(USERS_LIST_LOAD_FAILED_TEXT);
    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(reloadButtonOf(page)).toBeNull();
  });

  it('読めた行は表に出し、読み込みの失敗の文は出さない', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ data: [listUser(1)], meta: { total: 1, page: 1, per_page: USERS_PER_PAGE } }));

    const page = await renderUsersList();

    expect(page.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(page.textContent ?? '').toContain('利用者1');
    expect(page.textContent ?? '').toContain('全 1 件');
    expect(page.textContent ?? '').not.toContain(USERS_LIST_LOAD_FAILED_TEXT);
  });
});

/** 詳細の読み込みの失敗の作り方 (404 以外) */
const DETAIL_FAILURES: Array<[string, () => void]> = [
  ['500', () => adminFetch.mockResolvedValue(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: '内部エラー' } }, HTTP_INTERNAL_ERROR))],
  ['503', () => adminFetch.mockResolvedValue(jsonResponse({ error: { code: 'SERVICE_UNAVAILABLE', message: '混雑' } }, HTTP_SERVICE_UNAVAILABLE))],
  ['403', () => adminFetch.mockResolvedValue(jsonResponse({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, HTTP_FORBIDDEN))],
  ['本文が JSON でない 502', () => adminFetch.mockResolvedValue(nonJsonResponse(HTTP_BAD_GATEWAY))],
  ['通信の失敗 (adminFetch の例外)', () => adminFetch.mockRejectedValue(new TypeError('fetch failed'))],
  ['200 だが本文が JSON でない', () => adminFetch.mockResolvedValue(nonJsonResponse(HTTP_OK))],
  ['200 だが data が無い', () => adminFetch.mockResolvedValue(jsonResponse({}))],
];

describe('#2093 W3 ユーザーの詳細: 404 だけを「無い」にし、それ以外の失敗は読み込みの失敗として出す', () => {
  it('404 は notFound()', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } }, HTTP_NOT_FOUND));

    await expect(renderUserDetail()).rejects.toThrow(NOT_FOUND_ERROR);
  });

  it.each(DETAIL_FAILURES)('%s は notFound() にせず「読み込めませんでした」と「再読み込み」を出す', async (_label, arrange) => {
    arrange();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const page = await renderUserDetail();

    expect(notFound).not.toHaveBeenCalled();
    expect(page.querySelector('[role="alert"]')?.textContent ?? '').toContain(USER_DETAIL_LOAD_FAILED_TEXT);
    expect(reloadButtonOf(page)).not.toBeNull();
    // 基本情報 (読めていない値) は描かない
    expect(page.textContent ?? '').not.toContain('基本情報');
    // 一覧へ戻る道は残す
    expect(page.querySelector('a[href="/admin/users"]')).not.toBeNull();
    // ログイン履歴などの続きの読み込みはしない (読めていない利用者の id で呼ばない)
    expect(adminFetch).toHaveBeenCalledTimes(1);
  });

  it('読めたユーザーは従来どおり描き、読み込みの失敗の文は出さない', async () => {
    adminFetch.mockImplementation(async (path: string) =>
      path.endsWith('/login-history') ? jsonResponse({ data: { entries: [] } }) : jsonResponse({ data: detailProfile }),
    );

    const page = await renderUserDetail();

    expect(page.textContent ?? '').toContain('基本情報');
    expect(page.textContent ?? '').toContain('対象さん');
    expect(page.textContent ?? '').not.toContain(USER_DETAIL_LOAD_FAILED_TEXT);
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('#2093 W3 ユーザーの凍結: 404 だけを「無い」にし、それ以外の失敗は読み込みの失敗として出す', () => {
  beforeEach(() => {
    requireRoleForPage.mockResolvedValue(superAdminActor);
  });

  it('404 は notFound()', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } }, HTTP_NOT_FOUND));

    await expect(renderUserFreeze()).rejects.toThrow(NOT_FOUND_ERROR);
  });

  it.each(DETAIL_FAILURES)('%s は notFound() にせず「読み込めませんでした」と「再読み込み」を出す', async (_label, arrange) => {
    arrange();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const page = await renderUserFreeze();

    expect(notFound).not.toHaveBeenCalled();
    expect(page.querySelector('[role="alert"]')?.textContent ?? '').toContain(USER_DETAIL_LOAD_FAILED_TEXT);
    expect(reloadButtonOf(page)).not.toBeNull();
    // 凍結の状態を読めていないので、凍結・凍結解除の欄は描かない (逆の操作をさせない)
    expect(page.querySelector('form')).toBeNull();
    expect(page.textContent ?? '').not.toContain(FREEZE_FORM_SUBMIT_TEXT);
    // 一覧と詳細へ戻る道は残す
    expect(page.querySelector('a[href="/admin/users"]')).not.toBeNull();
    expect(page.querySelector(`a[href="/admin/users/${USER_ID}"]`)).not.toBeNull();
  });

  it('読めたユーザーは従来どおり凍結の欄を描き、読み込みの失敗の文は出さない', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ data: detailProfile }));

    const page = await renderUserFreeze();

    expect(page.querySelector('form')).not.toBeNull();
    expect(page.textContent ?? '').toContain('対象さん');
    expect(page.textContent ?? '').not.toContain(USER_DETAIL_LOAD_FAILED_TEXT);
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });
});

/** URL の page のうち、1 以上の整数でないもの (1 ページ目として読む) */
const INVALID_PAGE_PARAMS = ['abc', '2abc', '0', '-1', '1.5', '', ' ', '1e3', '99999999999999999999'];

describe('#2093 W8 URL の page が 1 以上の整数でなければ 1 ページ目を読む', () => {
  it.each(INVALID_PAGE_PARAMS)('審査の一覧: page=%j は API に page=1 を送る (NaN・小数・0 以下を送らない)', async (raw) => {
    adminFetch.mockResolvedValue(jsonResponse({ data: [moderationItem(1)], meta: { total: 1, page: 1, per_page: MODERATION_PER_PAGE } }));

    await renderOrRedirect(() => AdminModerationPage({ searchParams: Promise.resolve({ page: raw }) }));

    expect(apiQueryOf().page).toBe('1');
  });

  it.each(INVALID_PAGE_PARAMS)('ユーザーの一覧: page=%j は API に page=1 を送る', async (raw) => {
    adminFetch.mockResolvedValue(jsonResponse({ data: [listUser(1)], meta: { total: 1, page: 1, per_page: USERS_PER_PAGE } }));

    await renderOrRedirect(() => AdminUsersPage({ searchParams: Promise.resolve({ page: raw }) }));

    expect(apiQueryOf().page).toBe('1');
  });

  it('1 以上の整数の page はそのまま送る', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ data: [moderationItem(31)], meta: { total: 31, page: 2, per_page: MODERATION_PER_PAGE } }));

    await renderOrRedirect(() => AdminModerationPage({ searchParams: Promise.resolve({ page: '2' }) }));

    expect(apiQueryOf().page).toBe('2');
  });
});

describe('#2093 W8 parsePageParam (URL の page の読み方)', () => {
  it.each(INVALID_PAGE_PARAMS)('page=%j は最初のページ (1)', (raw) => {
    expect(parsePageParam(raw)).toBe(FIRST_PAGE);
  });

  it('page が無いときは最初のページ (1)', () => {
    expect(parsePageParam(undefined)).toBe(FIRST_PAGE);
  });

  it.each([
    ['1', 1],
    ['2', 2],
    ['10', 10],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])('page=%j は %d', (raw, expected) => {
    expect(parsePageParam(raw)).toBe(expected);
  });
});

describe('#2093 W8 審査の一覧: 件数より後ろのページなら最後のページへ移す', () => {
  it('未審査の 3 ページ目が空で件数 31 なら、絞り込みを保ったまま最後のページ (2) へ移す', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ data: [], meta: { total: 31, page: 3, per_page: MODERATION_PER_PAGE } }));

    const { redirectedTo } = await renderOrRedirect(() =>
      AdminModerationPage({ searchParams: Promise.resolve({ status: 'pending', type: 'food', page: '3' }) }),
    );

    expect(redirectedTo).not.toBeNull();
    expect(locationOf(redirectedTo ?? '')).toEqual({
      pathname: '/admin/moderation',
      query: { status: 'pending', type: 'food', page: '2' },
    });
  });

  it('全タイプ (type が空) の絞り込みも落とさずに移す', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ data: [], meta: { total: 5, page: 4, per_page: MODERATION_PER_PAGE } }));

    const { redirectedTo } = await renderOrRedirect(() =>
      AdminModerationPage({ searchParams: Promise.resolve({ status: 'escalated', page: '4' }) }),
    );

    expect(locationOf(redirectedTo ?? '')).toEqual({
      pathname: '/admin/moderation',
      query: { status: 'escalated', type: '', page: '1' },
    });
  });

  it('読めた 0 件の 1 ページ目 (最後のページ以内) は移さず、0 件の文を出す', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ data: [], meta: { total: 0, page: 1, per_page: MODERATION_PER_PAGE } }));

    const { redirectedTo, page } = await renderOrRedirect(() => AdminModerationPage({ searchParams: Promise.resolve({}) }));

    expect(redirectedTo).toBeNull();
    expect(page?.textContent ?? '').toContain(MODERATION_EMPTY_PENDING_TEXT);
  });

  it('行があるページは移さない', async () => {
    adminFetch.mockResolvedValue(jsonResponse({ data: [moderationItem(31)], meta: { total: 31, page: 2, per_page: MODERATION_PER_PAGE } }));

    const { redirectedTo } = await renderOrRedirect(() => AdminModerationPage({ searchParams: Promise.resolve({ page: '2' }) }));

    expect(redirectedTo).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each(LIST_FAILURES)('%s ときは移さない (失敗を、何も知らせずにページを移す動きに変えない)', async (_label, arrange) => {
    arrange();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { redirectedTo } = await renderOrRedirect(() => AdminModerationPage({ searchParams: Promise.resolve({ page: '5' }) }));

    expect(redirectedTo).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });
});
