/**
 * 組織の管理画面 (Web) のうち、組織のメンバー全員を読む 2 画面の表示テスト
 *   - /org/members                      組織メンバー一覧 (除名・脱退)
 *   - /org/settings/owner-transfer      オーナー譲渡の候補一覧
 *
 * 不具合: どちらも、ブラウザの Supabase クライアントで user_profiles を組織の id で絞って読んでいた。
 * user_profiles の SELECT ポリシーは「本人の行だけ」(Users can view own profile) で、他のメンバーの行は読めない。
 * そのため、メンバー一覧は組織に何人いても自分 1 人になり (他の人を除名するボタンも出ず)、
 * オーナー譲渡の候補は (自分を除くので) いつも空で、「譲渡可能なメンバーがいません」になっていた。
 * 修正後は、組織の管理者かを確認したあとに所属組織のメンバー全員を返す GET /api/org/members から読む。
 *
 * このテストのブラウザ用 Supabase クライアントは RLS の結果を再現する: user_profiles は本人の行しか返さない。
 * -> 画面が user_profiles で一覧を読んだら、表示が 1 人 (または 0 人) になってテストが失敗する。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  /** ブラウザの Supabase クライアントで読んだテーブルと絞り込み */
  reads: [] as Array<{ table: string; filters: Array<[string, string, unknown]> }>,
  /** ログイン中のユーザーと、その人に RLS で見える user_profiles の行 (本人の行だけ) */
  session: { userId: 'u-owner', visibleProfiles: [] as Row[] },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace, back: mocks.back }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: mocks.session.userId } }, error: null }) },
    from: (table: string) => {
      const read = { table, filters: [] as Array<[string, string, unknown]> };
      mocks.reads.push(read);
      const run = () =>
        table === 'user_profiles'
          ? mocks.session.visibleProfiles.filter((row) =>
              read.filters.every(([op, column, value]) => (op === 'eq' ? row[column] === value : row[column] !== value)),
            )
          : [];
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.order = () => query;
      query.eq = (column: string, value: unknown) => {
        read.filters.push(['eq', column, value]);
        return query;
      };
      query.neq = (column: string, value: unknown) => {
        read.filters.push(['neq', column, value]);
        return query;
      };
      query.single = async () => {
        const rows = run();
        return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } };
      };
      query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(resolve, reject);
      return query;
    },
  }),
}));

const { default: MembersPage } = await import('@/app/(org)/org/members/page');
const { default: OwnerTransferPage } = await import('@/app/(org)/org/settings/owner-transfer/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─────────────────────────────────────────────────────────────────────────────
// 道具
// ─────────────────────────────────────────────────────────────────────────────

const ORG = 'org-1';

/** GET /api/org/members が返す行 (created_at の新しい順。参加日の無い人は新しい順の先頭) */
const API_MEMBERS: Row[] = [
  { id: 'u-member2', nickname: '田中メンバー', roles: ['user'], org_role: 'member', joined_org_at: null, created_at: '2026-04-01T00:00:00Z' },
  { id: 'u-member1', nickname: '鈴木メンバー', roles: ['user'], org_role: 'member', joined_org_at: '2026-03-01', created_at: '2026-03-01T00:00:00Z' },
  { id: 'u-admin', nickname: '佐藤管理者', roles: ['user'], org_role: 'admin', joined_org_at: '2026-02-01', created_at: '2026-02-01T00:00:00Z' },
  { id: 'u-owner', nickname: '山田オーナー', roles: ['user'], org_role: 'owner', joined_org_at: '2026-01-01', created_at: '2026-01-01T00:00:00Z' },
];

/** ログインしたユーザーの設定。本人の行だけが RLS で見える */
function loginAs(userId: string, orgRole: 'owner' | 'admin' | 'member' | null = 'owner') {
  mocks.session.userId = userId;
  mocks.session.visibleProfiles = [
    { id: userId, nickname: `own-${userId}`, org_role: orgRole, organization_id: orgRole ? ORG : null, joined_org_at: '2026-01-01' },
  ];
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let membersResponse: () => ReturnType<typeof jsonResponse>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let alertSpy: ReturnType<typeof vi.spyOn>;
let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.push.mockReset();
  mocks.replace.mockReset();
  mocks.back.mockReset();
  mocks.reads.length = 0;
  loginAs('u-owner', 'owner');

  membersResponse = () => jsonResponse({ members: API_MEMBERS });
  fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
    if (input === '/api/org/members' && (init?.method ?? 'GET') === 'GET') return membersResponse();
    if (typeof input === 'string' && /^\/api\/org\/members\/[^/]+\/remove$/.test(input)) return jsonResponse({ ok: true });
    if (input === '/api/org/owner-transfer/propose') return jsonResponse({ proposal_id: 'p-1' });
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => true);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  consoleErrorSpy.mockRestore();
  alertSpy.mockRestore();
  confirmSpy.mockRestore();
  vi.unstubAllGlobals();
});

