/**
 * #2120 W3-1 のテスト (画面): 運営の利用者の一覧 (/admin/users) と詳細 (/admin/users/{id}) のロールの札を、
 * 英字の内部の値 (super_admin など) ではなく日本語の表示名 (OPERATOR_ROLE_LABELS) で出すこと。
 *
 * 以前は font-mono の札に {role} をそのまま出していた (同じ画面のプラン・ステータスは #2112 Z3 で日本語になっていた)。
 * 表に無い値 (将来の値・壊れた応答) は内部の値をそのまま出す (知らない値を隠さない)。roles が配列でなければ user として出す。
 * どの札も title に内部の値を持つ (運営が内部の値を確かめられる)。
 *
 * サーバーの画面 (async の Server Component) を renderToStaticMarkup で描き、assert は画面に出た文字 (葉の要素の文字) を見る
 * (tests/admin-english-labels-2112.test.tsx と同じ形)。
 */
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireRoleForPage = vi.hoisted(() => vi.fn());
const adminFetch = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/users',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));
vi.mock('@/lib/auth/page-guard', () => ({ requireRoleForPage }));
vi.mock('@/lib/admin/fetch', () => ({ adminFetch }));

const { OPERATOR_ROLE_LABELS } = await import('@/lib/admin/operator-role-labels');
const { default: AdminUsersPage } = await import('@/app/admin/users/page');
const { default: AdminUserDetailPage } = await import('@/app/admin/users/[id]/page');

const HTTP_OK = 200;
const HTTP_OK_END = 300;
const USERS_PER_PAGE = 50;
const adminActor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['admin'], email: 'admin@example.com' };
const ROW_ID = '00000000-0000-4000-8000-000000000001';
/** 表に無い値 (将来の値・壊れた応答)。表示名が無いのでそのまま出す */
const UNKNOWN_ROLE = 'brand_new_role';
/** 一覧・詳細で出すロール (運営のロール・組織のロール・一般) */
const SHOWN_ROLES = ['super_admin', 'admin', 'support', 'org_industrial_doctor', 'user'] as const;

/** adminFetch (サーバーの画面) の応答の形 */
function adminJson(body: unknown, status = HTTP_OK) {
  return { ok: status >= HTTP_OK && status < HTTP_OK_END, status, json: () => Promise.resolve(body) };
}

/** 子の要素を持たない要素 (札・セル) の文字の一覧 */
function leafTexts(host: ParentNode): string[] {
  return Array.from(host.querySelectorAll('*'))
    .filter((el) => el.children.length === 0)
    .map((el) => el.textContent?.trim() ?? '')
    .filter((text) => text !== '');
}

/** title を持つ札の、title (内部の値) と文字 (表示名) の組 */
function roleBadges(host: ParentNode): Array<[string, string]> {
  return Array.from(host.querySelectorAll('span[title]')).map((el) => [el.getAttribute('title') ?? '', el.textContent?.trim() ?? '']);
}

async function renderServer(element: ReactElement | Promise<ReactElement>): Promise<HTMLDivElement> {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(await element);
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  requireRoleForPage.mockResolvedValue(adminActor);
});

// ─── 利用者の一覧 (/admin/users) ───────────────────────────────────────────────

