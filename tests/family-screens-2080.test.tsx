/**
 * #2080 (triage-1029b) U1〜U3: 家族の画面のテスト
 *
 *   - U1: 招待の承諾の画面 (/invite/[token]) で、承諾の通信が切れると、家族に入れていても「通信エラー」を出し、
 *     押し直すと「この招待は既に使用済みです。」で止まっていた (サーバーが承諾を済ませてから応答が切れたとき)。
 *     直したあとは、自分のプロフィールを読み直し、招待の家族 (組織) に入っていれば成功のときと同じ遷移にする。
 *     読み直せなかったときは「状態を確かめられませんでした」を添える。組織の招待の承諾も同じ型なので同じに直す
 *   - U2: 家族のメンバーの詳細で、脱退・除名のあと招待で戻った人は、同じ家族に自分の行が 2 本 (left / removed と active) あり、
 *     自分の役割の問い合わせが .single() で失敗して、権限なし (管理の操作を出さない) と見えていた。
 *     直したあとは、自分の active な行だけを読む
 *   - U3: 家族のダッシュボード・メンバーの詳細で、家族グループ・メンバーを読み込めなかったのに「再試行」が無く、
 *     行が無いのと同じ文を出していた。直したあとは、行が無いとき (PGRST116) はこれまでどおりの文、
 *     読み込めなかったときは読み込めなかった文と「再試行」を出す
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMBERSHIP_STATE_UNCONFIRMED_NOTE } from '@/lib/membership/leave-state';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER_ID = '44444444-4444-4444-8444-444444444444';
const FAMILY_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_FAMILY_ID = '67777777-6666-4666-8666-666666666666';
const ORG_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_ORG_ID = '78888888-7777-4777-8777-777777777777';
/** 開くメンバーの詳細 (他の人・大人) の行の id */
const TARGET_MEMBER_ID = '55555555-5555-4555-8555-555555555555';
/** 自分の古い行 (脱退・除名した行) と、招待で戻ったときの新しい行 */
const OLD_SELF_MEMBER_ID = '88888888-8888-4888-8888-888888888888';
const NEW_SELF_MEMBER_ID = '99999999-9999-4999-8999-999999999999';
const INVITE_TOKEN = 'invite-token-2080';
const USER_EMAIL = 'invitee@example.com';

/** 画面の文 (画面と同じもの) */
const NETWORK_ERROR = '通信エラーが発生しました';
const INVITE_ALREADY_USED_MESSAGE = 'この招待は既に使用済みです。';
const DASHBOARD_LOAD_ERROR = '家族の情報を読み込めませんでした';
const MEMBER_DETAIL_LOAD_ERROR = 'メンバーの情報を読み込めませんでした';
const GROUP_NOT_FOUND = '家族グループの取得に失敗しました';
const MEMBER_NOT_FOUND = 'メンバー情報の取得に失敗しました';
const REMOVE_ACTION = '家族から外す';

/** 行が無いのではなく、読み込めなかった失敗 */
const LOAD_FAILURE = { code: '57014', message: 'canceling statement due to statement timeout' };
/** .single() で行が無いときの PostgREST の失敗 */
const NO_ROWS = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains 0 rows' };
/** .single() / .maybeSingle() に行が 2 行以上返ったときの PostgREST の失敗 */
const MULTIPLE_ROWS = {
  code: 'PGRST116',
  message: 'JSON object requested, multiple (or no) rows returned',
  details: 'The result contains 2 rows',
};

type QueryResult = { data: unknown; error: unknown };
type QueryKind = 'single' | 'maybeSingle' | 'list';
interface QueryContext {
  table: string;
  kind: QueryKind;
  columns: string;
  filters: Record<string, unknown>;
}
type Responder = (ctx: QueryContext) => QueryResult | Promise<QueryResult>;

const supabaseState = vi.hoisted(() => ({
  responders: {} as Record<string, unknown>,
  queries: [] as Array<{ table: string; kind: string; columns: string; filters: Record<string, unknown> }>,
  /** get_invite_details の応答 */
  inviteDetails: null as unknown,
}));

