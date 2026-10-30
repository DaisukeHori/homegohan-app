/**
 * #2107 (triage-1030c) Y10 のテスト: ユーザーの一覧 (/admin/users) の絞り込みの select の選択肢
 *
 * 以前: select の選択肢を画面に手で書いていた (全ステータス・アクティブ・BAN 済みの 3 つ)。URL の status は
 * parseUserListStatusParam が API の一覧 (USER_LIST_STATUSES = active / banned / deleted) で読むので ?status=deleted を通すが、
 * 合う選択肢が無いため select は一番上の「全ステータス」を示し、そのまま「検索」を押すと status が空 (全ステータス) で送られていた。
 *
 * 直したあと:
 *  - 選択肢は「全ステータス」(空) と USER_LIST_STATUSES から作る。表示名は USER_LIST_STATUS_LABELS (Record<UserListStatus, string>) で、
 *    英字の内部の値 (active など) を出さない
 *  - ?status=deleted なら select は「削除済み」を示し、そのまま送っても status=deleted のまま
 *  - 削除済みの一覧は常に 0 件 (退会で user_profiles の行が消えるため。API の絞り込みは tests/admin-users-status-filter.test.ts と
 *    tests/integration/operator/admin-users.test.ts)。0 件の文は「ユーザーが見つかりません」でなく、削除済みのユーザーが一覧に出ない理由を出す
 *
 * 画面 (async の Server Component) は renderToStaticMarkup で描く (tests/admin-list-status-param-2101.test.tsx と同じ形)。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireRoleForPage = vi.hoisted(() => vi.fn());
const adminFetch = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ redirect, notFound: vi.fn() }));
vi.mock('@/lib/auth/page-guard', () => ({ requireRoleForPage }));
vi.mock('@/lib/admin/fetch', () => ({ adminFetch }));

const { default: AdminUsersPage } = await import('@/app/admin/users/page');
const {
  USER_LIST_ALL_STATUSES,
  USER_LIST_ALL_STATUSES_LABEL,
  USER_LIST_DELETED_EMPTY_MESSAGE,
  USER_LIST_STATUSES,
  USER_LIST_STATUS_LABELS,
} = await import('@/lib/admin/users-schemas');

const adminActor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['admin'], email: 'admin@example.com' };

/** ユーザーの一覧の 1 ページの件数 (画面の perPage と同じ) */
const USERS_PER_PAGE = 50;
const HTTP_OK = 200;
/** 0 件のときの文 (削除済み以外の絞り込み) */
const USERS_EMPTY_TEXT = 'ユーザーが見つかりません';
/** 英字の内部の値 (active など) だけでできた表示名 */
const ASCII_ONLY = /^[\x20-\x7e]*$/;

function jsonResponse(body: unknown) {
  return { ok: true, status: HTTP_OK, json: () => Promise.resolve(body) };
}

function listBody(rows: number) {
  return {
    data: Array.from({ length: rows }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      email: null,
      nickname: `利用者${i + 1}`,
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
    })),
    meta: { total: rows, page: 1, per_page: USERS_PER_PAGE },
  };
}

async function renderUsers(searchParams: Record<string, string>): Promise<HTMLDivElement> {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(await AdminUsersPage({ searchParams: Promise.resolve(searchParams) }));
  document.body.appendChild(host);
  return host;
}

function statusSelect(page: HTMLElement): HTMLSelectElement {
  const select = page.querySelector<HTMLSelectElement>('select[name="status"]');
  if (!select) throw new Error('絞り込みの status の select がありません');
  return select;
}

/** 「検索」をそのまま押したときに送る status (form の今の値) */
function submittedStatus(page: HTMLElement): FormDataEntryValue | null {
  const form = statusSelect(page).form;
  if (!form) throw new Error('status の select が form の中にありません');
  return new FormData(form).get('status');
}