describe('#2120 W3-1 運営の利用者の一覧 (/admin/users) のロールの列', () => {
  function userRow(n: number, roles: unknown) {
    return {
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      email: null,
      nickname: `利用者${n}`,
      plan_key: 'free',
      roles,
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

  async function renderUsers(rows: unknown[]) {
    adminFetch.mockResolvedValue(adminJson({ data: rows, meta: { total: rows.length, page: 1, per_page: USERS_PER_PAGE } }));
    const page = await renderServer(AdminUsersPage({ searchParams: Promise.resolve({ status: '' }) }));
    const body = page.querySelector('tbody');
    if (!body) throw new Error('一覧の表がありません');
    return body;
  }

  it('ロールの札は日本語の表示名 (英字の内部の値を出さない)。title に内部の値を持つ', async () => {
    const body = await renderUsers([userRow(1, ['super_admin', 'admin']), userRow(2, ['support', 'org_industrial_doctor', 'user'])]);
    const texts = leafTexts(body);
    expect(texts).toContain('運営最上位');
    expect(texts).toContain('運営管理者');
    expect(texts).toContain('サポート');
    expect(texts).toContain('産業医');
    expect(texts).toContain('一般ユーザー');
    for (const role of SHOWN_ROLES) {
      expect(texts).toContain(OPERATOR_ROLE_LABELS[role]);
      expect(texts).not.toContain(role);
    }
    expect(roleBadges(body)).toEqual(SHOWN_ROLES.map((role) => [role, OPERATOR_ROLE_LABELS[role]]));
  });

  it('表に無いロールはそのまま出す・roles が配列でなければ一般ユーザー', async () => {
    const body = await renderUsers([userRow(1, [UNKNOWN_ROLE]), userRow(2, null)]);
    const texts = leafTexts(body);
    expect(texts).toContain(UNKNOWN_ROLE);
    expect(texts).toContain('一般ユーザー');
    expect(texts).not.toContain('user');
  });
});

// ─── 利用者の詳細 (/admin/users/{id}) ─────────────────────────────────────────

describe('#2120 W3-1 運営の利用者の詳細 (/admin/users/{id}) のロール', () => {
  function routeDetail(roles: unknown) {
    adminFetch.mockImplementation(async (path: string) => {
      if (path === `/api/admin/users/${ROW_ID}`) {
        return adminJson({
          data: {
            id: ROW_ID,
            email: 'target@example.com',
            nickname: '対象さん',
            roles,
            plan_key: 'pro',
            is_banned: false,
            frozen_at: null,
            frozen_reason: null,
            last_login_at: null,
            registered_at: '2026-01-01T00:00:00+00:00',
            active_subscription: null,
            ban_history: [],
          },
        });
      }
      if (path === `/api/admin/users/${ROW_ID}/login-history`) return adminJson({ data: { entries: [] } });
      throw new Error(`想定外の adminFetch(${path})`);
    });
  }

  /** 「ロール」の dt に続く dd */
  function roleCell(page: HTMLDivElement): HTMLElement {
    const dt = Array.from(page.querySelectorAll('dt')).find((el) => el.textContent?.trim() === 'ロール');
    const dd = dt?.nextElementSibling;
    if (!(dd instanceof HTMLElement)) throw new Error('ロールの欄がありません');
    return dd;
  }

  it('ロールの札は日本語の表示名 (英字の内部の値を出さない)。title に内部の値を持つ', async () => {
    routeDetail([...SHOWN_ROLES]);
    const page = await renderServer(AdminUserDetailPage({ params: Promise.resolve({ id: ROW_ID }) }));
    const cell = roleCell(page);
    expect(leafTexts(cell)).toEqual(SHOWN_ROLES.map((role) => OPERATOR_ROLE_LABELS[role]));
    expect(leafTexts(cell)).toEqual(['運営最上位', '運営管理者', 'サポート', '産業医', '一般ユーザー']);
    expect(roleBadges(cell)).toEqual(SHOWN_ROLES.map((role) => [role, OPERATOR_ROLE_LABELS[role]]));
  });

  it('表に無いロールはそのまま出す・roles が配列でなければ一般ユーザー', async () => {
    routeDetail([UNKNOWN_ROLE, 'finance']);
    const unknownPage = await renderServer(AdminUserDetailPage({ params: Promise.resolve({ id: ROW_ID }) }));
    expect(leafTexts(roleCell(unknownPage))).toEqual([UNKNOWN_ROLE, '経理']);

    document.body.innerHTML = '';
    routeDetail(null);
    const nullPage = await renderServer(AdminUserDetailPage({ params: Promise.resolve({ id: ROW_ID }) }));
    expect(leafTexts(roleCell(nullPage))).toEqual(['一般ユーザー']);
  });
});
