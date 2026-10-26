/**
 * #2064 (10/26 のデプロイ後整合ゲート 1026i の日の横断の続き) R4・R5 と同じ型の、家族の画面と脱退・除名のテスト
 *
 *   - R4 と同じ型 (読み込めなかったのを、別の状態と見せる・catch が無い):
 *     - 家族の代表者の譲渡の承諾の画面 (/family/transfer-accept/[proposal_id]): 提案の問い合わせの失敗を、
 *       無い / 見えないときと同じ「譲渡提案が見つかりません」と見せていた。提案者・家族名の問い合わせは error を見ず、
 *       try / catch が無く、問い合わせが例外を投げると「読み込み中…」のまま止まっていた。
 *       直したあとは、読み込めなかった旨の文と「再試行」を出し、「譲渡提案が見つかりません」は提案の行が無い (PGRST116) ときだけ出す
 *     - 家族のメンバーの画面 (/family/members): 自分のプロフィールを読み込めなかったのを「家族に入っていない」として家族の作成の画面へ移し、
 *       メンバーの一覧の失敗を空の一覧と見せていた (除名のあとの読み直しが失敗したときに、空の一覧と見せないため)
 *   - R5 と同じ型 (書き込みの通信が reject したとき、読み直さない):
 *     - 家族の承諾の画面の承諾・拒否: 提案を読み直す (読み直すあいだもボタンを止める)
 *     - 組織のメンバーの画面・設定のメンバーシップの画面・家族のメンバーの画面の脱退: 自分のプロフィールを読み直し、
 *       抜けていれば成功のときと同じ遷移にする。読み直しも失敗したら、失敗の文に「状態を確かめられませんでした」を添える
 *     - 家族のメンバーの画面の除名: 一覧を読み直す。メンバーの詳細の画面の除名: そのメンバーの行を読み直し、抜けていれば一覧へ戻る
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const OLD_REP_ID = '44444444-4444-4444-8444-444444444444';
const MEMBER_A_ID = '55555555-5555-4555-8555-555555555555';
const FAMILY_ID = '66666666-6666-4666-8666-666666666666';
const ORG_ID = '77777777-7777-4777-8777-777777777777';
const PROPOSAL_ID = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';

/** 画面の文 (画面と同じもの) */
const PROPOSAL_NOT_FOUND = '譲渡提案が見つかりません';
const PROPOSAL_LOAD_ERROR = '譲渡の提案を読み込めませんでした。しばらくしてから、もう一度お試しください。';
const FAMILY_NETWORK_ERROR = '通信エラーが発生しました';
const ORG_LEAVE_NETWORK_FAILURE = '脱退失敗: 通信エラーが発生しました。通信状況を確認して、もう一度お試しください';
const FAMILY_MEMBERS_LOAD_ERROR = '家族のメンバーを読み込めませんでした。しばらくしてから、もう一度お試しください。';
const STATE_UNCONFIRMED = '状態を確かめられませんでした';
const SETTINGS_FAMILY_LEAVE_NETWORK_FAILURE = '家族からの脱退に失敗しました: 通信エラーが発生しました。通信状況を確認して、もう一度お試しください';
const SETTINGS_ORG_LEAVE_NETWORK_FAILURE = '組織からの脱退に失敗しました: 通信エラーが発生しました。通信状況を確認して、もう一度お試しください';

/** .single() で行が無いときの PostgREST の失敗 */
const NO_ROWS = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };
/** 行が無いのではなく、読み込めなかった失敗 */
const LOAD_FAILURE = { code: '57014', message: 'canceling statement due to statement timeout' };

type QueryResult = { data: unknown; error: unknown };
type QueryKind = 'single' | 'maybeSingle' | 'list';
/** 問い合わせ 1 回の中身 (表・終わり方・select の列・eq の条件) */
interface QueryContext {
  table: string;
  kind: QueryKind;
  columns: string;
  filters: Record<string, unknown>;
}
/** 表ごとの応答。呼ぶたびに決める (読み直しで中身を変えるため)。reject を返すと例外の筋書きになる */
type Responder = (ctx: QueryContext) => QueryResult | Promise<QueryResult>;

const supabaseState = vi.hoisted(() => ({
  /** auth.getUser が投げるか */
  getUserThrows: false,
  /** 表ごとの応答 */
  responders: {} as Record<string, unknown>,
  /** 送った問い合わせ */
  queries: [] as Array<{ table: string; kind: string; columns: string; filters: Record<string, unknown> }>,
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
  proposal_id: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44',
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

// アニメーションは本題ではないので、motion.* は同じタグの素の要素、AnimatePresence は子をそのまま返す
vi.mock('framer-motion', () => {
  const MOTION_ONLY_PROPS = ['initial', 'animate', 'exit', 'transition', 'layout'];
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!cache.has(tag)) {
          cache.set(tag, (props: Record<string, unknown>) =>
            createElement(
              tag,
              Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'children' && !MOTION_ONLY_PROPS.includes(key))),
              props.children as React.ReactNode,
            ),
          );
        }
        return cache.get(tag);
      },
    },
  );
  return { motion, AnimatePresence: (props: { children?: React.ReactNode }) => props.children ?? null };
});

