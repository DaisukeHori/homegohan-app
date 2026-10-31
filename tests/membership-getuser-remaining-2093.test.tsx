/**
 * #2093 (triage-1030a) W4・W9・W10
 *
 *   - W4: 家族・設定・サポートの画面 (7 つ) が、getUser の error を見ずに `if (!user) router.push('/login')` としていた。
 *     getUser は通信の失敗を投げずに { data: { user: null }, error } で返すので、オフラインで開くと、ログインしている人でも
 *     ログインの画面へ移され、next も付けないので、ログインし直しても元の画面へ戻らなかった。
 *     直したあとは readSignedInUser で見分け、確かめられなかった (load-failed) ときは読み込めなかった文と「再試行」、
 *     ログインしていない (signed-out) ときだけ /login?next=<今のパス> へ移す。
 *     組織の管理画面の枠 ((org)/layout) の /login にも next を付ける。
 *     招待の画面 (/invite/[token]) は、getUser と招待の情報 (get_invite_details) の通信の失敗を「招待情報が見つかりません」と出していた。
 *     直したあとは、読み込めなかった文と「再試行」を出し、「見つかりません」は RPC が null を返したときだけにする。
 *   - W9: 組織のメンバーの画面で、読み直しに失敗したあとも前の自分の役割が残り、「組織を脱退」「オーナーを譲渡」が出続けていた。
 *     組織に属していないときも「+ メンバーを招待」が出ていた。ログインが切れたときも「再試行」だけを出していた。
 *   - W10: 家族のメンバーの詳細で、行が無い (脱退・除名した人) ときの文が「メンバー情報の取得に失敗しました」で、
 *     読み込みの失敗と読めた。直したあとは「見つかりません」の文と一覧へ戻る導線を出す。
 *
 * このリポジトリには @testing-library/react が無いため、react-dom/client + act で描画する。
 */
import { act, createElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({
  ME: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  OTHER: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  MEMBER: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33',
  FAMILY: 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66',
  ORG: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55',
  TOKEN: 'invite-token-2093',
}));

const MY_EMAIL = 'me@example.com';

// 本物の useRouter は同じ参照を返す (毎回作ると useEffect の依存が変わって読み込みが 2 回走る)
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: ids.MEMBER, token: ids.TOKEN }),
  useRouter: () => router,
  usePathname: () => nav.pathname,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) =>
    createElement('a', { href, ...rest }, children),
}));

vi.mock('@/lib/membership/family-member-names', () => ({
  fetchFamilyMemberNames: async () => [],
  applyFamilyMemberNames: <T,>(members: T[]) => members,
}));

type Result = { data: unknown; error: unknown };
type QueryKind = 'single' | 'maybeSingle' | 'list';
type Filters = Array<[string, unknown]>;
type GetUserResult = { data: { user: unknown }; error: unknown };

const state = vi.hoisted(() => ({
  /** getUser の応答を順に返す (尽きたら最後のものを返し続ける) */
  getUserResults: [] as GetUserResult[],
  getUserCalls: 0,
  /** 家族のメンバーの詳細で開くメンバーの行 (status つき) */
  memberRow: null as Record<string, unknown> | null,
  /** 組織のメンバーの画面の自分の役割 */
  orgRole: 'owner' as string,
  /** 組織のメンバーの画面の自分の組織 (null は組織に属していない) */
  orgId: null as string | null,
  /** get_invite_details の応答 (順に返す。尽きたら最後のもの) */
  inviteResults: [] as Result[],
  inviteCalls: 0,
  /** サポートの画面の枠で読む自分のプロフィールの応答 (null は既定) */
  supportProfile: null as Result | null,
}));

const NO_ROWS = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };

function respond(table: string, columns: string, filters: Filters, kind: QueryKind): Result {
  const filter = (column: string) => filters.find(([c]) => c === column)?.[1];
  switch (table) {
    case 'user_profiles':
      if (columns.includes('roles')) {
        return state.supportProfile ?? { data: { roles: ['support'], nickname: 'サポートの人' }, error: null };
      }
      if (columns === 'org_role, organization_id') {
        return { data: { org_role: state.orgRole, organization_id: state.orgId }, error: null };
      }
      if (columns.includes('org_role') && columns.includes('organizations')) {
        return {
          data: { org_role: 'owner', organization_id: ids.ORG, organizations: { name: '株式会社テスト', plan: 'standard' } },
          error: null,
        };
      }
      if (columns.includes('nickname')) {
        // 所属の設定の画面: 家族にも組織にも属していない
        return { data: { family_id: null, organization_id: null, org_role: null, nickname: '山田花子' }, error: null };
      }
      return { data: { family_id: ids.FAMILY }, error: null };
    case 'family_groups':
      return { data: { id: ids.FAMILY, name: '山田家', member_limit: 6, status: 'active' }, error: null };
    case 'family_members': {
      if (kind === 'list') {
        return {
          data: [
            { id: 'm-me', role: 'representative', display_name: '自分', user_id: ids.ME, child_profile: null, status: 'active' },
            { id: 'm-other', role: 'adult', display_name: '大人の人', user_id: ids.OTHER, child_profile: null, status: 'active' },
          ],
          error: null,
        };
      }
      if (columns === 'role') return { data: { role: 'representative' }, error: null };
      const row = state.memberRow;
      if (!row) return { data: null, error: NO_ROWS };
      const statusFilter = filter('status');
      if (statusFilter !== undefined && row.status !== statusFilter) return { data: null, error: NO_ROWS };
      return { data: row, error: null };
    }
    case 'parental_consents':
      return { data: null, error: null };
    default:
      return { data: null, error: null };
  }
}

function query(table: string) {
  let columns = '';
  const filters: Filters = [];
  const result = (kind: QueryKind): Result => {
    const raw = respond(table, columns, filters, kind);
    if (kind === 'maybeSingle' && raw.error === NO_ROWS) return { data: null, error: null };
    return raw;
  };
  const chain = {
    select(selected: string) {
      columns = selected;
      return chain;
    },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return chain;
    },
    in: () => chain,
    neq: () => chain,
    order: () => chain,
    limit: () => chain,
    single: async () => result('single'),
    maybeSingle: async () => result('maybeSingle'),
    then(resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(result('list')).then(resolve, reject);
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
  rpc: async (name: string) => {
    if (name !== 'get_invite_details') return { data: null, error: null };
    const index = Math.min(state.inviteCalls, state.inviteResults.length - 1);
    state.inviteCalls += 1;
    return state.inviteResults[index];
  },
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => client }));