function respond(ctx: QueryContext): Promise<QueryResult> {
  supabaseState.queries.push({ table: ctx.table, kind: ctx.kind, columns: ctx.columns, filters: { ...ctx.filters } });
  const responder = supabaseState.responders[ctx.table] as Responder | undefined;
  if (responder) {
    try {
      return Promise.resolve(responder(ctx));
    } catch (thrown) {
      return Promise.reject(thrown);
    }
  }
  if (ctx.kind === 'single') return Promise.resolve({ data: null, error: NO_ROWS });
  if (ctx.kind === 'maybeSingle') return Promise.resolve({ data: null, error: null });
  return Promise.resolve({ data: [], error: null });
}

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: () => undefined }));
const params = vi.hoisted(() => ({
  token: 'invite-token-2080',
  id: '55555555-5555-4555-8555-555555555555',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useParams: () => params,
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

// 画面に出す名前の補完は本題ではないので、そのまま返す
vi.mock('@/lib/membership/family-member-names', () => ({
  fetchFamilyMemberNames: async () => new Map<string, string>(),
  applyFamilyMemberNames: <T,>(members: T[]) => members,
}));

vi.mock('@/lib/supabase/client', () => {
  const builder = (table: string) => {
    let columns = '';
    const filters: Record<string, unknown> = {};
    const query = {
      select: (selected: string) => {
        columns = selected;
        return query;
      },
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return query;
      },
      order: () => query,
      limit: () => query,
      single: () => respond({ table, kind: 'single', columns, filters }),
      maybeSingle: () => respond({ table, kind: 'maybeSingle', columns, filters }),
      then: (onFulfilled: (value: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
        respond({ table, kind: 'list', columns, filters }).then(onFulfilled, onRejected),
    };
    return query;
  };
  // 本物の createClient (ブラウザではシングルトン) と同じく、毎回同じクライアントを返す
  const client = {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: USER_ID, email: USER_EMAIL } }, error: null }),
      signOut: () => Promise.resolve({ error: null }),
    },
    from: (table: string) => builder(table),
    rpc: (name: string) =>
      name === 'get_invite_details'
        ? Promise.resolve({ data: supabaseState.inviteDetails, error: null })
        : Promise.resolve({ data: null, error: { code: 'PGRST202', message: `想定していない rpc: ${name}` } }),
  };
  return { createClient: () => client };
});