// 画面に出す名前の補完は本題ではないので、そのまま返す
vi.mock('@/lib/membership/family-member-names', () => ({
  fetchFamilyMemberNames: async () => new Map<string, string>(),
  applyFamilyMemberNames: <T,>(members: T[]) => members,
}));

// 画面は Supabase の問い合わせで読む。表ごとに応答を分ける。
// 終わり方は single / maybeSingle と、そのまま await する (一覧) の 3 つ
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
      neq: () => query,
      in: () => query,
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
      getUser: () =>
        supabaseState.getUserThrows
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve({ data: { user: { id: USER_ID } }, error: null }),
    },
    from: (table: string) => builder(table),
  };
  return { createClient: () => client };
});

const { default: FamilyTransferAcceptPage } = await import('@/app/(main)/family/transfer-accept/[proposal_id]/page');
const { default: OrgMembersPage } = await import('@/app/(org)/org/members/page');
const { default: FamilyMembersPage } = await import('@/app/(main)/family/members/page');
const { default: FamilyMemberDetailPage } = await import('@/app/(main)/family/members/[id]/page');
const { default: MembershipSettingsPage } = await import('@/app/(main)/settings/membership/page');

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
let alertSpy: ReturnType<typeof vi.fn>;
let unhandled: unknown[];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

type Handler = (method: string, url: URL) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    return handler(method, url);
  });
  vi.stubGlobal('fetch', fetchMock);
}

const callsOf = (method: string, pathname: string) =>
  fetchMock.mock.calls.filter(([input, init]) => {
    const m = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    return m === method && new URL(String(input), 'http://localhost').pathname === pathname;
  });

/** 送った問い合わせの数 (表と終わり方で絞る) */
const queryCount = (table: string, kind?: QueryKind) =>
  supabaseState.queries.filter((q) => q.table === table && (kind === undefined || q.kind === kind)).length;

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

/** 文が label を含むボタン (アイコンや説明の文を含むボタン用) */
function findButtonContaining(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
}

