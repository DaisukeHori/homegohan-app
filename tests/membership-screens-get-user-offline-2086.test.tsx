/**
 * #2086 V3: 承諾・譲渡の画面が、オフラインの getUser ({ user: null, error }) をログイン切れと見なして /login へ移していた。
 * #2086 V10: 家族のメンバーの詳細が、開くメンバーの行を status で絞らず、脱退・除名した行も詳細として開けていた。
 *
 * getUser は通信の失敗を投げずに { data: { user: null }, error } で返す (auth-js の AuthRetryableFetchError)。
 * ログインしていないときも error (AuthSessionMissingError) を返すので、error の種類で分ける:
 *   - 通信の失敗 → 読み込めなかった文と「再試行」 (ログインの画面へ移さない)
 *   - セッションが無い・切れている → これまでどおりログインの画面へ (戻り先の next を付ける)
 * 組織の承諾の画面は、承諾の通信が切れたあとの読み直しでもここを通る (#2064 の「読み直して今の状態を見せる」)。
 *
 * このリポジトリには @testing-library/react が無いため、react-dom/client + act で描画する。
 */
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({
  ME: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  OTHER: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  FAMILY: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66',
  ORG: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55',
  MEMBER: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
  PROPOSAL: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
}));

// 本物の useRouter は同じ参照を返す (毎回作ると useEffect の依存が変わって読み込みが 2 回走る)
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: ids.MEMBER, proposal_id: ids.PROPOSAL }),
  useRouter: () => router,
  usePathname: () => '/org/settings/owner-transfer',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) =>
    createElement('a', { href, ...rest }, children),
}));

vi.mock('@/lib/membership/family-member-names', () => ({
  fetchFamilyMemberNames: async () => [],
  applyFamilyMemberNames: <T,>(members: T[]) => members,
}));

type Result = { data: unknown; error: unknown };
type Filters = Array<[string, unknown]>;
type GetUserResult = { data: { user: unknown }; error: unknown };

const state = vi.hoisted(() => ({
  /** getUser の応答を順に返す (尽きたら最後のものを返し続ける) */
  getUserResults: [] as GetUserResult[],
  getUserCalls: 0,
  /** family_members の開くメンバーの行 (status つき)。status で絞られたら active の行だけを返す */
  memberRow: null as Record<string, unknown> | null,
}));

const NO_ROWS = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };

function rowFor(table: string, columns: string, filters: Filters): Result {
  const filter = (column: string) => filters.find(([c]) => c === column)?.[1];
  switch (table) {
    case 'user_profiles':
      if (columns.includes('org_role')) {
        return {
          data: { org_role: 'owner', organization_id: ids.ORG, organizations: { name: '株式会社テスト', plan: 'standard' } },
          error: null,
        };
      }
      if (columns === 'nickname') return { data: { nickname: '山田花子' }, error: null };
      return { data: { family_id: ids.FAMILY }, error: null };
    case 'ownership_transfer_proposals':
      return {
        data: {
          id: ids.PROPOSAL,
          scope: 'family',
          scope_id: ids.FAMILY,
          from_user_id: ids.OTHER,
          to_user_id: ids.ME,
          status: 'pending',
          proposed_at: '2026-10-01T00:00:00.000Z',
          expires_at: '2999-01-01T00:00:00.000Z',
        },
        error: null,
      };
    case 'organizations':
      return { data: { name: '株式会社テスト' }, error: null };
    case 'family_groups':
      return { data: { name: '山田家' }, error: null };
    case 'family_members': {
      if (columns === 'role') return { data: { role: 'representative' }, error: null };
      const row = state.memberRow;
      if (!row) return { data: null, error: NO_ROWS };
      const statusFilter = filter('status');
      if (statusFilter !== undefined && row.status !== statusFilter) return { data: null, error: NO_ROWS };
      return { data: row, error: null };
    }
    default:
      return { data: null, error: null };
  }
}

function query(table: string) {
  let columns = '';
  const filters: Filters = [];
  const chain = {
    select(selected: string) {
      columns = selected;
      return chain;
    },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    single: async () => rowFor(table, columns, filters),
    maybeSingle: async () => {
      const result = rowFor(table, columns, filters);
      return result.error === NO_ROWS ? { data: null, error: null } : result;
    },
  };
  return chain;
}

const client = vi.hoisted(() => ({
  auth: {
    getUser: async () => {
      const index = Math.min(state.getUserCalls, state.getUserResults.length - 1);
      state.getUserCalls += 1;
      return state.getUserResults[index];
    },
    signOut: async () => ({ error: null }),
  },
  from: (table: string) => query(table),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => client }));