const { default: FamilyDashboardPage } = await import('@/app/(main)/family/dashboard/page');
const { default: FamilyMembersPage } = await import('@/app/(main)/family/members/page');
const { default: FamilyInvitePage } = await import('@/app/(main)/family/members/invite/page');
const { default: FamilyChildNewPage } = await import('@/app/(main)/family/members/child/new/page');
const { default: FamilyRepresentativeTransferPage } = await import('@/app/(main)/family/representative-transfer/page');
const { default: MembershipSettingsPage } = await import('@/app/(main)/settings/membership/page');
const { default: SupportLayout } = await import('@/app/(support)/layout');
const { default: OrgLayout } = await import('@/app/(org)/layout');
const { default: OrgMembersPage } = await import('@/app/(org)/org/members/page');
const { default: InvitePage } = await import('@/app/invite/[token]/page');
const { default: FamilyMemberDetailPage } = await import('@/app/(main)/family/members/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** getUser が通信の失敗で返す error (auth-js は投げずに { user: null, error } で返す) */
const AUTH_NETWORK_ERROR = { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' };
/** getUser がログインしていないときに返す error */
const AUTH_SESSION_MISSING = { name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' };

const SIGNED_IN: GetUserResult = { data: { user: { id: ids.ME, email: MY_EMAIL } }, error: null };
const OFFLINE: GetUserResult = { data: { user: null }, error: AUTH_NETWORK_ERROR };
const SIGNED_OUT: GetUserResult = { data: { user: null }, error: AUTH_SESSION_MISSING };
const SIGNED_OUT_NO_ERROR: GetUserResult = { data: { user: null }, error: null };

/** 組織の招待 (承認待ち・自分宛て) */
const PENDING_ORG_INVITE = {
  status: 'pending',
  scope: 'organization',
  scope_id: ids.ORG,
  email: MY_EMAIL,
  scope_name: '株式会社テスト',
  invited_by_name: '招待した人',
  expires_at: '2999-01-01T00:00:00.000Z',
};
/** get_invite_details の通信が失敗したときの応答 (supabase-js は投げずに error で返す) */
const RPC_NETWORK_FAILURE: Result = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } };

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let alertMock: ReturnType<typeof vi.fn>;

async function flush() {
  for (let i = 0; i < 8; i += 1) {
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

function findLink(label: string): HTMLAnchorElement | undefined {
  return Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).find((a) => a.textContent?.includes(label));
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

function loginWithNext(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`;
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** 組織のメンバーの一覧の API の応答 (true なら読める) */
let orgMembersReadable = true;
/** 除名の通信が切れるか */
let removeRejects = false;

function defaultFetch(input: string | URL, init?: RequestInit) {
  const url = String(input);
  const method = init?.method ?? 'GET';
  if (url === '/api/family/invites') return Promise.resolve(jsonResponse(200, { data: { invites: [] } }));
  if (url === '/api/org/members' && method === 'GET') {
    if (!orgMembersReadable) return Promise.resolve(jsonResponse(500, { error: { message: 'Internal Server Error' } }));
    return Promise.resolve(
      jsonResponse(200, {
        members: [
          { id: ids.ME, nickname: '自分', org_role: state.orgRole, joined_org_at: '2026-10-01T00:00:00.000Z' },
          { id: ids.OTHER, nickname: 'Aさん', org_role: 'member', joined_org_at: '2026-10-02T00:00:00.000Z' },
        ],
      }),
    );
  }
  if (url.startsWith('/api/org/members/') && method === 'POST') {
    if (removeRejects) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve(jsonResponse(200, { ok: true }));
  }
  return Promise.resolve(jsonResponse(200, {}));
}

beforeEach(() => {
  router.push.mockReset();
  router.replace.mockReset();
  router.back.mockReset();
  nav.pathname = '/';
  state.getUserResults = [SIGNED_IN];
  state.getUserCalls = 0;
  state.memberRow = {
    id: ids.MEMBER,
    role: 'adult',
    display_name: '大人の人',
    user_id: ids.OTHER,
    child_profile: null,
    birth_date: null,
    share_meals: true,
    share_health: false,
    share_menu: true,
    joined_at: '2026-10-01T00:00:00.000Z',
    status: 'active',
  };
  state.orgRole = 'owner';
  state.orgId = ids.ORG;
  state.inviteResults = [{ data: PENDING_ORG_INVITE, error: null }];
  state.inviteCalls = 0;
  state.supportProfile = null;
  orgMembersReadable = true;
  removeRejects = false;
  fetchMock = vi.fn(defaultFetch);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('confirm', () => true);
  alertMock = vi.fn();
  vi.stubGlobal('alert', alertMock);
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

/** 画面ごとの、読み込めなかった文の箱・文・ログインの戻り先・読めたときに出る文 */
const SCREENS = [
  {
    name: '家族のダッシュボード (/family/dashboard)',
    pathname: '/family/dashboard',
    element: () => createElement(FamilyDashboardPage),
    loadErrorTestId: 'family-dashboard-load-error',
    loadError: '家族の情報を読み込めませんでした。しばらくしてから、もう一度お試しください。',
    loginUrl: loginWithNext('/family/dashboard'),
    loadedText: '山田家',
  },
  {
    name: '家族のメンバーの一覧 (/family/members)',
    pathname: '/family/members',
    element: () => createElement(FamilyMembersPage),
    loadErrorTestId: 'family-members-load-error',
    loadError: '家族のメンバーを読み込めませんでした。しばらくしてから、もう一度お試しください。',
    loginUrl: loginWithNext('/family/members'),
    loadedText: '大人の人',
  },
  {
    name: '家族の招待 (/family/members/invite)',
    pathname: '/family/members/invite',
    element: () => createElement(FamilyInvitePage),
    loadErrorTestId: 'family-invite-load-error',
    loadError: '家族の情報を読み込めませんでした。しばらくしてから、もう一度お試しください。',
    loginUrl: loginWithNext('/family/members/invite'),
    loadedText: 'メッセージ (任意)',
  },
  {
    name: '子供の追加 (/family/members/child/new)',
    pathname: '/family/members/child/new',
    element: () => createElement(FamilyChildNewPage),
    loadErrorTestId: 'family-child-new-load-error',
    loadError: '家族の情報を読み込めませんでした。しばらくしてから、もう一度お試しください。',
    loginUrl: loginWithNext('/family/members/child/new'),
    loadedText: '生年月日',
  },
  {
    name: '家族の代表者の譲渡 (/family/representative-transfer)',
    pathname: '/family/representative-transfer',
    element: () => createElement(FamilyRepresentativeTransferPage),
    loadErrorTestId: 'family-transfer-load-error',
    loadError: '代表者の譲渡の候補を読み込めませんでした。しばらくしてから、もう一度お試しください。',
    loginUrl: loginWithNext('/family/representative-transfer'),
    loadedText: '大人の人',
  },
  {
    name: '所属の設定 (/settings/membership)',
    pathname: '/settings/membership',
    element: () => createElement(MembershipSettingsPage),
    loadErrorTestId: 'settings-membership-load-error',
    loadError: '所属の情報を読み込めませんでした。しばらくしてから、もう一度お試しください。',
    loginUrl: loginWithNext('/settings/membership'),
    loadedText: '家族グループを作成・参加',
  },
  {
    name: 'サポートの画面の枠 ((support)/layout)',
    pathname: '/support/inquiries',
    element: () => createElement(SupportLayout, null, createElement('div', null, 'サポートの中身')),
    loadErrorTestId: 'support-layout-load-error',
    loadError: 'サポートの画面を開けませんでした。しばらくしてから、もう一度お試しください。',
    loginUrl: loginWithNext('/support/inquiries'),
    loadedText: 'サポートの中身',
  },
  {
    name: '組織の管理画面の枠 ((org)/layout)',
    pathname: '/org/departments',
    element: () => createElement(OrgLayout, null, createElement('div', null, '組織の中身')),
    loadErrorTestId: 'org-layout-load-error',
    loadError: '組織の管理画面を開けませんでした。しばらくしてから、もう一度お試しください。',
    loginUrl: loginWithNext('/org/departments'),
    loadedText: '組織の中身',
  },
  {
    name: '組織のメンバー (/org/members)',
    pathname: '/org/members',
    element: () => createElement(OrgMembersPage),
    loadErrorTestId: 'member-load-error',
    loadError: 'メンバーの一覧を読み込めませんでした。しばらくしてから、もう一度お試しください。',
    loginUrl: loginWithNext('/org/members'),
    loadedText: 'Aさん',
  },
] as const;

describe('#2093 W4 画面を開いたとき getUser が通信の失敗を返したら、ログインの画面へ移さず、読み込めなかった文と「再試行」を出す', () => {
  for (const screen of SCREENS) {
    it(`${screen.name}: 通信の失敗 → 読み込めなかった文と「再試行」 (ログインの画面へ移さない)`, async () => {
      nav.pathname = screen.pathname;
      state.getUserResults = [OFFLINE];
      await render(screen.element());

      expect(byTestId(screen.loadErrorTestId)).toContain(screen.loadError);
      expect(pushedLogin()).toEqual([]);
      expect(findButton('再試行')).toBeDefined();
      expect(text()).not.toContain(screen.loadedText);
    });

    it(`${screen.name}: 「再試行」で読み直し、通信が戻れば読み込めなかった文を消して中身を出す`, async () => {
      nav.pathname = screen.pathname;
      state.getUserResults = [OFFLINE, SIGNED_IN];
      await render(screen.element());
      await click(findButton('再試行'));

      expect(byTestId(screen.loadErrorTestId)).toBeNull();
      expect(text()).toContain(screen.loadedText);
      expect(pushedLogin()).toEqual([]);
    });

    it(`${screen.name}: ログインしていない (AuthSessionMissingError) → ログインの画面へ (戻り先の next つき)`, async () => {
      nav.pathname = screen.pathname;
      state.getUserResults = [SIGNED_OUT];
      await render(screen.element());

      expect(pushedLogin()).toEqual([screen.loginUrl]);
      expect(byTestId(screen.loadErrorTestId)).toBeNull();
    });

    it(`${screen.name}: user も error も無い → ログインの画面へ (戻り先の next つき)`, async () => {
      nav.pathname = screen.pathname;
      state.getUserResults = [SIGNED_OUT_NO_ERROR];
      await render(screen.element());

      expect(pushedLogin()).toEqual([screen.loginUrl]);
    });
  }
});

describe('#2093 W4 サポートの画面の枠: 自分のプロフィールを読み込めなかったときに「サポート権限がありません」と出してホームへ移さない', () => {
  it('プロフィールの読み込みが失敗した (行が無いのとは別) → 読み込めなかった文と「再試行」 (権限なしと見せない)', async () => {
    nav.pathname = '/support';
    state.supportProfile = { data: null, error: { code: '', message: 'TypeError: Failed to fetch' } };
    await render(createElement(SupportLayout, null, createElement('div', null, 'サポートの中身')));

    expect(byTestId('support-layout-load-error')).toContain('サポートの画面を開けませんでした');
    expect(alertMock).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalledWith('/home');

    state.supportProfile = null;
    await click(findButton('再試行'));
    expect(byTestId('support-layout-load-error')).toBeNull();
    expect(text()).toContain('サポートの中身');
  });

  it('プロフィールの行が無い (PGRST116) → これまでどおり権限なしとしてホームへ', async () => {
    nav.pathname = '/support';
    state.supportProfile = { data: null, error: NO_ROWS };
    await render(createElement(SupportLayout, null, createElement('div', null, 'サポートの中身')));

    expect(alertMock).toHaveBeenCalledWith('サポート権限がありません');
    expect(router.push).toHaveBeenCalledWith('/home');
    expect(byTestId('support-layout-load-error')).toBeNull();
  });

  it('サポートの権限が無い → これまでどおりホームへ', async () => {
    nav.pathname = '/support';
    state.supportProfile = { data: { roles: ['user'], nickname: '利用者' }, error: null };
    await render(createElement(SupportLayout, null, createElement('div', null, 'サポートの中身')));

    expect(router.push).toHaveBeenCalledWith('/home');
    expect(text()).not.toContain('サポートの中身');
  });
});

describe('#2093 W4 招待の画面: 通信の失敗を「招待情報が見つかりません」と出さない', () => {
  it('getUser が通信の失敗 → 読み込めなかった文と「再試行」 (招待が無効と見せない)', async () => {
    state.getUserResults = [OFFLINE];
    await render(createElement(InvitePage));

    expect(byTestId('invite-load-error')).toContain('招待の情報を読み込めませんでした');
    expect(text()).not.toContain('招待が見つかりません');
    expect(text()).not.toContain('ログインする');
    expect(findButton('再試行')).toBeDefined();
  });

  it('get_invite_details の通信が失敗 → 読み込めなかった文と「再試行」。「再試行」で読めたら招待を出す', async () => {
    state.inviteResults = [RPC_NETWORK_FAILURE, { data: PENDING_ORG_INVITE, error: null }];
    await render(createElement(InvitePage));

    expect(byTestId('invite-load-error')).toContain('招待の情報を読み込めませんでした');
    expect(text()).not.toContain('招待が見つかりません');

    await click(findButton('再試行'));
    expect(byTestId('invite-load-error')).toBeNull();
    expect(text()).toContain('株式会社テストへの招待');
  });

  it('get_invite_details が null を返した (招待が無い) ときだけ「招待情報が見つかりません」', async () => {
    state.inviteResults = [{ data: null, error: null }];
    await render(createElement(InvitePage));

    expect(text()).toContain('招待情報が見つかりません');
    expect(byTestId('invite-load-error')).toBeNull();
  });

  it('ログインしていない (AuthSessionMissingError) → これまでどおり、ログインの案内を出す (読み込みの失敗と見せない)', async () => {
    state.getUserResults = [SIGNED_OUT];
    await render(createElement(InvitePage));

    expect(byTestId('invite-load-error')).toBeNull();
    expect(findButton('ログインする')).toBeDefined();
  });
});

describe('#2093 W9 組織のメンバーの画面: 読み込めなかったとき・組織に属していないときに操作のボタンを残さない', () => {
  it.each([
    ['owner', 'オーナーを譲渡'],
    ['admin', '組織を脱退'],
  ] as const)('役割が %s: 除名の通信が切れ、読み直しで一覧を読み込めなかったら「%s」を出さない', async (role, label) => {
    state.orgRole = role;
    await render(createElement(OrgMembersPage));
    const before = role === 'owner' ? findLink(label) : findButton(label);
    expect(before).toBeDefined();

    removeRejects = true;
    orgMembersReadable = false;
    await click(findButton('除名'));

    expect(byTestId('member-load-error')).toContain('メンバーの一覧を読み込めませんでした');
    expect(findLink('オーナーを譲渡')).toBeUndefined();
    expect(findButton('組織を脱退')).toBeUndefined();
    expect(findLink('+ メンバーを招待')).toBeUndefined();

    // 「再試行」で読めたら、今の役割でボタンを出し直す
    orgMembersReadable = true;
    await click(findButton('再試行'));
    const after = role === 'owner' ? findLink(label) : findButton(label);
    expect(after).toBeDefined();
    expect(findLink('+ メンバーを招待')).toBeDefined();
  });

  it('開いたときに組織に属していなければ「+ メンバーを招待」を出さない', async () => {
    state.orgId = null;
    await render(createElement(OrgMembersPage));

    expect(text()).toContain('組織に所属していません');
    expect(findLink('+ メンバーを招待')).toBeUndefined();
    expect(findButton('組織を脱退')).toBeUndefined();
    expect(findLink('オーナーを譲渡')).toBeUndefined();
  });

  it('組織に属していれば「+ メンバーを招待」を出す', async () => {
    await render(createElement(OrgMembersPage));

    expect(findLink('+ メンバーを招待')?.getAttribute('href')).toBe('/org/invites');
  });

  it('除名の通信が切れ、読み直しでログインが切れていたら、ログインの画面へ (next つき) 移し、「再試行」の案内を出さない', async () => {
    state.orgRole = 'owner';
    await render(createElement(OrgMembersPage));
    state.getUserResults = [SIGNED_IN, SIGNED_OUT];
    state.getUserCalls = 1;
    removeRejects = true;
    await click(findButton('除名'));

    expect(pushedLogin()).toEqual([loginWithNext('/org/members')]);
    expect(alertMock).not.toHaveBeenCalled();
    expect(findLink('オーナーを譲渡')).toBeUndefined();
  });
});

describe('#2093 W10 家族のメンバーの詳細: 行が無いときは「見つかりません」の文と一覧へ戻る導線を出す', () => {
  const NOT_FOUND = 'このメンバーは見つかりません (家族から外れた可能性があります)。一覧に戻って確かめてください';

  it.each(['left', 'removed'] as const)('開くメンバーの行が %s なら「見つかりません」と一覧へ戻る導線を出す (読み込みの失敗の文と分ける)', async (status) => {
    state.memberRow = { ...state.memberRow, status };
    await render(createElement(FamilyMemberDetailPage));

    expect(text()).toContain(NOT_FOUND);
    expect(text()).not.toContain('取得に失敗しました');
    expect(text()).not.toContain('読み込めませんでした');
    expect(findButton('再試行')).toBeUndefined();
    expect(findLink('メンバーの一覧へ')?.getAttribute('href')).toBe('/family/members');
  });

  it('行がそもそも無い (PGRST116) ときも同じ文', async () => {
    state.memberRow = null;
    await render(createElement(FamilyMemberDetailPage));

    expect(text()).toContain(NOT_FOUND);
    expect(findLink('メンバーの一覧へ')?.getAttribute('href')).toBe('/family/members');
  });
});