async function click(element: HTMLElement | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeDefined();
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
  alertSpy = vi.fn();
  vi.stubGlobal('alert', alertSpy);
  mockFetch((method, url) => {
    throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
  });
  router.push.mockReset();
  router.replace.mockReset();
  router.back.mockReset();
  supabaseState.getUserThrows = false;
  supabaseState.responders = {};
  supabaseState.queries = [];
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
// F1 R4 と同じ型: 家族の代表者の譲渡の承諾の画面の読み込み
// ─────────────────────────────────────────────────────────────────────────────

/** 山田家の代表者から、ログイン中の自分への譲渡提案。期限内で pending */
const PROPOSAL = {
  id: PROPOSAL_ID,
  scope: 'family',
  scope_id: FAMILY_ID,
  from_user_id: OLD_REP_ID,
  to_user_id: USER_ID,
  status: 'pending',
  proposed_at: '2026-10-01T00:00:00.000Z',
  expires_at: '2999-01-01T00:00:00.000Z',
};
const FAMILY_NAME = '山田家';
const ACCEPT_LABEL = '承諾する (代表者になる)';
const DECLINE_LABEL = '拒否する';

/** 3 つの問い合わせ (提案・提案者・家族名) がすべて読める状態にする。関数を渡すと、呼ぶたびに応答を決める */
function proposalReadable(
  overrides: { proposal?: () => QueryResult | Promise<QueryResult>; fromUser?: QueryResult; family?: QueryResult } = {},
) {
  supabaseState.responders.ownership_transfer_proposals = overrides.proposal ?? (() => ({ data: PROPOSAL, error: null }));
  supabaseState.responders.user_profiles = () => overrides.fromUser ?? { data: { nickname: '花子' }, error: null };
  supabaseState.responders.family_groups = () => overrides.family ?? { data: { name: FAMILY_NAME }, error: null };
}

const proposalQueryCount = () => queryCount('ownership_transfer_proposals');
const transferLoadErrorBox = () => byTestId('family-transfer-accept-load-error');

describe('#2064 F1 家族の代表者の譲渡の承諾: 読み込めなかったことを「譲渡提案が見つかりません」と見せない', () => {
  it('提案の問い合わせが失敗したら、読み込めなかった文と「再試行」を出し、「譲渡提案が見つかりません」を出さない', async () => {
    proposalReadable({ proposal: () => ({ data: null, error: LOAD_FAILURE }) });
    await renderElement(createElement(FamilyTransferAcceptPage));

    expect(transferLoadErrorBox()).toContain(PROPOSAL_LOAD_ERROR);
    expect(findButton('再試行')).toBeDefined();
    expect(text()).not.toContain(PROPOSAL_NOT_FOUND);
    expect(findButton(ACCEPT_LABEL)).toBeUndefined();
    expect(findButton(DECLINE_LABEL)).toBeUndefined();
  });

  it('提案の行が無い (PGRST116) ときは、これまでどおり「譲渡提案が見つかりません」を出す (読み込めなかった文は出さない)', async () => {
    proposalReadable({ proposal: () => ({ data: null, error: NO_ROWS }) });
    await renderElement(createElement(FamilyTransferAcceptPage));

    expect(text()).toContain(PROPOSAL_NOT_FOUND);
    expect(transferLoadErrorBox()).toBeNull();
    expect(findButton('再試行')).toBeUndefined();
    expect(findButton('戻る')).toBeDefined();
    // 提案者・家族名は問い合わせない
    expect(queryCount('user_profiles')).toBe(0);
    expect(queryCount('family_groups')).toBe(0);
  });

  it('提案者の問い合わせが失敗したら、読み込めなかった文を出し、承諾・拒否を出さない', async () => {
    proposalReadable({ fromUser: { data: null, error: LOAD_FAILURE } });
    await renderElement(createElement(FamilyTransferAcceptPage));

    expect(transferLoadErrorBox()).toContain(PROPOSAL_LOAD_ERROR);
    expect(findButton(ACCEPT_LABEL)).toBeUndefined();
  });

  it('家族名の問い合わせが失敗したら、読み込めなかった文を出し、承諾・拒否を出さない', async () => {
    proposalReadable({ family: { data: null, error: LOAD_FAILURE } });
    await renderElement(createElement(FamilyTransferAcceptPage));

    expect(transferLoadErrorBox()).toContain(PROPOSAL_LOAD_ERROR);
    expect(findButton(ACCEPT_LABEL)).toBeUndefined();
    expect(findButton(DECLINE_LABEL)).toBeUndefined();
  });

  it('提案者・家族名を RLS で読めない (PGRST116) ときは、これまでどおり「代表者」「家族グループ」と出し、承諾・拒否を出す', async () => {
    proposalReadable({ fromUser: { data: null, error: NO_ROWS }, family: { data: null, error: NO_ROWS } });
    await renderElement(createElement(FamilyTransferAcceptPage));

    expect(transferLoadErrorBox()).toBeNull();
    expect(text()).toContain('代表者 様から');
    expect(text()).toContain('「家族グループ」の');
    expect(findButton(ACCEPT_LABEL)).toBeDefined();
    expect(findButton(DECLINE_LABEL)).toBeDefined();
  });

  it('ログインの確認が例外を投げても、読み込み中のまま止まらず、未処理の reject にせず、読み込めなかった文を出す', async () => {
    supabaseState.getUserThrows = true;
    await renderElement(createElement(FamilyTransferAcceptPage));

    expect(text()).not.toContain('読み込み中');
    expect(transferLoadErrorBox()).toContain(PROPOSAL_LOAD_ERROR);
    expect(text()).not.toContain(PROPOSAL_NOT_FOUND);
    expect(unhandled).toEqual([]);
  });

  it('提案の問い合わせが例外を投げても、読み込めなかった文を出す', async () => {
    proposalReadable({ proposal: () => Promise.reject(new TypeError('Failed to fetch')) });
    await renderElement(createElement(FamilyTransferAcceptPage));

    expect(text()).not.toContain('読み込み中');
    expect(transferLoadErrorBox()).toContain(PROPOSAL_LOAD_ERROR);
    expect(unhandled).toEqual([]);
  });

  it('「再試行」で読み直し、読めたら提案と承諾・拒否を出す', async () => {
    let loads = 0;
    proposalReadable({
      proposal: () => {
        loads += 1;
        return loads === 1 ? { data: null, error: LOAD_FAILURE } : { data: PROPOSAL, error: null };
      },
    });
    await renderElement(createElement(FamilyTransferAcceptPage));
    expect(proposalQueryCount()).toBe(1);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(proposalQueryCount()).toBe(2);
    expect(transferLoadErrorBox()).toBeNull();
    expect(text()).toContain(FAMILY_NAME);
    expect(text()).toContain('花子');
    expect(findButton(ACCEPT_LABEL)).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F1 R5 と同じ型: 承諾・拒否の通信エラーのあとの読み直し
// ─────────────────────────────────────────────────────────────────────────────

describe('#2064 F1 家族の代表者の譲渡の承諾: 承諾・拒否の通信が失敗 (reject) したら、提案を読み直す', () => {
  const ACCEPT_PATH = `/api/family/representative-transfer/${PROPOSAL_ID}/accept`;
  const DECLINE_PATH = `/api/family/representative-transfer/${PROPOSAL_ID}/decline`;

  /** サーバーの提案の状態。承諾・拒否の POST を受け取った時点で変えてから、応答の前に通信が切れる */
  function serverAppliesThenDisconnects(path: string, nextStatus: string) {
    let status = PROPOSAL.status;
    proposalReadable({ proposal: () => ({ data: { ...PROPOSAL, status }, error: null }) });
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === path) {
        status = nextStatus;
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  it('サーバーが承諾を済ませてから応答が切れたとき、通信エラーの文を出したうえで読み直し、承諾・拒否のボタンを消す', async () => {
    serverAppliesThenDisconnects(ACCEPT_PATH, 'accepted');
    await renderElement(createElement(FamilyTransferAcceptPage));
    expect(proposalQueryCount()).toBe(1);

    await click(findButton(ACCEPT_LABEL), '「承諾する」ボタン');

    expect(callsOf('POST', ACCEPT_PATH)).toHaveLength(1);
    expect(proposalQueryCount()).toBe(2);
    expect(text()).toContain(FAMILY_NETWORK_ERROR);
    expect(text()).toContain('この提案は既に処理されています');
    expect(findButton(ACCEPT_LABEL)).toBeUndefined();
    expect(findButton(DECLINE_LABEL)).toBeUndefined();
    expect(unhandled).toEqual([]);
  });

  it('サーバーが拒否を済ませてから応答が切れたとき、読み直して処理済みと出す', async () => {
    serverAppliesThenDisconnects(DECLINE_PATH, 'rejected');
    await renderElement(createElement(FamilyTransferAcceptPage));

    await click(findButton(DECLINE_LABEL), '「拒否する」ボタン');

    expect(callsOf('POST', DECLINE_PATH)).toHaveLength(1);
    expect(proposalQueryCount()).toBe(2);
    expect(text()).toContain(FAMILY_NETWORK_ERROR);
    expect(text()).toContain('この提案は既に処理されています');
    expect(findButton(ACCEPT_LABEL)).toBeUndefined();
  });

  it('読み直しの応答を待つあいだは、承諾・拒否のボタンを止めたままにする', async () => {
    const reload = deferred<QueryResult>();
    let loads = 0;
    proposalReadable({
      proposal: () => {
        loads += 1;
        return loads === 1 ? { data: PROPOSAL, error: null } : reload.promise;
      },
    });
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(FamilyTransferAcceptPage));

    await click(findButton(ACCEPT_LABEL), '「承諾する」ボタン');

    // 読み直しの応答はまだ届いていない
    expect(proposalQueryCount()).toBe(2);
    expect(findButton(DECLINE_LABEL)!.disabled).toBe(true);
    expect(findButtonContaining('承諾中')!.disabled).toBe(true);

    await act(async () => {
      reload.resolve({ data: { ...PROPOSAL, status: 'accepted' }, error: null });
    });
    await settle();
    expect(findButton(ACCEPT_LABEL)).toBeUndefined();
    expect(findButton(DECLINE_LABEL)).toBeUndefined();
  });

  it('承諾の通信が失敗し、読み直しも失敗したら、通信エラーの文と読み込めなかった文と「再試行」を出す', async () => {
    let loads = 0;
    proposalReadable({
      proposal: () => {
        loads += 1;
        return loads === 1 ? { data: PROPOSAL, error: null } : { data: null, error: LOAD_FAILURE };
      },
    });
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(FamilyTransferAcceptPage));

    await click(findButton(ACCEPT_LABEL), '「承諾する」ボタン');

    expect(proposalQueryCount()).toBe(2);
    expect(transferLoadErrorBox()).toContain(PROPOSAL_LOAD_ERROR);
    expect(transferLoadErrorBox()).toContain(FAMILY_NETWORK_ERROR);
    expect(findButton('再試行')).toBeDefined();
    expect(findButton(ACCEPT_LABEL)).toBeUndefined();
    expect(unhandled).toEqual([]);
  });

  it('応答が届いたうえでの失敗 (4xx) は、承諾されていないので読み直さない (これまでどおり)', async () => {
    proposalReadable();
    mockFetch(() => jsonResponse(409, { error: { code: 'PROPOSAL_NOT_PENDING', message: 'この提案はすでに処理されています' } }));
    await renderElement(createElement(FamilyTransferAcceptPage));

    await click(findButton(ACCEPT_LABEL), '「承諾する」ボタン');

    expect(proposalQueryCount()).toBe(1);
    expect(text()).toContain('この提案はすでに処理されています');
    expect(findButton(ACCEPT_LABEL)).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 R5 と同じ型: 組織のメンバーの画面の脱退
// ─────────────────────────────────────────────────────────────────────────────

describe('#2064 F2 組織のメンバー: 脱退の通信が失敗 (reject) したら、自分のプロフィールを読み直す', () => {
  const LEAVE_PATH = '/api/org/leave';
  const MEMBERS = [
    { id: USER_ID, nickname: 'わたし', org_role: 'member', joined_org_at: '2026-10-01T03:00:00.000Z' },
    { id: MEMBER_A_ID, nickname: 'Aさん', org_role: 'owner', joined_org_at: '2026-09-01T03:00:00.000Z' },
  ];

  /** 自分のプロフィール (組織の ID は state.orgId)。再読み込みの応答は reread で差し替える */
  function orgMembersReadable(state: { orgId: string | null; reread?: () => QueryResult | Promise<QueryResult> }) {
    let profileReads = 0;
    supabaseState.responders.user_profiles = (ctx: QueryContext) => {
      if (ctx.kind === 'list') return { data: MEMBERS, error: null };
      profileReads += 1;
      if (profileReads > 1 && state.reread) return state.reread();
      return {
        data: { org_role: 'member', organization_id: state.orgId, family_id: null },
        error: null,
      };
    };
  }

  it('サーバーが脱退を済ませてから応答が切れたとき、読み直して組織を抜けていれば、成功のときと同じくホームへ移る (失敗の文は出さない)', async () => {
    const state = { orgId: ORG_ID as string | null };
    orgMembersReadable(state);
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === LEAVE_PATH) {
        state.orgId = null;
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(OrgMembersPage));

    await click(findButton('組織を脱退'), '「組織を脱退」ボタン');

    expect(callsOf('POST', LEAVE_PATH)).toHaveLength(1);
    expect(queryCount('user_profiles', 'single')).toBe(2);
    expect(router.push).toHaveBeenCalledWith('/home');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('読み直して組織に残っていれば、これまでどおり「脱退失敗」と通信エラーの文を出し、ホームへ移らない', async () => {
    orgMembersReadable({ orgId: ORG_ID });
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(OrgMembersPage));

    await click(findButton('組織を脱退'), '「組織を脱退」ボタン');

    expect(queryCount('user_profiles', 'single')).toBe(2);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(ORG_LEAVE_NETWORK_FAILURE);
    expect(router.push).not.toHaveBeenCalled();
    expect(findButton('組織を脱退')!.disabled).toBe(false);
  });

  it('読み直しも失敗したら、「脱退失敗」の文に「状態を確かめられませんでした」を添える', async () => {
    orgMembersReadable({ orgId: ORG_ID, reread: () => ({ data: null, error: LOAD_FAILURE }) });
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(OrgMembersPage));

    await click(findButton('組織を脱退'), '「組織を脱退」ボタン');

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const message = String(alertSpy.mock.calls[0][0]);
    expect(message.startsWith(ORG_LEAVE_NETWORK_FAILURE)).toBe(true);
    expect(message).toContain(STATE_UNCONFIRMED);
    expect(router.push).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it('読み直しが例外を投げても、「状態を確かめられませんでした」を添えて、未処理の reject にしない', async () => {
    orgMembersReadable({ orgId: ORG_ID, reread: () => Promise.reject(new TypeError('Failed to fetch')) });
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(OrgMembersPage));

    await click(findButton('組織を脱退'), '「組織を脱退」ボタン');

    expect(String(alertSpy.mock.calls[0][0])).toContain(STATE_UNCONFIRMED);
    expect(unhandled).toEqual([]);
  });

  it('読み直しの応答を待つあいだは、脱退のボタンを止めたままにする', async () => {
    const reread = deferred<QueryResult>();
    orgMembersReadable({ orgId: ORG_ID, reread: () => reread.promise });
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(OrgMembersPage));

    await click(findButton('組織を脱退'), '「組織を脱退」ボタン');

    expect(alertSpy).not.toHaveBeenCalled();
    expect(findButton('処理中...')!.disabled).toBe(true);

    await act(async () => {
      reread.resolve({ data: { org_role: 'member', organization_id: ORG_ID, family_id: null }, error: null });
    });
    await settle();
    expect(alertSpy).toHaveBeenCalledWith(ORG_LEAVE_NETWORK_FAILURE);
    expect(findButton('組織を脱退')!.disabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 R5 と同じ型: 家族のメンバーの画面の除名・脱退 (と、読み直しが失敗したときの R4 と同じ型)
// ─────────────────────────────────────────────────────────────────────────────

describe('#2064 F2 家族のメンバー: 除名・脱退の通信が失敗 (reject) したら読み直す', () => {
  const REP = { id: 'm-rep', role: 'representative', display_name: '花子', user_id: OLD_REP_ID, child_profile: null, status: 'active' };
  const ME = { id: 'm-me', role: 'adult', display_name: 'わたし', user_id: USER_ID, child_profile: null, status: 'active' };
  const CHILD = { id: MEMBER_A_ID, role: 'child', display_name: 'たろう', user_id: null, child_profile: {}, status: 'active' };
  const REMOVE_PATH = `/api/family/members/${MEMBER_A_ID}/remove`;
  const LEAVE_PATH = '/api/family/leave';

  /** 家族のメンバーの画面が読む 3 つの表。応答は state で変えられる */
  function familyReadable(state: {
    familyId?: string | null;
    members?: () => QueryResult | Promise<QueryResult>;
    profile?: () => QueryResult | Promise<QueryResult>;
  }) {
    supabaseState.responders.user_profiles =
      state.profile ?? (() => ({ data: { family_id: state.familyId ?? FAMILY_ID, organization_id: null }, error: null }));
    supabaseState.responders.family_groups = () => ({ data: { id: FAMILY_ID, name: FAMILY_NAME, member_limit: 6 }, error: null });
    supabaseState.responders.family_members = state.members ?? (() => ({ data: [REP, ME, CHILD], error: null }));
  }

  const familyLoadErrorBox = () => byTestId('family-members-load-error');

  it('サーバーが除名を済ませてから応答が切れたとき、通信エラーの文を出したうえで一覧を読み直し、除名したメンバーを消す', async () => {
    let removed = false;
    familyReadable({ members: () => ({ data: removed ? [REP, ME] : [REP, ME, CHILD], error: null }) });
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === REMOVE_PATH) {
        removed = true;
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyMembersPage));
    expect(text()).toContain('たろう');
    expect(queryCount('family_members', 'list')).toBe(1);

    await click(findButton('除名'), 'たろうの「除名」ボタン');

    expect(callsOf('POST', REMOVE_PATH)).toHaveLength(1);
    expect(alertSpy).toHaveBeenCalledWith(FAMILY_NETWORK_ERROR);
    expect(queryCount('family_members', 'list')).toBe(2);
    expect(text()).not.toContain('たろう');
    expect(findButton('除名')).toBeUndefined();
    expect(unhandled).toEqual([]);
  });

  it('除名の通信が失敗し、一覧の読み直しも失敗したら、空の一覧と見せず、読み込めなかった文と「再試行」を出す', async () => {
    let loads = 0;
    familyReadable({
      members: () => {
        loads += 1;
        return loads === 1 ? { data: [REP, ME, CHILD], error: null } : { data: null, error: LOAD_FAILURE };
      },
    });
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(FamilyMembersPage));

    await click(findButton('除名'), 'たろうの「除名」ボタン');

    expect(familyLoadErrorBox()).toContain(FAMILY_MEMBERS_LOAD_ERROR);
    expect(findButton('再試行')).toBeDefined();
  });

  it('除名の通信を待つあいだ (読み直しを含む) は、ほかの除名と脱退のボタンも止める', async () => {
    const CHILD_B = { ...CHILD, id: 'm-child-b', display_name: 'じろう' };
    const reload = deferred<QueryResult>();
    let loads = 0;
    familyReadable({
      members: () => {
        loads += 1;
        return loads === 1 ? { data: [REP, ME, CHILD, CHILD_B], error: null } : reload.promise;
      },
    });
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(FamilyMembersPage));

    const removeButtons = () => Array.from(container.querySelectorAll('button')).filter((b) => b.textContent?.trim() === '除名');
    await click(removeButtons()[0], 'たろうの「除名」ボタン');

    expect(removeButtons().every((b) => b.disabled)).toBe(true);
    expect(findButtonContaining('家族グループから脱退')!.disabled).toBe(true);
    // 止めたボタンを押しても送らない
    await click(removeButtons()[1], 'じろうの「除名」ボタン');
    expect(callsOf('POST', '/api/family/members/m-child-b/remove')).toHaveLength(0);

    await act(async () => {
      reload.resolve({ data: [REP, ME, CHILD_B], error: null });
    });
    await settle();
    expect(removeButtons()).toHaveLength(1);
    expect(removeButtons()[0].disabled).toBe(false);
  });

  it('応答が届いたうえでの除名の失敗 (4xx) は、これまでどおり理由の文を出し、一覧を読み直さない', async () => {
    familyReadable({});
    mockFetch(() => jsonResponse(403, { error: { code: 'NOT_FAMILY_ADULT' } }));
    await renderElement(createElement(FamilyMembersPage));

    await click(findButton('除名'), 'たろうの「除名」ボタン');

    expect(String(alertSpy.mock.calls[0][0]).startsWith('除名に失敗しました: ')).toBe(true);
    expect(queryCount('family_members', 'list')).toBe(1);
    expect(text()).toContain('たろう');
  });

  it('サーバーが脱退を済ませてから応答が切れたとき、読み直して家族を抜けていれば、成功のときと同じく家族の作成の画面へ移る', async () => {
    const state = { familyId: FAMILY_ID as string | null };
    familyReadable({ profile: () => ({ data: { family_id: state.familyId, organization_id: null }, error: null }) });
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === LEAVE_PATH) {
        state.familyId = null;
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyMembersPage));

    await click(findButtonContaining('家族グループから脱退'), '「家族グループから脱退」ボタン');

    expect(callsOf('POST', LEAVE_PATH)).toHaveLength(1);
    expect(queryCount('user_profiles', 'single')).toBe(2);
    expect(router.replace).toHaveBeenCalledWith('/family/setup');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('脱退の通信が失敗し、読み直して家族に残っていれば、これまでどおり通信エラーの文を出し、移らない', async () => {
    familyReadable({});
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(FamilyMembersPage));

    await click(findButtonContaining('家族グループから脱退'), '「家族グループから脱退」ボタン');

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith(FAMILY_NETWORK_ERROR);
    expect(router.replace).not.toHaveBeenCalled();
    expect(findButtonContaining('家族グループから脱退')!.disabled).toBe(false);
  });

  it('脱退の通信が失敗し、読み直しも失敗したら、通信エラーの文に「状態を確かめられませんでした」を添える', async () => {
    let profileReads = 0;
    familyReadable({
      profile: () => {
        profileReads += 1;
        return profileReads === 1
          ? { data: { family_id: FAMILY_ID, organization_id: null }, error: null }
          : { data: null, error: LOAD_FAILURE };
      },
    });
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(FamilyMembersPage));

    await click(findButtonContaining('家族グループから脱退'), '「家族グループから脱退」ボタン');

    const message = String(alertSpy.mock.calls[0][0]);
    expect(message.startsWith(FAMILY_NETWORK_ERROR)).toBe(true);
    expect(message).toContain(STATE_UNCONFIRMED);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('画面を開いたとき自分のプロフィールを読み込めなかったら、家族の作成の画面へ移さず、読み込めなかった文と「再試行」を出す', async () => {
    let profileReads = 0;
    familyReadable({
      profile: () => {
        profileReads += 1;
        return profileReads === 1
          ? { data: null, error: LOAD_FAILURE }
          : { data: { family_id: FAMILY_ID, organization_id: null }, error: null };
      },
    });
    await renderElement(createElement(FamilyMembersPage));

    expect(router.replace).not.toHaveBeenCalled();
    expect(familyLoadErrorBox()).toContain(FAMILY_MEMBERS_LOAD_ERROR);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(familyLoadErrorBox()).toBeNull();
    expect(text()).toContain('たろう');
  });

  it('画面を開いたときメンバーの一覧を読み込めなかったら、空の一覧と見せず、読み込めなかった文を出す', async () => {
    familyReadable({ members: () => ({ data: null, error: LOAD_FAILURE }) });
    await renderElement(createElement(FamilyMembersPage));

    expect(familyLoadErrorBox()).toContain(FAMILY_MEMBERS_LOAD_ERROR);
    expect(text()).not.toContain('0/6 人');
  });

  it('画面を開いたとき問い合わせが例外を投げても、読み込み中のまま止まらず、読み込めなかった文を出す', async () => {
    supabaseState.getUserThrows = true;
    await renderElement(createElement(FamilyMembersPage));

    expect(text()).not.toContain('読み込み中');
    expect(familyLoadErrorBox()).toContain(FAMILY_MEMBERS_LOAD_ERROR);
    expect(unhandled).toEqual([]);
  });

  it('家族に入っていない (family_id が空) ときは、これまでどおり家族の作成の画面へ移す', async () => {
    familyReadable({ profile: () => ({ data: { family_id: null, organization_id: null }, error: null }) });
    await renderElement(createElement(FamilyMembersPage));

    expect(router.replace).toHaveBeenCalledWith('/family/setup');
    expect(familyLoadErrorBox()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 R5 と同じ型: 家族のメンバーの詳細の画面の除名
// ─────────────────────────────────────────────────────────────────────────────

describe('#2064 F2 家族のメンバーの詳細: 除名の通信が失敗 (reject) したら、そのメンバーの行を読み直す', () => {
  const REMOVE_PATH = `/api/family/members/${MEMBER_A_ID}/remove`;
  const DETAIL = {
    id: MEMBER_A_ID,
    role: 'adult',
    display_name: 'Aさん',
    user_id: OLD_REP_ID,
    child_profile: null,
    birth_date: null,
    share_meals: true,
    share_health: false,
    share_menu: true,
    joined_at: '2026-10-01T00:00:00.000Z',
  };

  /** 詳細の画面が読む表。除名のあとの読み直し (status = active の maybeSingle) の応答は reread で決める */
  function detailReadable(reread: () => QueryResult | Promise<QueryResult>) {
    supabaseState.responders.user_profiles = () => ({ data: { family_id: FAMILY_ID }, error: null });
    supabaseState.responders.family_members = (ctx: QueryContext) => {
      if (ctx.kind === 'maybeSingle') return reread();
      if (ctx.filters.user_id === USER_ID) return { data: { role: 'representative' }, error: null };
      return { data: DETAIL, error: null };
    };
  }

  const activeRereads = () =>
    supabaseState.queries.filter((q) => q.table === 'family_members' && q.kind === 'maybeSingle' && q.filters.status === 'active');

  it('サーバーが除名を済ませてから応答が切れたとき、読み直して行が無ければ、成功のときと同じく一覧へ戻る (失敗の文は出さない)', async () => {
    detailReadable(() => ({ data: null, error: null }));
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(FamilyMemberDetailPage));

    await click(findButtonContaining('家族から外す'), '「家族から外す」ボタン');

    expect(callsOf('POST', REMOVE_PATH)).toHaveLength(1);
    expect(activeRereads()).toHaveLength(1);
    expect(activeRereads()[0].filters.id).toBe(MEMBER_A_ID);
    expect(router.replace).toHaveBeenCalledWith('/family/members');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('読み直してまだ家族にいれば、これまどおり通信エラーの文を出し、一覧へ戻らない', async () => {
    detailReadable(() => ({ data: { id: MEMBER_A_ID }, error: null }));
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(FamilyMemberDetailPage));

    await click(findButtonContaining('家族から外す'), '「家族から外す」ボタン');

    expect(alertSpy).toHaveBeenCalledWith(FAMILY_NETWORK_ERROR);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('読み直しも失敗したら、通信エラーの文に「状態を確かめられませんでした」を添える', async () => {
    detailReadable(() => ({ data: null, error: LOAD_FAILURE }));
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(FamilyMemberDetailPage));

    await click(findButtonContaining('家族から外す'), '「家族から外す」ボタン');

    const message = String(alertSpy.mock.calls[0][0]);
    expect(message.startsWith(FAMILY_NETWORK_ERROR)).toBe(true);
    expect(message).toContain(STATE_UNCONFIRMED);
    expect(router.replace).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 R5 と同じ型: 設定のメンバーシップの画面の脱退 (家族・組織)
// ─────────────────────────────────────────────────────────────────────────────

describe('#2064 F2 設定のメンバーシップ: 脱退の通信が失敗 (reject) したら、自分のプロフィールを読み直す', () => {
  /** 自分は山田家の大人、ほめゴハン株式会社のメンバー。プロフィールの所属は state で変えられる */
  function membershipReadable(state: {
    familyId: string | null;
    orgId: string | null;
    reread?: () => QueryResult | Promise<QueryResult>;
  }) {
    let profileReads = 0;
    supabaseState.responders.user_profiles = () => {
      profileReads += 1;
      if (profileReads > 1 && state.reread) return state.reread();
      return {
        data: { family_id: state.familyId, organization_id: state.orgId, org_role: 'member', nickname: 'わたし' },
        error: null,
      };
    };
    supabaseState.responders.family_members = () => ({
      data: { id: 'm-me', role: 'adult', share_meals: true, share_health: false, share_menu: true },
      error: null,
    });
    supabaseState.responders.family_groups = () => ({ data: { id: FAMILY_ID, name: FAMILY_NAME }, error: null });
    supabaseState.responders.organizations = () => ({ data: { id: ORG_ID, name: 'ほめゴハン株式会社' }, error: null });
  }

  async function openAndConfirm(openLabel: string) {
    await click(findButton(openLabel), `「${openLabel}」ボタン`);
    await click(findButton('脱退する'), '「脱退する」ボタン');
  }

  it('家族の脱退: サーバーが済ませてから応答が切れ、読み直して家族を抜けていれば、成功のときと同じく設定へ移る', async () => {
    const state = { familyId: FAMILY_ID as string | null, orgId: ORG_ID as string | null };
    membershipReadable(state);
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === '/api/family/leave') {
        state.familyId = null;
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(MembershipSettingsPage));

    await openAndConfirm('家族から脱退');

    expect(callsOf('POST', '/api/family/leave')).toHaveLength(1);
    expect(router.push).toHaveBeenCalledWith('/settings');
    expect(text()).not.toContain('脱退に失敗しました');
  });

  it('家族の脱退: 読み直して家族に残っていれば、英語の内部の文ではなく通信エラーの文を出し、移らない', async () => {
    membershipReadable({ familyId: FAMILY_ID, orgId: ORG_ID });
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(MembershipSettingsPage));

    await openAndConfirm('家族から脱退');

    expect(text()).toContain(SETTINGS_FAMILY_LEAVE_NETWORK_FAILURE);
    expect(text()).not.toContain('Failed to fetch');
    expect(text()).not.toContain(STATE_UNCONFIRMED);
    expect(router.push).not.toHaveBeenCalled();
    expect(findButton('脱退する')!.disabled).toBe(false);
  });

  it('家族の脱退: 読み直しも失敗したら、失敗の文に「状態を確かめられませんでした」を添える', async () => {
    membershipReadable({ familyId: FAMILY_ID, orgId: ORG_ID, reread: () => ({ data: null, error: LOAD_FAILURE }) });
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(MembershipSettingsPage));

    await openAndConfirm('家族から脱退');

    expect(text()).toContain(SETTINGS_FAMILY_LEAVE_NETWORK_FAILURE);
    expect(text()).toContain(STATE_UNCONFIRMED);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('組織の脱退: サーバーが済ませてから応答が切れ、読み直して組織を抜けていれば、成功のときと同じく設定へ移る', async () => {
    const state = { familyId: FAMILY_ID as string | null, orgId: ORG_ID as string | null };
    membershipReadable(state);
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === '/api/org/leave') {
        state.orgId = null;
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(MembershipSettingsPage));

    await openAndConfirm('組織から脱退');

    expect(callsOf('POST', '/api/org/leave')).toHaveLength(1);
    expect(router.push).toHaveBeenCalledWith('/settings');
  });

  it('組織の脱退: 読み直して組織に残っていれば、通信エラーの文を出し、移らない', async () => {
    membershipReadable({ familyId: FAMILY_ID, orgId: ORG_ID });
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderElement(createElement(MembershipSettingsPage));

    await openAndConfirm('組織から脱退');

    expect(text()).toContain(SETTINGS_ORG_LEAVE_NETWORK_FAILURE);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('応答が届いたうえでの失敗 (4xx) は、これまでどおり理由の文を出し、読み直さない', async () => {
    membershipReadable({ familyId: FAMILY_ID, orgId: ORG_ID });
    mockFetch(() => jsonResponse(409, { error: { code: 'IS_FAMILY_REPRESENTATIVE' } }));
    await renderElement(createElement(MembershipSettingsPage));
    const profileReadsBefore = queryCount('user_profiles');

    await openAndConfirm('家族から脱退');

    expect(text()).toContain('家族からの脱退に失敗しました: ');
    expect(text()).not.toContain('通信エラー');
    expect(queryCount('user_profiles')).toBe(profileReadsBefore);
  });
});
