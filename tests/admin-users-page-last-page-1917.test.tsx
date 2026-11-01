/**
 * #1917 /admin/users (Server Component) の「件数より後ろのページなら最後のページへ移す」redirect のテスト
 *
 * 一覧の API は、件数より後ろのページを失敗にせず、空のページと本当の件数で返す (src/lib/api/list-range.ts)。
 * 画面はそれを「0 件です」と見せずに、件数から最後のページへ redirect する (src/lib/list-pagination.ts)。
 *
 * 確かめる不変条件:
 *  - 200 の空のページと本当の件数のときだけ、最後のページへ redirect する (今のページより後ろが空でも、最後のページの番号へ)
 *  - redirect の URL は、絞り込み (q と status) を落とさない。status が空 (全ステータス) でも status= を付ける
 *    (付けないと次の読み込みで既定の active に戻り、全ステータスの一覧が active だけの一覧に変わる。R1 で見つかった)
 *  - API の失敗 (res.ok が false)・fetch の例外のときは redirect しない (失敗を、何も知らせずにページを移す動きに変えない。R1 で見つかった)
 *  - 行があるページ・最後のページ以内のページは redirect しない
 *
 * tests/admin-user-login-history-page.test.tsx と同じ形: 入口 (requireRoleForPage) と adminFetch を mock する。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireRoleForPage = vi.hoisted(() => vi.fn());
const adminFetch = vi.hoisted(() => vi.fn());
/** Next の redirect と同じく例外で抜ける (呼ばれた先の URL を例外の文に入れる) */
const REDIRECT_ERROR_PREFIX = 'NEXT_REDIRECT:';
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ redirect, notFound: vi.fn(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/auth/page-guard', () => ({ requireRoleForPage }));
vi.mock('@/lib/admin/fetch', () => ({ adminFetch }));

const { default: AdminUsersPage } = await import('@/app/admin/users/page');

/** 画面の 1 ページの件数 (src/app/admin/users/page.tsx の perPage と同じ) */
const PER_PAGE = 50;
const HTTP_OK = 200;
const HTTP_INTERNAL_ERROR = 500;

const adminActor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['admin'], email: 'admin@example.com' };

function user(n: number) {
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

function listResponse(rows: unknown[], total: number, page: number): Response {
  return new Response(JSON.stringify({ data: rows, meta: { total, page, per_page: PER_PAGE } }), {
    status: HTTP_OK,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 画面を呼び、redirect されたらその URL を、されなければ null を返す */
async function redirectedTo(searchParams: { q?: string; status?: string; page?: string }): Promise<string | null> {
  try {
    const element = await AdminUsersPage({ searchParams: Promise.resolve(searchParams) });
    // redirect しないときは、画面として描ける (失敗の扱いの途中で例外を投げていない)
    renderToStaticMarkup(element);
    return null;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(REDIRECT_ERROR_PREFIX)) {
      return err.message.slice(REDIRECT_ERROR_PREFIX.length);
    }
    throw err;
  }
}

/** redirect の URL の query を読む */
function queryOf(url: string): Record<string, string> {
  const parsed = new URL(url, 'http://localhost');
  expect(parsed.pathname).toBe('/admin/users');
  return Object.fromEntries(parsed.searchParams.entries());
}

beforeEach(() => {
  requireRoleForPage.mockReset();
  requireRoleForPage.mockResolvedValue(adminActor);
  adminFetch.mockReset();
  redirect.mockClear();
});

describe('/admin/users の件数より後ろのページ (#1917)', () => {
  it('全ステータス (status が空) の 5 ページ目が空で件数 60 なら、status= を付けたまま最後のページ (2) へ移す', async () => {
    adminFetch.mockResolvedValue(listResponse([], 60, 5));
    const url = await redirectedTo({ q: '', status: '', page: '5' });
    expect(url).not.toBeNull();
    expect(queryOf(url!)).toEqual({ q: '', status: '', page: '2' });
    // 読みに行った API は全ステータス (status を付けない) の 5 ページ目
    const apiPath = String(adminFetch.mock.calls[0]?.[0]);
    expect(apiPath).toContain('page=5');
    expect(apiPath).not.toContain('status=');
  });

  it('既定 (active) の 3 ページ目が空で件数 50 なら、3 の手前の 2 ではなく最後のページ (1) へ移す', async () => {
    adminFetch.mockResolvedValue(listResponse([], 50, 3));
    const url = await redirectedTo({ page: '3' });
    expect(queryOf(url!)).toEqual({ q: '', status: 'active', page: '1' });
  });

  it('検索語と凍結中の絞り込みを落とさずに最後のページへ移す', async () => {
    adminFetch.mockResolvedValue(listResponse([], 120, 9));
    const url = await redirectedTo({ q: '山田', status: 'banned', page: '9' });
    expect(queryOf(url!)).toEqual({ q: '山田', status: 'banned', page: '3' });
  });

  it('API が失敗した (500) ときは redirect しない', async () => {
    adminFetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }), { status: HTTP_INTERNAL_ERROR }));
    expect(await redirectedTo({ page: '3' })).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('fetch が例外を投げたときは redirect しない', async () => {
    adminFetch.mockRejectedValue(new Error('fetch failed'));
    expect(await redirectedTo({ status: '', page: '3' })).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('行があるページは redirect しない', async () => {
    adminFetch.mockResolvedValue(listResponse([user(51)], 51, 2));
    expect(await redirectedTo({ page: '2' })).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('0 件の 1 ページ目 (最後のページ以内) は redirect しない', async () => {
    adminFetch.mockResolvedValue(listResponse([], 0, 1));
    expect(await redirectedTo({ page: '1' })).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });
});