const { default: OrgTransferAcceptPage } = await import('@/app/(main)/org/transfer-accept/[proposal_id]/page');
const { default: FamilyTransferAcceptPage } = await import('@/app/(main)/family/transfer-accept/[proposal_id]/page');
const { default: OwnerTransferPage } = await import('@/app/(org)/org/settings/owner-transfer/page');
const { default: OrgLayout } = await import('@/app/(org)/layout');
const { default: FamilyMemberDetailPage } = await import('@/app/(main)/family/members/[id]/page');
const { default: FamilyPromotePage } = await import('@/app/(main)/family/members/[id]/promote/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** getUser が通信の失敗で返す error (auth-js は投げずに { user: null, error } で返す) */
const AUTH_NETWORK_ERROR = { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' };
/** getUser がログインしていないときに返す error */
const AUTH_SESSION_MISSING = { name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' };

const SIGNED_IN: GetUserResult = { data: { user: { id: ids.ME, email: 'me@example.com' } }, error: null };
const OFFLINE: GetUserResult = { data: { user: null }, error: AUTH_NETWORK_ERROR };
const SIGNED_OUT: GetUserResult = { data: { user: null }, error: AUTH_SESSION_MISSING };
const SIGNED_OUT_NO_ERROR: GetUserResult = { data: { user: null }, error: null };

const PROPOSAL_LOAD_ERROR = '譲渡の提案を読み込めませんでした。しばらくしてから、もう一度お試しください。';
const CANDIDATES_LOAD_ERROR = '譲渡の候補を読み込めませんでした。しばらくしてから、もう一度お試しください。';
const ORG_ADMIN_LOAD_ERROR = '組織の管理画面を開けませんでした。しばらくしてから、もう一度お試しください。';
const MEMBER_DETAIL_LOAD_ERROR = 'メンバーの情報を読み込めませんでした。しばらくしてから、もう一度お試しください。';
const MEMBER_NOT_FOUND_MESSAGE = 'メンバー情報の取得に失敗しました';
const PROMOTE_LOAD_ERROR = '参加リクエストの情報を読み込めませんでした。しばらくしてから、もう一度お試しください。';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(element: ReactElement) {
  await act(async () => {
    root.render(element);
  });
  await flush();
}

function text(): string {
  return container.textContent ?? '';
}

function byTestId(testId: string): string | null {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes(label));
}

async function click(button: HTMLButtonElement | undefined) {
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await flush();
}

/** router.push / replace に /login が渡されたか */
function pushedLogin(): string[] {
  return [...router.push.mock.calls, ...router.replace.mock.calls]
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('/login'));
}

function memberRow(status: 'active' | 'left' | 'removed', role: 'adult' | 'child' = 'adult') {
  return {
    id: ids.MEMBER,
    role,
    display_name: '脱退した人',
    user_id: role === 'child' ? null : ids.OTHER,
    child_profile: null,
    birth_date: null,
    share_meals: true,
    share_health: false,
    share_menu: true,
    joined_at: '2026-10-01T00:00:00.000Z',
    status,
  };
}

beforeEach(() => {
  router.push.mockReset();
  router.replace.mockReset();
  state.getUserResults = [SIGNED_IN];
  state.getUserCalls = 0;
  state.memberRow = memberRow('active');
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ candidates: [] }) });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('alert', () => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
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
  vi.restoreAllMocks();
});

/** 画面ごとの、読み込めなかった文の箱・文・ログインの戻り先 */
const SCREENS = [
  {
    name: '組織のオーナーの譲渡の承諾 (/org/transfer-accept/[proposal_id])',
    element: () => createElement(OrgTransferAcceptPage),
    loadErrorTestId: 'transfer-accept-load-error',
    loadError: PROPOSAL_LOAD_ERROR,
    loginUrl: `/login?next=/org/transfer-accept/${ids.PROPOSAL}`,
  },
  {
    name: '家族の代表者の譲渡の承諾 (/family/transfer-accept/[proposal_id])',
    element: () => createElement(FamilyTransferAcceptPage),
    loadErrorTestId: 'family-transfer-accept-load-error',
    loadError: PROPOSAL_LOAD_ERROR,
    loginUrl: `/login?next=/family/transfer-accept/${ids.PROPOSAL}`,
  },
  {
    name: '組織のオーナーの譲渡の候補 (/org/settings/owner-transfer)',
    element: () => createElement(OwnerTransferPage),
    loadErrorTestId: 'owner-transfer-load-error',
    loadError: CANDIDATES_LOAD_ERROR,
    loginUrl: '/login?next=/org/settings/owner-transfer',
  },
  {
    name: '組織の管理画面の枠 ((org)/layout。オーナーの譲渡の候補の画面を包む)',
    element: () => createElement(OrgLayout, null, createElement('div', null, '中身')),
    loadErrorTestId: 'org-layout-load-error',
    loadError: ORG_ADMIN_LOAD_ERROR,
    loginUrl: '/login',
  },
  {
    name: '家族のメンバーの詳細 (/family/members/[id])',
    element: () => createElement(FamilyMemberDetailPage),
    loadErrorTestId: 'family-member-detail-load-error',
    loadError: MEMBER_DETAIL_LOAD_ERROR,
    loginUrl: `/login?next=${encodeURIComponent(`/family/members/${ids.MEMBER}`)}`,
  },
  {
    name: '家族の子供の昇格の依頼 (/family/members/[id]/promote)',
    element: () => createElement(FamilyPromotePage),
    loadErrorTestId: 'family-promote-load-error',
    loadError: PROMOTE_LOAD_ERROR,
    loginUrl: `/login?next=${encodeURIComponent(`/family/members/${ids.MEMBER}/promote`)}`,
  },
] as const;