/** adminFetch に渡した URL の query (最初の呼び出し) */
function apiQuery(): Record<string, string> {
  const url = new URL(String(adminFetch.mock.calls[0]?.[0]), 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  requireRoleForPage.mockResolvedValue(adminActor);
  adminFetch.mockResolvedValue(jsonResponse(listBody(1)));
});

describe('#2107 Y10 ユーザーの一覧 (/admin/users) の絞り込みの select', () => {
  it('?status=deleted なら select は「削除済み」を示し、そのまま送っても status=deleted のまま (全ステータスに戻らない)', async () => {
    adminFetch.mockResolvedValue(jsonResponse(listBody(0)));
    const page = await renderUsers({ status: 'deleted' });
    expect(apiQuery().status).toBe('deleted');
    const select = statusSelect(page);
    expect(select.value).toBe('deleted');
    expect(select.selectedOptions[0]?.textContent).toBe('削除済み');
    expect(submittedStatus(page)).toBe('deleted');
  });

  it.each(USER_LIST_STATUSES.map((s) => [s]))('URL の status (%s) は、select の選択と送る値がそのまま同じ値になる', async (status) => {
    const page = await renderUsers({ status });
    expect(statusSelect(page).value).toBe(status);
    expect(statusSelect(page).selectedOptions[0]?.textContent).toBe(USER_LIST_STATUS_LABELS[status]);
    expect(submittedStatus(page)).toBe(status);
  });

  it('空の status (「全ステータス」) は「全ステータス」を示し、空のまま送る', async () => {
    const page = await renderUsers({ status: USER_LIST_ALL_STATUSES });
    expect(statusSelect(page).value).toBe(USER_LIST_ALL_STATUSES);
    expect(statusSelect(page).selectedOptions[0]?.textContent).toBe(USER_LIST_ALL_STATUSES_LABEL);
    expect(submittedStatus(page)).toBe(USER_LIST_ALL_STATUSES);
  });

  it('選択肢は「全ステータス」と USER_LIST_STATUSES の全部 (この順)。表示名はすべて日本語で、英字の内部の値を出さない', async () => {
    const page = await renderUsers({});
    const options = Array.from(statusSelect(page).options);
    expect(options.map((o) => o.value)).toEqual([USER_LIST_ALL_STATUSES, ...USER_LIST_STATUSES]);
    expect(options.map((o) => o.textContent)).toEqual([
      USER_LIST_ALL_STATUSES_LABEL,
      ...USER_LIST_STATUSES.map((s) => USER_LIST_STATUS_LABELS[s]),
    ]);
    expect(options.map((o) => o.textContent)).toContain('削除済み');
    for (const option of options) {
      const label = option.textContent ?? '';
      expect(label, `選択肢 ${option.value} の表示名`).not.toBe('');
      expect(label, `選択肢 ${option.value} の表示名`).not.toMatch(ASCII_ONLY);
    }
    // 状態の選択肢の表示名に、内部の値 (active / banned / deleted) をそのまま入れない
    for (const status of USER_LIST_STATUSES) {
      expect(USER_LIST_STATUS_LABELS[status], `${status} の表示名`).not.toContain(status);
    }
  });

  it('削除済みの 0 件は「ユーザーが見つかりません」でなく、削除済みのユーザーが一覧に出ない理由を出す', async () => {
    adminFetch.mockResolvedValue(jsonResponse(listBody(0)));
    const page = await renderUsers({ status: 'deleted' });
    expect(page.textContent).toContain(USER_LIST_DELETED_EMPTY_MESSAGE);
    expect(page.textContent).not.toContain(USERS_EMPTY_TEXT);
  });

  it.each(['active', 'banned', USER_LIST_ALL_STATUSES])('削除済み以外 (%j) の 0 件は、今までどおり「ユーザーが見つかりません」', async (status) => {
    adminFetch.mockResolvedValue(jsonResponse(listBody(0)));
    const page = await renderUsers({ status });
    expect(page.textContent).toContain(USERS_EMPTY_TEXT);
    expect(page.textContent).not.toContain(USER_LIST_DELETED_EMPTY_MESSAGE);
  });
});