const { default: InvitePage } = await import('@/app/invite/[token]/page');
const { default: FamilyDashboardPage } = await import('@/app/(main)/family/dashboard/page');
const { default: FamilyMemberDetailPage } = await import('@/app/(main)/family/members/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** あとで返す値 (応答を待つ間の画面を確かめるため) */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let unhandled: unknown[];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

type Handler = (method: string, url: URL, init?: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    return handler(method, url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
}

const callsOf = (method: string, pathname: string) =>
  fetchMock.mock.calls.filter(([input, init]) => {
    const m = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    return m === method && new URL(String(input), 'http://localhost').pathname === pathname;
  });

/** 送った問い合わせのうち、表が一致するもの */
const queriesOf = (table: string) => supabaseState.queries.filter((q) => q.table === table);

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderElement(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
  await settle();
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
}

async function click(element: HTMLElement | null | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeTruthy();
  await act(async () => {
    element!.click();
  });
  await settle();
}

const text = () => container.textContent ?? '';
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('alert', vi.fn());
  mockFetch((method, url) => {
    throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
  });
  router.push.mockReset();
  router.replace.mockReset();
  router.back.mockReset();
  supabaseState.responders = {};
  supabaseState.queries = [];
  supabaseState.inviteDetails = null;
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  process.off('unhandledRejection', onUnhandled);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// U1: 招待の承諾
// ─────────────────────────────────────────────────────────────────────────────

/** 自分のプロフィール (サーバーの今の値)。承諾の RPC は同じトランザクションで family_id / organization_id を招待の家族 / 組織にする */
let serverProfile: { family_id: string | null; organization_id: string | null };
/** プロフィールの読み直しを失敗させるか */
let profileRereadFails: boolean;

function profileReadable() {
  serverProfile = { family_id: null, organization_id: null };
  profileRereadFails = false;
  supabaseState.responders.user_profiles = (ctx: QueryContext) => {
    if (profileRereadFails) return { data: null, error: LOAD_FAILURE };
    // 自分の行 (id = 自分) に絞らないと、本物のデータベースでは他の人の行も返りうる
    if (ctx.kind !== 'single' || ctx.filters.id !== USER_ID) return { data: null, error: MULTIPLE_ROWS };
    return { data: { ...serverProfile }, error: null };
  };
}

const INVITE_SCOPES = [
  {
    scope: 'family' as const,
    scopeId: FAMILY_ID,
    otherScopeId: OTHER_FAMILY_ID,
    acceptPath: `/api/family/invites/${INVITE_TOKEN}/accept`,
    destination: '/family/dashboard',
    alreadyMemberCode: 'ALREADY_IN_FAMILY',
    join: (scopeId: string) => {
      serverProfile = { ...serverProfile, family_id: scopeId };
    },
  },
  {
    scope: 'organization' as const,
    scopeId: ORG_ID,
    otherScopeId: OTHER_ORG_ID,
    acceptPath: `/api/org/invites/${INVITE_TOKEN}/accept`,
    destination: '/org/dashboard',
    alreadyMemberCode: 'ALREADY_IN_ORG',
    join: (scopeId: string) => {
      serverProfile = { ...serverProfile, organization_id: scopeId };
    },
  },
];

describe.each(INVITE_SCOPES)('#2080 U1 招待の承諾 ($scope): 承諾の通信が切れたら、自分の所属を読み直す', (target) => {
  function invitePending() {
    supabaseState.inviteDetails = {
      status: 'pending',
      scope: target.scope,
      scope_id: target.scopeId,
      email: USER_EMAIL,
      scope_name: '山田家',
      invited_by_name: '太郎',
      expires_at: '2099-01-01T00:00:00.000Z',
    };
    profileReadable();
  }

  const acceptButton = () => findButton('承諾する') ?? findButton('処理中…');

  it('サーバーが承諾を済ませてから応答が切れたとき、招待の先に入っていれば、通信エラーを出さず成功のときと同じ遷移にする', async () => {
    invitePending();
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === target.acceptPath) {
        target.join(target.scopeId);
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(InvitePage));

    await click(findButton('承諾する'), '「承諾する」');

    expect(callsOf('POST', target.acceptPath)).toHaveLength(1);
    // 読み直すのは自分のプロフィールの行
    expect(queriesOf('user_profiles').map((q) => q.filters)).toEqual([{ id: USER_ID }]);
    expect(router.push).toHaveBeenCalledWith(target.destination);
    expect(text()).not.toContain(NETWORK_ERROR);
    expect(unhandled).toEqual([]);
  });

  it('承諾の 200 の本文を読み切れなかったときも、読み直して、入っていれば成功のときと同じ遷移にする', async () => {
    invitePending();
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === target.acceptPath) {
        target.join(target.scopeId);
        return new Response('{"data":', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(InvitePage));

    await click(findButton('承諾する'), '「承諾する」');

    expect(router.push).toHaveBeenCalledWith(target.destination);
    expect(text()).not.toContain(NETWORK_ERROR);
  });

  it('承諾できていなければ (所属が空)、これまでどおり通信エラーの文を出し、遷移しない', async () => {
    invitePending();
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === target.acceptPath) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(InvitePage));

    await click(findButton('承諾する'), '「承諾する」');

    expect(queriesOf('user_profiles')).toHaveLength(1);
    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).not.toContain(MEMBERSHIP_STATE_UNCONFIRMED_NOTE);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('別の家族 / 組織に入っているだけなら (招待の先ではない)、承諾できたとせず、通信エラーの文を出し、遷移しない', async () => {
    invitePending();
    target.join(target.otherScopeId);
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === target.acceptPath) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(InvitePage));

    await click(findButton('承諾する'), '「承諾する」');

    expect(text()).toContain(NETWORK_ERROR);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('読み直しも失敗したら、通信エラーの文に「状態を確かめられませんでした」を添え、遷移しない', async () => {
    invitePending();
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === target.acceptPath) {
        target.join(target.scopeId);
        profileRereadFails = true;
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(InvitePage));

    await click(findButton('承諾する'), '「承諾する」');

    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).toContain(MEMBERSHIP_STATE_UNCONFIRMED_NOTE);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('読み直しの応答を待つあいだは、「承諾する」を止めたままにする (押し直させない)', async () => {
    invitePending();
    const reread = deferred<QueryResult>();
    supabaseState.responders.user_profiles = () => reread.promise;
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === target.acceptPath) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(InvitePage));

    await click(findButton('承諾する'), '「承諾する」');
    expect(acceptButton()?.disabled).toBe(true);

    await act(async () => {
      reread.resolve({ data: { family_id: null, organization_id: null }, error: null });
    });
    await settle();
    expect(acceptButton()?.disabled).toBe(false);
    expect(text()).toContain(NETWORK_ERROR);
  });

  it('押し直して「既に使用済み」(409 INVITE_ALREADY_USED) が返っても、招待の先に入っていれば成功のときと同じ遷移にする', async () => {
    invitePending();
    let attempts = 0;
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === target.acceptPath) {
        attempts += 1;
        if (attempts === 1) {
          // 1 回目: サーバーは承諾を済ませたが、応答が切れた。読み直しも失敗する
          target.join(target.scopeId);
          profileRereadFails = true;
          throw new TypeError('Failed to fetch');
        }
        // 2 回目: 招待は承諾済みなので、RPC は INVITE_ALREADY_USED で断る
        profileRereadFails = false;
        return jsonResponse(409, { error: { code: 'INVITE_ALREADY_USED', message: '招待は既に使用済みです' } });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(InvitePage));

    await click(findButton('承諾する'), '「承諾する」');
    expect(router.push).not.toHaveBeenCalled();
    await click(findButton('承諾する'), '「承諾する」 (押し直し)');

    expect(callsOf('POST', target.acceptPath)).toHaveLength(2);
    expect(router.push).toHaveBeenCalledWith(target.destination);
    expect(text()).not.toContain(INVITE_ALREADY_USED_MESSAGE);
  });

  it('「既に使用済み」で、招待の先に入っていなければ、これまでどおり「この招待は既に使用済みです。」を出す', async () => {
    invitePending();
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === target.acceptPath) {
        return jsonResponse(409, { error: { code: 'INVITE_ALREADY_USED', message: '招待は既に使用済みです' } });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(InvitePage));

    await click(findButton('承諾する'), '「承諾する」');

    expect(queriesOf('user_profiles')).toHaveLength(1);
    expect(text()).toContain(INVITE_ALREADY_USED_MESSAGE);
    expect(text()).not.toContain(MEMBERSHIP_STATE_UNCONFIRMED_NOTE);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('「既に使用済み」で読み直しも失敗したら、「この招待は既に使用済みです。」に「状態を確かめられませんでした」を添える', async () => {
    invitePending();
    profileRereadFails = true;
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === target.acceptPath) {
        return jsonResponse(409, { error: { code: 'INVITE_ALREADY_USED', message: '招待は既に使用済みです' } });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(InvitePage));

    await click(findButton('承諾する'), '「承諾する」');

    expect(text()).toContain(INVITE_ALREADY_USED_MESSAGE);
    expect(text()).toContain(MEMBERSHIP_STATE_UNCONFIRMED_NOTE);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('(対照) 既に別の家族 / 組織に入っている (409) ときは、読み直さず、これまでどおりの文を出す', async () => {
    invitePending();
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === target.acceptPath) {
        return jsonResponse(409, { error: { code: target.alreadyMemberCode, message: '既に所属しています' } });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(InvitePage));

    await click(findButton('承諾する'), '「承諾する」');

    expect(queriesOf('user_profiles')).toHaveLength(0);
    expect(text()).toContain('既に');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('(対照) 承諾が 200 で返れば、読み直さずに遷移する (これまでどおり)', async () => {
    invitePending();
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === target.acceptPath) return jsonResponse(200, { data: {} });
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(InvitePage));

    await click(findButton('承諾する'), '「承諾する」');

    expect(queriesOf('user_profiles')).toHaveLength(0);
    expect(router.push).toHaveBeenCalledWith(target.destination);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U2・U3: メンバーの詳細
// ─────────────────────────────────────────────────────────────────────────────

interface MemberRow {
  id: string;
  family_id: string;
  user_id: string | null;
  status: 'active' | 'left' | 'removed';
  role: 'representative' | 'adult' | 'child';
  display_name: string | null;
  child_profile: null;
  birth_date: null;
  share_meals: boolean;
  share_health: boolean;
  share_menu: boolean;
  joined_at: string;
}

function memberRow(overrides: Partial<MemberRow> & Pick<MemberRow, 'id' | 'user_id' | 'status' | 'role'>): MemberRow {
  return {
    family_id: FAMILY_ID,
    display_name: null,
    child_profile: null,
    birth_date: null,
    share_meals: true,
    share_health: false,
    share_menu: true,
    joined_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** family_members の行 (サーバーの今の値)。問い合わせの eq の条件で絞って返す (絞り込みが足りなければ本物と同じく 2 行以上になる) */
let memberRows: MemberRow[];

function familyMembersFromRows() {
  supabaseState.responders.family_members = (ctx: QueryContext) => {
    const matched = memberRows.filter((row) =>
      Object.entries(ctx.filters).every(([column, value]) => (row as unknown as Record<string, unknown>)[column] === value),
    );
    if (ctx.kind === 'list') return { data: matched, error: null };
    if (matched.length > 1) return { data: null, error: MULTIPLE_ROWS };
    if (matched.length === 0) return ctx.kind === 'single' ? { data: null, error: NO_ROWS } : { data: null, error: null };
    return { data: matched[0], error: null };
  };
}

function inFamilyProfile() {
  supabaseState.responders.user_profiles = (ctx: QueryContext) =>
    ctx.kind === 'single' && ctx.filters.id === USER_ID
      ? { data: { family_id: FAMILY_ID }, error: null }
      : { data: null, error: MULTIPLE_ROWS };
}

const TARGET_NAME = '花子';
const targetRow = () =>
  memberRow({ id: TARGET_MEMBER_ID, user_id: OTHER_USER_ID, status: 'active', role: 'adult', display_name: TARGET_NAME });

describe('#2080 U2 メンバーの詳細: 脱退・除名のあと招待で戻った人の役割は、自分の active な行から読む', () => {
  it.each(['left', 'removed'] as const)(
    '自分の古い行 (%s) と新しい行 (active) があっても、読み込めなかった文を出さず、自分の役割 (大人) で管理の操作を出す',
    async (oldStatus) => {
      inFamilyProfile();
      memberRows = [
        targetRow(),
        memberRow({ id: OLD_SELF_MEMBER_ID, user_id: USER_ID, status: oldStatus, role: 'representative' }),
        memberRow({ id: NEW_SELF_MEMBER_ID, user_id: USER_ID, status: 'active', role: 'adult' }),
      ];
      familyMembersFromRows();
      await renderElement(createElement(FamilyMemberDetailPage));

      expect(byTestId('family-member-detail-load-error')).toBeNull();
      expect(text()).toContain(TARGET_NAME);
      expect(text()).toContain(REMOVE_ACTION);
      // 自分の役割は、自分の active な行に絞って読む
      expect(
        supabaseState.queries.filter((q) => q.table === 'family_members' && q.columns === 'role').map((q) => q.filters),
      ).toEqual([{ family_id: FAMILY_ID, user_id: USER_ID, status: 'active' }]);
    },
  );

  it('古い行の役割 (代表) を今の役割と取り違えない: 古い行が代表・新しい行が子供なら、管理の操作を出さない', async () => {
    inFamilyProfile();
    memberRows = [
      targetRow(),
      memberRow({ id: OLD_SELF_MEMBER_ID, user_id: USER_ID, status: 'left', role: 'representative' }),
      memberRow({ id: NEW_SELF_MEMBER_ID, user_id: USER_ID, status: 'active', role: 'child' }),
    ];
    familyMembersFromRows();
    await renderElement(createElement(FamilyMemberDetailPage));

    expect(byTestId('family-member-detail-load-error')).toBeNull();
    expect(text()).toContain(TARGET_NAME);
    expect(text()).not.toContain(REMOVE_ACTION);
  });

  it('自分の active な行が無い (脱退済み) ときは、読み込めなかったとせず、権限なしとする', async () => {
    inFamilyProfile();
    memberRows = [targetRow(), memberRow({ id: OLD_SELF_MEMBER_ID, user_id: USER_ID, status: 'left', role: 'adult' })];
    familyMembersFromRows();
    await renderElement(createElement(FamilyMemberDetailPage));

    expect(byTestId('family-member-detail-load-error')).toBeNull();
    expect(text()).toContain(TARGET_NAME);
    expect(text()).not.toContain(REMOVE_ACTION);
  });

  it('自分の役割を読み込めなかったら、権限なしと見せず、読み込めなかった文と「再試行」を出す', async () => {
    inFamilyProfile();
    memberRows = [targetRow(), memberRow({ id: NEW_SELF_MEMBER_ID, user_id: USER_ID, status: 'active', role: 'adult' })];
    familyMembersFromRows();
    const base = supabaseState.responders.family_members as Responder;
    supabaseState.responders.family_members = (ctx: QueryContext) =>
      ctx.columns === 'role' ? { data: null, error: LOAD_FAILURE } : base(ctx);
    await renderElement(createElement(FamilyMemberDetailPage));

    expect(byTestId('family-member-detail-load-error')).toContain(MEMBER_DETAIL_LOAD_ERROR);
    expect(findButton('再試行')).toBeDefined();
  });
});

describe('#2080 U3 メンバーの詳細: メンバーの行を読み込めなかったら「再試行」を出し、行が無いのと分ける', () => {
  function readable() {
    inFamilyProfile();
    memberRows = [targetRow(), memberRow({ id: NEW_SELF_MEMBER_ID, user_id: USER_ID, status: 'active', role: 'adult' })];
    familyMembersFromRows();
  }

  it('メンバーの行を読み込めなかったら、読み込めなかった文と「再試行」を出し、「再試行」で読めたらメンバーを出す', async () => {
    readable();
    const base = supabaseState.responders.family_members as Responder;
    let memberReadFails = true;
    supabaseState.responders.family_members = (ctx: QueryContext) =>
      memberReadFails && ctx.kind === 'single' && ctx.filters.id === TARGET_MEMBER_ID
        ? { data: null, error: LOAD_FAILURE }
        : base(ctx);
    await renderElement(createElement(FamilyMemberDetailPage));

    expect(byTestId('family-member-detail-load-error')).toContain(MEMBER_DETAIL_LOAD_ERROR);
    expect(text()).not.toContain(MEMBER_NOT_FOUND);

    memberReadFails = false;
    await click(findButton('再試行'), '「再試行」');

    expect(byTestId('family-member-detail-load-error')).toBeNull();
    expect(text()).toContain(TARGET_NAME);
    expect(text()).toContain(REMOVE_ACTION);
  });

  it('(対照) メンバーの行が無い (PGRST116) ときは、これまでどおりの文を出し、「再試行」を出さない', async () => {
    readable();
    memberRows = memberRows.filter((row) => row.id !== TARGET_MEMBER_ID);
    await renderElement(createElement(FamilyMemberDetailPage));

    expect(byTestId('family-member-detail-load-error')).toBeNull();
    expect(text()).toContain(MEMBER_NOT_FOUND);
    expect(findButton('再試行')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U3: 家族のダッシュボード
// ─────────────────────────────────────────────────────────────────────────────

describe('#2080 U3 家族のダッシュボード: 家族グループ・メンバーを読み込めなかったら「再試行」を出し、行が無いのと分ける', () => {
  let groupResult: () => QueryResult;
  let membersResult: () => QueryResult;
  const GROUP_ROW = { id: FAMILY_ID, name: '山田家', member_limit: 6, status: 'active' };
  const MEMBER_LIST = [{ id: NEW_SELF_MEMBER_ID, role: 'representative', display_name: '太郎', user_id: USER_ID }];

  function dashboardReadable() {
    inFamilyProfile();
    groupResult = () => ({ data: GROUP_ROW, error: null });
    membersResult = () => ({ data: MEMBER_LIST, error: null });
    supabaseState.responders.family_groups = () => groupResult();
    supabaseState.responders.family_members = () => membersResult();
  }

  it('家族グループを読み込めなかったら、読み込めなかった文と「再試行」を出し、「再試行」で読めたら家族を出す', async () => {
    dashboardReadable();
    groupResult = () => ({ data: null, error: LOAD_FAILURE });
    await renderElement(createElement(FamilyDashboardPage));

    expect(byTestId('family-dashboard-load-error')).toContain(DASHBOARD_LOAD_ERROR);
    expect(text()).not.toContain(GROUP_NOT_FOUND);

    groupResult = () => ({ data: GROUP_ROW, error: null });
    await click(findButton('再試行'), '「再試行」');

    expect(byTestId('family-dashboard-load-error')).toBeNull();
    expect(text()).toContain('山田家');
    expect(text()).toContain('太郎');
  });

  it('メンバーを読み込めなかったら、読み込めなかった文と「再試行」を出し (家族グループの名前だけの画面にしない)、「再試行」で読めたらメンバーを出す', async () => {
    dashboardReadable();
    membersResult = () => ({ data: null, error: LOAD_FAILURE });
    await renderElement(createElement(FamilyDashboardPage));

    expect(byTestId('family-dashboard-load-error')).toContain(DASHBOARD_LOAD_ERROR);
    expect(text()).not.toContain('メンバー情報の取得に失敗しました');

    membersResult = () => ({ data: MEMBER_LIST, error: null });
    await click(findButton('再試行'), '「再試行」');

    expect(byTestId('family-dashboard-load-error')).toBeNull();
    expect(text()).toContain('山田家');
    expect(text()).toContain('太郎');
  });

  it('(対照) 家族グループの行が無い (PGRST116) ときは、これまでどおりの文を出し、「再試行」を出さない', async () => {
    dashboardReadable();
    groupResult = () => ({ data: null, error: NO_ROWS });
    await renderElement(createElement(FamilyDashboardPage));

    expect(byTestId('family-dashboard-load-error')).toBeNull();
    expect(text()).toContain(GROUP_NOT_FOUND);
    expect(findButton('再試行')).toBeUndefined();
  });

  it('一度読めたあとの「再試行」でメンバーを読み込めなかったら、前のメンバーを出したままにせず、読み込めなかった文を出す', async () => {
    dashboardReadable();
    groupResult = () => ({ data: null, error: LOAD_FAILURE });
    await renderElement(createElement(FamilyDashboardPage));
    groupResult = () => ({ data: GROUP_ROW, error: null });
    membersResult = () => ({ data: null, error: LOAD_FAILURE });

    await click(findButton('再試行'), '「再試行」');

    expect(byTestId('family-dashboard-load-error')).toContain(DASHBOARD_LOAD_ERROR);
  });
});