describe('#2086 V3 画面を開いたとき getUser が通信の失敗を返したら、ログインの画面へ移さず、読み込めなかった文と「再試行」を出す', () => {
  for (const screen of SCREENS) {
    it(`${screen.name}: 通信の失敗 → 読み込めなかった文 (ログインの画面へ移さない)`, async () => {
      state.getUserResults = [OFFLINE];
      await render(screen.element());

      expect(byTestId(screen.loadErrorTestId)).toContain(screen.loadError);
      expect(pushedLogin()).toEqual([]);
      expect(findButton('再試行')).toBeDefined();
    });

    it(`${screen.name}: 「再試行」で読み直し、通信が戻れば読み込めなかった文を消す`, async () => {
      state.getUserResults = [OFFLINE, SIGNED_IN];
      await render(screen.element());
      await click(findButton('再試行'));

      expect(byTestId(screen.loadErrorTestId)).toBeNull();
      expect(pushedLogin()).toEqual([]);
    });

    it(`${screen.name}: ログインしていない (AuthSessionMissingError) → これまでどおりログインの画面へ (戻り先つき)`, async () => {
      state.getUserResults = [SIGNED_OUT];
      await render(screen.element());

      expect(pushedLogin()).toEqual([screen.loginUrl]);
      expect(byTestId(screen.loadErrorTestId)).toBeNull();
    });

    it(`${screen.name}: user も error も無い → ログインの画面へ`, async () => {
      state.getUserResults = [SIGNED_OUT_NO_ERROR];
      await render(screen.element());

      expect(pushedLogin()).toEqual([screen.loginUrl]);
    });
  }
});

describe('#2086 V3 承諾の通信が切れたあとの読み直しで getUser が通信の失敗を返しても、ログインの画面へ移さない', () => {
  it('組織のオーナーの譲渡の承諾: 承諾の通信が切れ、読み直しの getUser も通信の失敗なら、通信エラーと読み込めなかった文を出す', async () => {
    state.getUserResults = [SIGNED_IN, OFFLINE];
    await render(createElement(OrgTransferAcceptPage));
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await click(findButton('承諾'));

    expect(pushedLogin()).toEqual([]);
    const box = byTestId('transfer-accept-load-error');
    expect(box).toContain('ネットワークエラーが発生しました');
    expect(box).toContain(PROPOSAL_LOAD_ERROR);
  });

  it('家族の代表者の譲渡の承諾: 承諾の通信が切れ、読み直しの getUser も通信の失敗なら、通信エラーと読み込めなかった文を出す', async () => {
    state.getUserResults = [SIGNED_IN, OFFLINE];
    await render(createElement(FamilyTransferAcceptPage));
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await click(findButton('承諾する'));

    expect(pushedLogin()).toEqual([]);
    const box = byTestId('family-transfer-accept-load-error');
    expect(box).toContain('通信エラーが発生しました');
    expect(box).toContain(PROPOSAL_LOAD_ERROR);
  });
});

describe('#2086 V10 家族のメンバーの詳細は、今のメンバー (status = active) の行だけを開く', () => {
  it.each(['left', 'removed'] as const)('開くメンバーの行が %s なら、今のメンバーとして見せず「取得に失敗しました」を出す', async (status) => {
    state.memberRow = memberRow(status);
    await render(createElement(FamilyMemberDetailPage));

    expect(text()).toContain(MEMBER_NOT_FOUND_MESSAGE);
    expect(text()).not.toContain('脱退した人');
    expect(byTestId('family-member-detail-load-error')).toBeNull();
    expect(findButton('外す')).toBeUndefined();
  });

  it('開くメンバーの行が active なら、これまでどおり詳細を出す', async () => {
    state.memberRow = memberRow('active');
    await render(createElement(FamilyMemberDetailPage));

    expect(text()).toContain('脱退した人');
    expect(text()).not.toContain(MEMBER_NOT_FOUND_MESSAGE);
  });

  it.each(['left', 'removed'] as const)(
    '子供の昇格の依頼の画面も、子供の行が %s なら依頼のフォームを出さず「メンバーが見つかりません」を出す (同じ型)',
    async (status) => {
      state.memberRow = memberRow(status, 'child');
      await render(createElement(FamilyPromotePage));

      expect(text()).toContain('メンバーが見つかりません');
      expect(container.querySelector('input[type="email"]')).toBeNull();
    },
  );

  it('子供の行が active なら、これまでどおり依頼のフォームを出す', async () => {
    state.memberRow = memberRow('active', 'child');
    await render(createElement(FamilyPromotePage));

    expect(container.querySelector('input[type="email"]')).not.toBeNull();
  });
});