/** 条件が満たされるまで待つ (非同期の読み込みが終わるのを待つ) */
async function until(condition: () => boolean, what: string) {
  const startedAt = performance.now();
  while (!condition()) {
    if (performance.now() - startedAt > 3000) throw new Error(`待ちきれませんでした: ${what}\n${container.textContent}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const text = () => container.textContent ?? '';
const spinnerGone = () => container.querySelector('.animate-spin') === null;
const listCalls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/org/members');
/** user_profiles を組織の id などで絞って、一覧として読んでいないこと。読んでよいのは本人の行 (id = 自分) だけ */
const profileListReads = () =>
  mocks.reads.filter(
    (read) => read.table === 'user_profiles' && !read.filters.some(([op, column]) => op === 'eq' && column === 'id'),
  );

async function renderPage(page: 'members' | 'owner-transfer') {
  await act(async () => {
    root.render(page === 'members' ? <MembersPage /> : <OwnerTransferPage />);
  });
  await until(spinnerGone, '読み込みの完了');
}

const memberRows = () =>
  Array.from(container.querySelectorAll('tbody tr')).map((row) => row.textContent ?? '');
const buttons = (label: string) =>
  Array.from(container.querySelectorAll('button')).filter((button) => button.textContent === label);

// ─────────────────────────────────────────────────────────────────────────────
// 組織メンバー一覧 (/org/members)
// ─────────────────────────────────────────────────────────────────────────────

describe('/org/members: 組織メンバー一覧', () => {
  it('GET /api/org/members から読み、組織のメンバー全員 (4 人) を出す。自分 1 人にならない', async () => {
    await renderPage('members');

    expect(listCalls()).toHaveLength(1);
    expect(text()).toContain('組織メンバー (4 名)');
    expect(memberRows()).toHaveLength(4);
    for (const name of ['山田オーナー', '佐藤管理者', '鈴木メンバー', '田中メンバー']) {
      expect(text()).toContain(name);
    }
  });

  it('メンバー一覧を、ブラウザの Supabase クライアントで user_profiles から読まない (読むのは自分のプロフィールだけ)', async () => {
    await renderPage('members');

    expect(profileListReads()).toEqual([]);
    expect(mocks.reads.filter((read) => read.table === 'user_profiles').length).toBeGreaterThan(0);
  });

  it('参加日の古い順に並べ、参加日の無い人は最後。役割のラベルも出る', async () => {
    await renderPage('members');

    const rows = memberRows();
    expect(rows[0]).toContain('山田オーナー');
    expect(rows[0]).toContain('オーナー');
    expect(rows[1]).toContain('佐藤管理者');
    expect(rows[1]).toContain('管理者');
    expect(rows[2]).toContain('鈴木メンバー');
    expect(rows[3]).toContain('田中メンバー');
    expect(rows[3]).toContain('-');
  });

  it('自分には「(あなた)」と出る', async () => {
    await renderPage('members');

    expect(memberRows()[0]).toContain('(あなた)');
    expect(memberRows().filter((row) => row.includes('(あなた)'))).toHaveLength(1);
  });

  it('オーナーには、自分とオーナー以外の全員 (管理者・メンバー 2 人) を除名するボタンが出る', async () => {
    await renderPage('members');

    expect(buttons('除名')).toHaveLength(3);
    const rowsWithButton = memberRows().filter((row) => row.includes('除名'));
    expect(rowsWithButton.some((row) => row.includes('山田オーナー'))).toBe(false);
    expect(rowsWithButton.some((row) => row.includes('佐藤管理者'))).toBe(true);
  });

  it('管理者には、一般メンバーだけを除名するボタンが出る (オーナー・他の管理者・自分には出ない)', async () => {
    loginAs('u-admin', 'admin');

    await renderPage('members');

    expect(buttons('除名')).toHaveLength(2);
    const rowsWithButton = memberRows().filter((row) => row.includes('除名'));
    expect(rowsWithButton.every((row) => row.includes('メンバー'))).toBe(true);
    expect(text()).not.toContain('オーナーを譲渡');
    expect(text()).toContain('組織を脱退');
  });

  it('除名すると POST /api/org/members/{id}/remove を呼び、一覧を取り直す', async () => {
    await renderPage('members');

    const target = memberRows().findIndex((row) => row.includes('鈴木メンバー'));
    await act(async () => {
      (container.querySelectorAll('tbody tr')[target].querySelector('button') as HTMLButtonElement).click();
    });
    await until(() => listCalls().length === 2, '除名後の一覧の取り直し');

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const removal = fetchMock.mock.calls.find(([url]) => url === '/api/org/members/u-member1/remove');
    expect(removal?.[1]).toEqual({ method: 'POST' });
  });

  it('一覧の取得に失敗したら、エラーを出す。「メンバーがいません」とは出さない', async () => {
    membersResponse = () => jsonResponse({ error: 'Internal server error' }, 500);

    await renderPage('members');

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('メンバー一覧を取得できませんでした');
    expect(text()).not.toContain('メンバーがいません');
    expect(buttons('除名')).toHaveLength(0);
  });

  it('通信そのものが失敗しても、同じエラーを出す', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await renderPage('members');

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('メンバー一覧を取得できませんでした');
  });

  it('本当にメンバーが 0 人のときだけ「メンバーがいません」と出す', async () => {
    membersResponse = () => jsonResponse({ members: [] });

    await renderPage('members');

    expect(text()).toContain('メンバーがいません');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('組織に所属していない人には、一覧を取りに行かない', async () => {
    loginAs('u-outsider', null);

    await renderPage('members');

    expect(listCalls()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// オーナー譲渡の候補一覧 (/org/settings/owner-transfer)
// ─────────────────────────────────────────────────────────────────────────────

describe('/org/settings/owner-transfer: オーナー譲渡の候補', () => {
  const candidateLabels = () => Array.from(container.querySelectorAll('label')).filter((label) => label.querySelector('input[type="radio"]'));

  it('GET /api/org/members から読み、自分とオーナーを除いた全員 (管理者・メンバー 2 人) を候補に出す。「譲渡可能なメンバーがいません」にならない', async () => {
    await renderPage('owner-transfer');

    expect(listCalls()).toHaveLength(1);
    expect(text()).not.toContain('譲渡可能なメンバーがいません');
    const labels = candidateLabels().map((label) => label.textContent ?? '');
    expect(labels).toHaveLength(3);
    expect(labels.some((label) => label.includes('山田オーナー'))).toBe(false);
    // 参加日の古い順 (参加日の無い人は最後)
    expect(labels[0]).toContain('佐藤管理者');
    expect(labels[1]).toContain('鈴木メンバー');
    expect(labels[2]).toContain('田中メンバー');
  });

  it('候補を、ブラウザの Supabase クライアントで user_profiles から読まない (読むのは自分のプロフィールだけ)', async () => {
    await renderPage('owner-transfer');

    expect(profileListReads()).toEqual([]);
  });

  it('候補を選んで「譲渡を提案」すると、組織と選んだ人を指定して propose API を呼び、メンバー一覧へ戻る', async () => {
    await renderPage('owner-transfer');

    await act(async () => {
      (container.querySelector('input[type="radio"][value="u-admin"]') as HTMLInputElement).click();
    });
    await act(async () => {
      (container.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    });
    await until(() => mocks.push.mock.calls.length > 0, '提案後の画面遷移');

    const proposal = fetchMock.mock.calls.find(([url]) => url === '/api/org/owner-transfer/propose');
    expect(proposal?.[1]?.method).toBe('POST');
    expect(JSON.parse(proposal?.[1]?.body)).toEqual({ organization_id: ORG, to_user_id: 'u-admin', reason: null });
    expect(mocks.push).toHaveBeenCalledWith('/org/members');
  });

  it('オーナーでない人は、メンバー一覧へ戻す。一覧は取りに行かない', async () => {
    loginAs('u-admin', 'admin');

    await act(async () => {
      root.render(<OwnerTransferPage />);
    });
    await until(() => mocks.push.mock.calls.length > 0, '画面遷移');

    expect(mocks.push).toHaveBeenCalledWith('/org/members');
    expect(listCalls()).toHaveLength(0);
  });

  it('一覧の取得に失敗したら、取得できなかったと出す。「譲渡可能なメンバーがいません」とは出さない', async () => {
    membersResponse = () => jsonResponse({ error: 'Internal server error' }, 500);

    await renderPage('owner-transfer');

    expect(text()).toContain('メンバー一覧を取得できませんでした');
    expect(text()).not.toContain('譲渡可能なメンバーがいません');
  });

  it('自分とオーナーしかいない組織では、「譲渡可能なメンバーがいません」と出す', async () => {
    membersResponse = () => jsonResponse({ members: [API_MEMBERS[3]] });

    await renderPage('owner-transfer');

    expect(text()).toContain('譲渡可能なメンバーがいません');
  });
});
