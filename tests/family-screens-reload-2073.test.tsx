/**
 * #2073 (triage-1027a) S2・S3・S5・S8: 家族の画面と譲渡の提案の送信のテスト
 *
 *   - S3 (読み込めなかったのを、別の状態と見せる): 自分のプロフィールを読み込めなかったのを「家族に入っていない」として
 *     家族の作成の画面 (/family/setup) へ送っていた (家族のダッシュボード・メンバーの詳細・招待・子どもの追加・昇格の依頼)。
 *     設定のメンバーシップは「所属していません」と家族グループの作成への案内を出していた。
 *     直したあとは、読み込めなかった文と「再試行」を出し、家族の作成の画面へは family_id が空のときだけ送る
 *   - S2 (書き込みの通信が reject したとき、読み直さない): 共有の設定は楽観的に変えた値を元に戻していた (サーバーでは更新済みのことがある)。
 *     子どもの追加・招待・昇格の依頼の送信と取り消し・家族の作成は、通信エラーの文を出すだけで、送り直すと二重になっていた。
 *     直したあとは、サーバーの状態を読み直し、済んでいれば成功のときと同じ表示にする
 *   - S5: 家族の承諾の画面が処理済みの提案に「既に処理されています (ステータス: accepted)」と英字の値を出していた
 *   - S8: 組織・家族の譲渡の提案の送信が reject したとき、提案を作れたか確かめず、送り直すと譲渡先にメールが 2 通届いていた
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readPendingTransferProposal,
  transferProposalStateAfterNetworkFailure,
  type PendingTransferProposalRead,
} from '@/lib/membership/transfer-proposal-state';
import {
  TRANSFER_PROPOSAL_PROCESSED_MESSAGE,
  TRANSFER_PROPOSAL_STATUS_MESSAGES,
  transferProposalStatusMessage,
} from '@/lib/membership/transfer-proposal-status';
import {
  FAMILY_ROLE_LABELS,
  ORG_ROLE_LABELS,
  ROLE_UNKNOWN_LABEL,
  familyRoleLabel,
  orgRoleLabel,
} from '@/lib/membership/role-labels';
import { readOwnShareSettingsAfterNetworkFailure } from '@/lib/membership/share-settings-state';
import { SELF_DISSOLVE_CONFIRM_KEYWORD, SELF_DISSOLVE_COPY, selfDissolveApiPath } from '@/lib/membership/self-dissolve';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const OLD_REP_ID = '44444444-4444-4444-8444-444444444444';
const MEMBER_A_ID = '55555555-5555-4555-8555-555555555555';
const FAMILY_ID = '66666666-6666-4666-8666-666666666666';
const ORG_ID = '77777777-7777-4777-8777-777777777777';
const PROPOSAL_ID = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';
const OLD_PROPOSAL_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const NEW_PROPOSAL_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';

/** 画面の文 (画面と同じもの) */
const NETWORK_ERROR = '通信エラーが発生しました';
const ORG_NETWORK_ERROR = 'ネットワークエラーが発生しました';
const STATE_UNCONFIRMED = '状態を確かめられませんでした';
const SHARE_UNCONFIRMED = '設定を確かめられませんでした';
const ORG_PROPOSAL_SENT = '譲渡提案を送信しました。対象者がメールから承諾すると、オーナーが変更されます。';

/** 行が無いのではなく、読み込めなかった失敗 */
const LOAD_FAILURE = { code: '57014', message: 'canceling statement due to statement timeout' };
/** .single() で行が無いときの PostgREST の失敗 */
const NO_ROWS = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };
/** .maybeSingle() に行が 2 行以上返ったときの PostgREST の失敗 (絞り込みが足りず、他の人・過去の行まで読めたとき) */
const MULTIPLE_ROWS = {
  code: 'PGRST116',
  message: 'JSON object requested, multiple (or no) rows returned',
  details: 'The result contains 2 rows',
};

type QueryResult = { data: unknown; error: unknown };
type QueryKind = 'single' | 'maybeSingle' | 'list';
/** 問い合わせ 1 回の中身 (表・終わり方・select の列・eq の条件) */
interface QueryContext {
  table: string;
  kind: QueryKind;
  columns: string;
  filters: Record<string, unknown>;
}
/** 表ごとの応答。呼ぶたびに決める (読み直しで中身を変えるため)。投げると例外の筋書きになる */
type Responder = (ctx: QueryContext) => QueryResult | Promise<QueryResult>;

const supabaseState = vi.hoisted(() => ({
  /** 表ごとの応答 */
  responders: {} as Record<string, unknown>,
  /** 送った問い合わせ */
  queries: [] as Array<{ table: string; kind: string; columns: string; filters: Record<string, unknown> }>,
  /** auth.getUser が投げるか */
  getUserThrows: false,
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

/**
 * 問い合わせの eq の条件に expected がすべて含まれているか。
 * 読み直しの応答は、この判定で正しい絞り込みのときだけ行を返す (絞り込みを外したり取り違えたりすると、
 * 本物のデータベースでは別の行が返るか行が見つからない。応答を絞り込みに依存させて、そうした変更でテストを赤にする)
 */
function filtersMatch(ctx: QueryContext, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([column, value]) => ctx.filters[column] === value);
}

/** 送った問い合わせのうち、表 (と select の列) が一致するものの eq の条件 (送った順) */
const filtersOf = (table: string, columns?: string) =>
  supabaseState.queries
    .filter((q) => q.table === table && (columns === undefined || q.columns === columns))
    .map((q) => q.filters);

/** 共有の設定の読み直し (readOwnShareSettingsAfterNetworkFailure) の select の列 */
const SHARE_REREAD_COLUMNS = 'share_meals, share_health, share_menu';
/** 共有の設定の読み直しの絞り込み: 自分の active な行 (1 人 1 行まで)。他の人の行・脱退した行を読まない */
const OWN_ACTIVE_MEMBER_FILTERS = { user_id: USER_ID, status: 'active' };

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

const { createClient } = await import('@/lib/supabase/client');
const { default: FamilyDashboardPage } = await import('@/app/(main)/family/dashboard/page');
const { default: FamilyMemberDetailPage } = await import('@/app/(main)/family/members/[id]/page');
const { default: FamilyInvitePage } = await import('@/app/(main)/family/members/invite/page');
const { default: FamilyChildNewPage } = await import('@/app/(main)/family/members/child/new/page');
const { default: PromoteMemberPage } = await import('@/app/(main)/family/members/[id]/promote/page');
const { default: FamilySetupPage } = await import('@/app/(main)/family/setup/page');
const { default: MembershipSettingsPage } = await import('@/app/(main)/settings/membership/page');
const { default: FamilyTransferAcceptPage } = await import('@/app/(main)/family/transfer-accept/[proposal_id]/page');
const { default: OrgTransferAcceptPage } = await import('@/app/(main)/org/transfer-accept/[proposal_id]/page');
const { default: OwnerTransferPage } = await import('@/app/(org)/org/settings/owner-transfer/page');
const { default: FamilyRepresentativeTransferPage } = await import('@/app/(main)/family/representative-transfer/page');

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

async function click(element: HTMLElement | null | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeTruthy();
  await act(async () => {
    element!.click();
  });
  await settle();
}

/** 制御された入力欄に値を入れる (React は value の setter を見張っているので、元の setter で入れてから input を投げる) */
async function setValue(input: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  expect(input, '入力欄が見つからない').toBeTruthy();
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const text = () => container.textContent ?? '';
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]');

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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

/** 自分のプロフィールの応答 (single)。既定は家族に入っている */
function profileResponds(result: () => QueryResult) {
  supabaseState.responders.user_profiles = (ctx: QueryContext) => {
    if (ctx.kind === 'single' && ctx.filters.id === USER_ID) return result();
    return { data: null, error: NO_ROWS };
  };
}
const inFamily = (): QueryResult => ({ data: { family_id: FAMILY_ID }, error: null });
const profileLoadFails = (): QueryResult => ({ data: null, error: LOAD_FAILURE });
const notInFamily = (): QueryResult => ({ data: { family_id: null }, error: null });

// ─────────────────────────────────────────────────────────────────────────────
// 共有の部品 (純関数)
// ─────────────────────────────────────────────────────────────────────────────

describe('#2073 S8 譲渡の提案の送信のあとの確かめ (transferProposalStateAfterNetworkFailure)', () => {
  const read = (proposal: { id: string; to_user_id: string } | null): PendingTransferProposalRead => ({ ok: true, proposal });
  const failed: PendingTransferProposalRead = { ok: false };

  it('送る前に pending が無く、あとで選んだ譲渡先への pending があれば、作れている', () => {
    expect(transferProposalStateAfterNetworkFailure(read(null), read({ id: NEW_PROPOSAL_ID, to_user_id: MEMBER_A_ID }), MEMBER_A_ID)).toBe('sent');
  });

  it('送る前の提案 (同じ譲渡先) が別の新しい提案に置き換わっていれば、作れている', () => {
    expect(
      transferProposalStateAfterNetworkFailure(
        read({ id: OLD_PROPOSAL_ID, to_user_id: MEMBER_A_ID }),
        read({ id: NEW_PROPOSAL_ID, to_user_id: MEMBER_A_ID }),
        MEMBER_A_ID,
      ),
    ).toBe('sent');
  });

  it('送る前と同じ提案のままなら、同じ譲渡先宛てでも作れていない (前に送った提案を今回の提案と見なさない)', () => {
    const before = read({ id: OLD_PROPOSAL_ID, to_user_id: MEMBER_A_ID });
    expect(transferProposalStateAfterNetworkFailure(before, read({ id: OLD_PROPOSAL_ID, to_user_id: MEMBER_A_ID }), MEMBER_A_ID)).toBe('not-sent');
  });

  it('pending が無い・別の人宛てなら、作れていない', () => {
    expect(transferProposalStateAfterNetworkFailure(read(null), read(null), MEMBER_A_ID)).toBe('not-sent');
    expect(transferProposalStateAfterNetworkFailure(read(null), read({ id: NEW_PROPOSAL_ID, to_user_id: OLD_REP_ID }), MEMBER_A_ID)).toBe('not-sent');
  });

  it('あとの読み込みが失敗したら確かめられない。送る前が読めず、選んだ譲渡先への pending があるときも確かめられない', () => {
    expect(transferProposalStateAfterNetworkFailure(read(null), failed, MEMBER_A_ID)).toBe('unknown');
    expect(transferProposalStateAfterNetworkFailure(failed, read({ id: NEW_PROPOSAL_ID, to_user_id: MEMBER_A_ID }), MEMBER_A_ID)).toBe('unknown');
    // 送る前が読めなくても、選んだ譲渡先への pending が無ければ作れていない
    expect(transferProposalStateAfterNetworkFailure(failed, read(null), MEMBER_A_ID)).toBe('not-sent');
  });

  it('readPendingTransferProposal は範囲・対象・pending で絞って 1 行を読み、問い合わせの失敗と例外は ok: false にする', async () => {
    supabaseState.responders.ownership_transfer_proposals = () => ({ data: { id: NEW_PROPOSAL_ID, to_user_id: MEMBER_A_ID }, error: null });
    const supabase = createClient();
    expect(await readPendingTransferProposal(supabase, 'family', FAMILY_ID)).toEqual({
      ok: true,
      proposal: { id: NEW_PROPOSAL_ID, to_user_id: MEMBER_A_ID },
    });
    expect(supabaseState.queries.at(-1)).toMatchObject({
      table: 'ownership_transfer_proposals',
      kind: 'maybeSingle',
      filters: { scope: 'family', scope_id: FAMILY_ID, status: 'pending' },
    });

    supabaseState.responders.ownership_transfer_proposals = () => ({ data: null, error: LOAD_FAILURE });
    expect(await readPendingTransferProposal(supabase, 'organization', ORG_ID)).toEqual({ ok: false });
    supabaseState.responders.ownership_transfer_proposals = () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await readPendingTransferProposal(supabase, 'organization', ORG_ID)).toEqual({ ok: false });
  });
});

describe('#2073 S2 共有の設定の読み直し (readOwnShareSettingsAfterNetworkFailure)', () => {
  const OWN_SHARE = { share_meals: false, share_health: true, share_menu: false };

  /** 自分の active な行だけに OWN_SHARE を返す (RLS では同じ家族の他の人の行も読めるので、絞らないと 2 行以上が返る) */
  function ownRowReadable() {
    supabaseState.responders.family_members = (ctx: QueryContext) =>
      filtersMatch(ctx, OWN_ACTIVE_MEMBER_FILTERS) ? { data: { ...OWN_SHARE }, error: null } : { data: null, error: MULTIPLE_ROWS };
  }

  it('自分の active な行 (user_id = 自分・status = active) だけを 1 行読み、その share_* を返す', async () => {
    ownRowReadable();

    expect(await readOwnShareSettingsAfterNetworkFailure(createClient())).toEqual({ ok: true, settings: OWN_SHARE });
    expect(supabaseState.queries).toEqual([
      { table: 'family_members', kind: 'maybeSingle', columns: SHARE_REREAD_COLUMNS, filters: OWN_ACTIVE_MEMBER_FILTERS },
    ]);
  });

  it('問い合わせの失敗・行が無い・例外は、確かめられなかった (ok: false) にする', async () => {
    const supabase = createClient();
    supabaseState.responders.family_members = () => ({ data: null, error: LOAD_FAILURE });
    expect(await readOwnShareSettingsAfterNetworkFailure(supabase)).toEqual({ ok: false });
    supabaseState.responders.family_members = () => ({ data: null, error: null });
    expect(await readOwnShareSettingsAfterNetworkFailure(supabase)).toEqual({ ok: false });
    supabaseState.responders.family_members = () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await readOwnShareSettingsAfterNetworkFailure(supabase)).toEqual({ ok: false });
    supabaseState.getUserThrows = true;
    ownRowReadable();
    expect(await readOwnShareSettingsAfterNetworkFailure(supabase)).toEqual({ ok: false });
  });
});

describe('#2073 S5 譲渡の提案の状態の文 (transferProposalStatusMessage)', () => {
  it('処理済みの状態は日本語の文で、内部の英字の値を返さない', () => {
    expect(transferProposalStatusMessage('accepted', false)).toBe(TRANSFER_PROPOSAL_STATUS_MESSAGES.accepted);
    expect(transferProposalStatusMessage('rejected', false)).toBe(TRANSFER_PROPOSAL_STATUS_MESSAGES.rejected);
    expect(transferProposalStatusMessage('expired', false)).toBe(TRANSFER_PROPOSAL_STATUS_MESSAGES.expired);
    expect(transferProposalStatusMessage('unexpected_status', false)).toBe(TRANSFER_PROPOSAL_PROCESSED_MESSAGE);
    for (const status of ['accepted', 'rejected', 'expired', 'unexpected_status']) {
      expect(transferProposalStatusMessage(status, false)).not.toContain(status);
    }
  });

  it('pending は期限内なら null (承諾・拒否ができる)、期限が過ぎていれば期限切れの文', () => {
    expect(transferProposalStatusMessage('pending', false)).toBeNull();
    expect(transferProposalStatusMessage('pending', true)).toBe(TRANSFER_PROPOSAL_STATUS_MESSAGES.expired);
  });

  it('承諾済み・拒否済みは、期限が過ぎていてもその文を出す', () => {
    expect(transferProposalStatusMessage('accepted', true)).toBe(TRANSFER_PROPOSAL_STATUS_MESSAGES.accepted);
    expect(transferProposalStatusMessage('rejected', true)).toBe(TRANSFER_PROPOSAL_STATUS_MESSAGES.rejected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S5: 承諾の画面
// ─────────────────────────────────────────────────────────────────────────────

/** 譲渡提案 (自分宛て・期限内)。状態を変えて使う */
function proposalRow(status: string, scope: 'family' | 'organization') {
  return {
    id: PROPOSAL_ID,
    scope,
    scope_id: scope === 'family' ? FAMILY_ID : ORG_ID,
    from_user_id: OLD_REP_ID,
    to_user_id: USER_ID,
    status,
    proposed_at: '2026-10-01T00:00:00.000Z',
    expires_at: '2999-01-01T00:00:00.000Z',
    reason: null,
  };
}

describe('#2073 役割の表示名 (orgRoleLabel / familyRoleLabel)', () => {
  it('組織の役割 (org_role_enum の 3 つ) を日本語にする', () => {
    expect(orgRoleLabel('owner')).toBe('オーナー');
    expect(orgRoleLabel('admin')).toBe('管理者');
    expect(orgRoleLabel('member')).toBe('メンバー');
    expect(Object.keys(ORG_ROLE_LABELS).sort()).toEqual(['admin', 'member', 'owner']);
  });

  it('家族の役割 (family_role_enum の 3 つ) を日本語にする', () => {
    expect(familyRoleLabel('representative')).toBe('代表');
    expect(familyRoleLabel('adult')).toBe('大人');
    expect(familyRoleLabel('child')).toBe('子供');
    expect(Object.keys(FAMILY_ROLE_LABELS).sort()).toEqual(['adult', 'child', 'representative']);
  });

  it('表に無い値・null・undefined・Object の組み込みの名前は、内部の値を出さず固定の文にする', () => {
    for (const role of ['unexpected_role', '', null, undefined, 'toString', '__proto__', 'constructor']) {
      expect(orgRoleLabel(role)).toBe(ROLE_UNKNOWN_LABEL);
      expect(familyRoleLabel(role)).toBe(ROLE_UNKNOWN_LABEL);
    }
    // 組織と家族の役割の名前は混ざらない (家族の画面に組織の語を出さない)
    expect(familyRoleLabel('owner')).toBe(ROLE_UNKNOWN_LABEL);
    expect(orgRoleLabel('adult')).toBe(ROLE_UNKNOWN_LABEL);
  });
});

describe('#2073 S5 家族の代表者の譲渡の承諾: 処理済みの提案の状態を英字で出さない', () => {
  function proposalIs(status: string) {
    supabaseState.responders.ownership_transfer_proposals = () => ({ data: proposalRow(status, 'family'), error: null });
    supabaseState.responders.user_profiles = () => ({ data: { nickname: '花子' }, error: null });
    supabaseState.responders.family_groups = () => ({ data: { name: '山田家' }, error: null });
  }

  it.each([
    ['accepted', 'この提案はすでに承諾済みです'],
    ['rejected', 'この提案は拒否済みです'],
    ['expired', 'この提案は期限切れです'],
  ])('状態が %s なら「%s」と出し、英字の状態と承諾・拒否のボタンを出さない', async (status, message) => {
    proposalIs(status);
    await renderElement(createElement(FamilyTransferAcceptPage));

    expect(byTestId('transfer-proposal-status')).toBe(message);
    expect(text()).not.toContain(status);
    expect(text()).not.toContain('ステータス');
    expect(findButton('承諾する (代表者になる)')).toBeUndefined();
    expect(findButton('拒否する')).toBeUndefined();
  });

  it('pending で期限内なら、状態の文を出さず、承諾・拒否のボタンを出す (これまでどおり)', async () => {
    proposalIs('pending');
    await renderElement(createElement(FamilyTransferAcceptPage));

    expect(byTestId('transfer-proposal-status')).toBeNull();
    expect(findButton('承諾する (代表者になる)')).toBeDefined();
    expect(findButton('拒否する')).toBeDefined();
  });
});

describe('#2073 S5 組織のオーナーの譲渡の承諾: 同じ対応表で、置き換わった (expired) 提案に承諾・拒否を出さない', () => {
  function proposalIs(status: string) {
    supabaseState.responders.ownership_transfer_proposals = () => ({ data: proposalRow(status, 'organization'), error: null });
    supabaseState.responders.user_profiles = () => ({ data: { nickname: '花子' }, error: null });
    supabaseState.responders.organizations = () => ({ data: { name: '株式会社テスト' }, error: null });
  }

  it('状態が expired (期限の日時はまだ先) なら、期限切れの文を出し、承諾・拒否のボタンを出さない', async () => {
    proposalIs('expired');
    await renderElement(createElement(OrgTransferAcceptPage));

    expect(text()).toContain('この提案は期限切れです');
    expect(findButton('承諾')).toBeUndefined();
    expect(findButton('拒否')).toBeUndefined();
  });

  it('pending で期限内なら、承諾・拒否のボタンを出す (これまでどおり)', async () => {
    proposalIs('pending');
    await renderElement(createElement(OrgTransferAcceptPage));

    expect(findButton('承諾')).toBeDefined();
    expect(findButton('拒否')).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3: 自分のプロフィールを読み込めなかったときに、家族の作成の画面へ送らない
// ─────────────────────────────────────────────────────────────────────────────

describe('#2073 S3 家族のダッシュボード: 読み込めなかったのを「家族に入っていない」と見なさない', () => {
  function familyReadable() {
    profileResponds(inFamily);
    supabaseState.responders.family_groups = () => ({
      data: { id: FAMILY_ID, name: '山田家', member_limit: 6, status: 'active' },
      error: null,
    });
    supabaseState.responders.family_members = () => ({
      data: [{ id: MEMBER_A_ID, role: 'representative', display_name: '太郎', user_id: USER_ID }],
      error: null,
    });
  }

  it('自分のプロフィールを読み込めなかったら、家族の作成の画面へ移さず、読み込めなかった文と「再試行」を出す', async () => {
    familyReadable();
    profileResponds(profileLoadFails);
    await renderElement(createElement(FamilyDashboardPage));

    expect(router.replace).not.toHaveBeenCalledWith('/family/setup');
    expect(byTestId('family-dashboard-load-error')).toContain('家族の情報を読み込めませんでした');
    expect(findButton('再試行')).toBeDefined();
  });

  it('問い合わせが例外を投げても、読み込み中のまま止まらず、未処理の reject にせず、読み込めなかった文を出す', async () => {
    familyReadable();
    supabaseState.getUserThrows = true;
    await renderElement(createElement(FamilyDashboardPage));

    expect(text()).not.toContain('読み込み中');
    expect(byTestId('family-dashboard-load-error')).not.toBeNull();
    expect(unhandled).toEqual([]);
  });

  it('「再試行」で読み直し、読めたら家族を出す', async () => {
    familyReadable();
    profileResponds(profileLoadFails);
    await renderElement(createElement(FamilyDashboardPage));
    profileResponds(inFamily);

    await click(findButton('再試行'), '「再試行」');

    expect(byTestId('family-dashboard-load-error')).toBeNull();
    expect(text()).toContain('山田家');
    expect(text()).toContain('太郎');
  });

  it('家族に入っていない (family_id が空) ときは、これまでどおり家族の作成の画面へ移す', async () => {
    familyReadable();
    profileResponds(notInFamily);
    await renderElement(createElement(FamilyDashboardPage));

    expect(router.replace).toHaveBeenCalledWith('/family/setup');
    expect(byTestId('family-dashboard-load-error')).toBeNull();
  });
});

describe('#2073 S3 家族の招待・子どもの追加・昇格の依頼: 読み込めなかったのを「家族に入っていない」と見なさない', () => {
  it('招待: 自分のプロフィールを読み込めなかったら、家族の作成の画面へ移さず、フォームの代わりに読み込めなかった文と「再試行」を出す', async () => {
    profileResponds(profileLoadFails);
    await renderElement(createElement(FamilyInvitePage));

    expect(router.replace).not.toHaveBeenCalledWith('/family/setup');
    expect(byTestId('family-invite-load-error')).toContain('家族の情報を読み込めませんでした');
    expect(findButton('招待を送信')).toBeUndefined();
  });

  it('招待: 「再試行」で読み直し、読めたらフォームと招待の履歴を出す', async () => {
    profileResponds(profileLoadFails);
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/family/invites') {
        return jsonResponse(200, {
          data: { invites: [{ id: 'inv-1', email: 'a@example.com', status: 'pending', expires_at: '2999-01-01T00:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z' }] },
        });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyInvitePage));
    profileResponds(inFamily);

    await click(findButton('再試行'), '「再試行」');

    expect(byTestId('family-invite-load-error')).toBeNull();
    expect(findButton('招待を送信')).toBeDefined();
    expect(text()).toContain('a@example.com');
  });

  it('招待: 招待の履歴を読み込めなかったら、履歴が無いのと同じに見せず、読み込めなかった文と「再試行」を出す', async () => {
    profileResponds(inFamily);
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/family/invites') return jsonResponse(500, { error: { code: 'RPC_FAILED' } });
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyInvitePage));

    expect(byTestId('family-invites-load-error')).toContain('招待の履歴を読み込めませんでした');
    expect(findButton('招待を送信')).toBeDefined();
  });

  it('招待: 招待の履歴の「再試行」で読み直し、読めたら読み込めなかった文を消して履歴を出す', async () => {
    profileResponds(inFamily);
    let historyFails = true;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/family/invites') {
        if (historyFails) return jsonResponse(500, { error: { code: 'RPC_FAILED' } });
        return jsonResponse(200, {
          data: { invites: [{ id: 'inv-1', email: 'a@example.com', status: 'pending', expires_at: '2999-01-01T00:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z' }] },
        });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyInvitePage));
    expect(byTestId('family-invites-load-error')).not.toBeNull();
    expect(text()).not.toContain('a@example.com');
    historyFails = false;

    const retry = container.querySelector<HTMLButtonElement>('[data-testid="family-invites-load-error"] button');
    await click(retry, '招待の履歴の「再試行」');

    expect(callsOf('GET', '/api/family/invites')).toHaveLength(2);
    expect(byTestId('family-invites-load-error')).toBeNull();
    expect(text()).toContain('a@example.com');
  });

  it('子どもの追加: 自分のプロフィールを読み込めなかったら、家族の作成の画面へ移さず、フォームの代わりに読み込めなかった文と「再試行」を出す', async () => {
    profileResponds(profileLoadFails);
    await renderElement(createElement(FamilyChildNewPage));

    expect(router.replace).not.toHaveBeenCalledWith('/family/setup');
    expect(byTestId('family-child-new-load-error')).toContain('家族の情報を読み込めませんでした');
    expect(submitButton()).toBeNull();

    profileResponds(inFamily);
    await click(findButton('再試行'), '「再試行」');
    expect(byTestId('family-child-new-load-error')).toBeNull();
    expect(submitButton()).not.toBeNull();
  });

  it('子どもの追加: 家族に入っていない (family_id が空) ときは、これまでどおり家族の作成の画面へ移す', async () => {
    profileResponds(notInFamily);
    await renderElement(createElement(FamilyChildNewPage));

    expect(router.replace).toHaveBeenCalledWith('/family/setup');
  });

  it('昇格の依頼: 自分のプロフィールを読み込めなかったら、家族の作成の画面へ移さず、読み込めなかった文と「再試行」を出す', async () => {
    profileResponds(profileLoadFails);
    await renderElement(createElement(PromoteMemberPage));

    expect(router.replace).not.toHaveBeenCalledWith('/family/setup');
    expect(byTestId('family-promote-load-error')).toContain('参加リクエストの情報を読み込めませんでした');
    expect(findButton('再試行')).toBeDefined();
  });

  it('昇格の依頼: 子どもの行を読み込めなかったら、「メンバーが見つかりません」と見せず、読み込めなかった文を出す', async () => {
    profileResponds(inFamily);
    supabaseState.responders.family_members = () => ({ data: null, error: LOAD_FAILURE });
    await renderElement(createElement(PromoteMemberPage));

    expect(text()).not.toContain('メンバーが見つかりません');
    expect(byTestId('family-promote-load-error')).not.toBeNull();
  });

  it('昇格の依頼: 承認待ちの依頼を読み込めなかったら、依頼が無いと見せず (送信のフォームを出さず)、読み込めなかった文を出す', async () => {
    profileResponds(inFamily);
    supabaseState.responders.family_members = () => ({
      data: { id: MEMBER_A_ID, display_name: 'たろう', role: 'child', user_id: null },
      error: null,
    });
    supabaseState.responders.family_promotion_requests = () => ({ data: null, error: LOAD_FAILURE });
    await renderElement(createElement(PromoteMemberPage));

    expect(byTestId('family-promote-load-error')).not.toBeNull();
    expect(findButton('参加リクエストを送信')).toBeUndefined();
  });

  it('昇格の依頼: 子どもの行が無い (PGRST116) ときは、これまでどおり「メンバーが見つかりません」と出す', async () => {
    profileResponds(inFamily);
    supabaseState.responders.family_members = () => ({ data: null, error: NO_ROWS });
    await renderElement(createElement(PromoteMemberPage));

    expect(text()).toContain('メンバーが見つかりません');
    expect(byTestId('family-promote-load-error')).toBeNull();
  });

  it('昇格の依頼: 「再試行」で読み直し、読めたら読み込めなかった文を消して送信のフォームを出す', async () => {
    profileResponds(profileLoadFails);
    supabaseState.responders.family_members = () => ({
      data: { id: MEMBER_A_ID, display_name: 'たろう', role: 'child', user_id: null },
      error: null,
    });
    supabaseState.responders.family_promotion_requests = () => ({ data: null, error: null });
    await renderElement(createElement(PromoteMemberPage));
    expect(byTestId('family-promote-load-error')).not.toBeNull();
    profileResponds(inFamily);

    await click(findButton('再試行'), '「再試行」');

    expect(byTestId('family-promote-load-error')).toBeNull();
    expect(findButton('参加リクエストを送信')).toBeDefined();
  });

  describe('問い合わせが例外を投げたとき (読み込み中のまま止まらず、未処理の reject にせず、読み込めなかった文を出す)', () => {
    beforeEach(() => {
      profileResponds(inFamily);
      supabaseState.getUserThrows = true;
    });

    it('招待: 読み込めなかった文を出し、招待のフォームを出さない', async () => {
      await renderElement(createElement(FamilyInvitePage));

      expect(byTestId('family-invite-load-error')).toContain('家族の情報を読み込めませんでした');
      expect(submitButton()).toBeNull();
      expect(router.replace).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    });

    it('子どもの追加: 読み込めなかった文を出し、追加のフォームを出さない', async () => {
      await renderElement(createElement(FamilyChildNewPage));

      expect(byTestId('family-child-new-load-error')).toContain('家族の情報を読み込めませんでした');
      expect(submitButton()).toBeNull();
      expect(router.replace).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    });

    it('昇格の依頼: 読み込み中のまま止まらず、読み込めなかった文を出し、送信のフォームを出さない', async () => {
      await renderElement(createElement(PromoteMemberPage));

      expect(text()).not.toContain('読み込み中');
      expect(byTestId('family-promote-load-error')).toContain('参加リクエストの情報を読み込めませんでした');
      expect(submitButton()).toBeNull();
      expect(unhandled).toEqual([]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// メンバーの詳細 (S3・S2 の共有の設定)
// ─────────────────────────────────────────────────────────────────────────────

describe('#2073 メンバーの詳細: 読み込めなかったのを別の状態と見せず (S3)、共有の設定の通信が切れたらサーバーの値を読み直す (S2)', () => {
  /** サーバーの自分の共有の設定 (読み直しで返す値) */
  let serverShare: { share_meals: boolean; share_health: boolean; share_menu: boolean };
  let shareRereadFails: boolean;
  const SHARE_PATH = '/api/family/members/me/share';

  function selfMemberReadable() {
    serverShare = { share_meals: true, share_health: false, share_menu: true };
    shareRereadFails = false;
    profileResponds(inFamily);
    supabaseState.responders.family_members = (ctx: QueryContext) => {
      if (ctx.kind === 'maybeSingle' && ctx.columns === SHARE_REREAD_COLUMNS) {
        // 共有の設定の読み直し (自分の active な行)
        if (shareRereadFails) return { data: null, error: LOAD_FAILURE };
        // RLS では同じ家族の他の人の行も読めるので、自分の active な行に絞らないと 2 行以上が返って失敗する
        if (!filtersMatch(ctx, OWN_ACTIVE_MEMBER_FILTERS)) return { data: null, error: MULTIPLE_ROWS };
        return { data: { ...serverShare }, error: null };
      }
      if (ctx.columns === 'role') return { data: { role: 'adult' }, error: null };
      return {
        data: {
          id: MEMBER_A_ID,
          role: 'adult',
          display_name: '自分',
          user_id: USER_ID,
          child_profile: null,
          birth_date: null,
          ...serverShare,
          joined_at: '2026-01-01T00:00:00.000Z',
        },
        error: null,
      };
    };
  }

  const healthSwitch = () => container.querySelectorAll<HTMLButtonElement>('[role="switch"]')[1];

  it('自分のプロフィールを読み込めなかったら、家族の作成の画面へ移さず、読み込めなかった文と「再試行」を出す', async () => {
    selfMemberReadable();
    profileResponds(profileLoadFails);
    await renderElement(createElement(FamilyMemberDetailPage));

    expect(router.replace).not.toHaveBeenCalledWith('/family/setup');
    expect(byTestId('family-member-detail-load-error')).toContain('メンバーの情報を読み込めませんでした');

    profileResponds(inFamily);
    await click(findButton('再試行'), '「再試行」');
    expect(byTestId('family-member-detail-load-error')).toBeNull();
    expect(healthSwitch()).toBeDefined();
  });

  it('自分の役割を読み込めなかったら、権限なし (操作を出さない) と見せず、読み込めなかった文を出す', async () => {
    selfMemberReadable();
    const base = supabaseState.responders.family_members as Responder;
    supabaseState.responders.family_members = (ctx: QueryContext) =>
      ctx.columns === 'role' ? { data: null, error: LOAD_FAILURE } : base(ctx);
    await renderElement(createElement(FamilyMemberDetailPage));

    expect(byTestId('family-member-detail-load-error')).not.toBeNull();
  });

  describe('自分の役割の行が無い (PGRST116) ときは、読み込めなかったとせず、権限なしとする', () => {
    const OTHER_NAME = '花子';
    /** 他人 (大人) の詳細を開く。自分の役割の問い合わせは myRole で返す */
    function otherMemberReadable(myRole: () => QueryResult) {
      selfMemberReadable();
      const base = supabaseState.responders.family_members as Responder;
      supabaseState.responders.family_members = (ctx: QueryContext) => {
        if (ctx.columns === 'role') return myRole();
        if (ctx.kind === 'single') {
          const own = base(ctx) as QueryResult;
          return { data: { ...(own.data as Record<string, unknown>), display_name: OTHER_NAME, user_id: OLD_REP_ID }, error: null };
        }
        return base(ctx);
      };
    }

    it('読み込めなかった文を出さず、メンバーの情報を出し、管理の操作 (家族から外す) を出さない', async () => {
      otherMemberReadable(() => ({ data: null, error: NO_ROWS }));
      await renderElement(createElement(FamilyMemberDetailPage));

      expect(byTestId('family-member-detail-load-error')).toBeNull();
      expect(text()).toContain(OTHER_NAME);
      expect(text()).not.toContain('家族から外す');
    });

    it('(対照) 自分が代表なら、同じメンバーに管理の操作 (家族から外す) を出す', async () => {
      otherMemberReadable(() => ({ data: { role: 'representative' }, error: null }));
      await renderElement(createElement(FamilyMemberDetailPage));

      expect(text()).toContain(OTHER_NAME);
      expect(text()).toContain('家族から外す');
    });
  });

  it('問い合わせが例外を投げても、読み込み中のまま止まらず、未処理の reject にしない', async () => {
    selfMemberReadable();
    supabaseState.getUserThrows = true;
    await renderElement(createElement(FamilyMemberDetailPage));

    expect(text()).not.toContain('読み込み中');
    expect(byTestId('family-member-detail-load-error')).not.toBeNull();
    expect(unhandled).toEqual([]);
  });

  it('サーバーが共有の更新を済ませてから応答が切れたとき、元に戻さず、読み直した値 (有効) を出し、失敗の文を出さない', async () => {
    selfMemberReadable();
    mockFetch((method, url) => {
      if (method === 'PATCH' && url.pathname === SHARE_PATH) {
        serverShare = { ...serverShare, share_health: true };
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyMemberDetailPage));
    expect(healthSwitch().getAttribute('aria-checked')).toBe('false');

    await click(healthSwitch(), '健康の共有の切り替え');

    expect(callsOf('PATCH', SHARE_PATH)).toHaveLength(1);
    expect(queryCount('family_members', 'maybeSingle')).toBe(1);
    // 読み直すのは自分の active な行だけ (他の人の値を出さない)
    expect(filtersOf('family_members', SHARE_REREAD_COLUMNS)).toEqual([OWN_ACTIVE_MEMBER_FILTERS]);
    expect(healthSwitch().getAttribute('aria-checked')).toBe('true');
    expect(alertSpy).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it('更新できていなければ、読み直した値 (無効) を出し、通信エラーの文を出す', async () => {
    selfMemberReadable();
    mockFetch((method, url) => {
      if (method === 'PATCH' && url.pathname === SHARE_PATH) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyMemberDetailPage));

    await click(healthSwitch(), '健康の共有の切り替え');

    expect(healthSwitch().getAttribute('aria-checked')).toBe('false');
    expect(alertSpy).toHaveBeenCalledWith(NETWORK_ERROR);
  });

  it('読み直しも失敗したら、切り替える前の値に戻し、通信エラーの文に「設定を確かめられませんでした」を添える', async () => {
    selfMemberReadable();
    mockFetch((method, url) => {
      if (method === 'PATCH' && url.pathname === SHARE_PATH) {
        shareRereadFails = true;
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyMemberDetailPage));

    await click(healthSwitch(), '健康の共有の切り替え');

    expect(healthSwitch().getAttribute('aria-checked')).toBe('false');
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(String(alertSpy.mock.calls[0][0])).toContain(NETWORK_ERROR);
    expect(String(alertSpy.mock.calls[0][0])).toContain(SHARE_UNCONFIRMED);
  });

  it('読み直しの応答を待つあいだは、共有の切り替えを止めたままにする', async () => {
    selfMemberReadable();
    const reread = deferred<QueryResult>();
    const base = supabaseState.responders.family_members as Responder;
    let rereadStarted = false;
    supabaseState.responders.family_members = (ctx: QueryContext) => {
      if (ctx.kind === 'maybeSingle') {
        rereadStarted = true;
        return reread.promise;
      }
      return base(ctx);
    };
    mockFetch((method, url) => {
      if (method === 'PATCH' && url.pathname === SHARE_PATH) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyMemberDetailPage));

    await click(healthSwitch(), '健康の共有の切り替え');
    expect(rereadStarted).toBe(true);
    expect(healthSwitch().disabled).toBe(true);

    await act(async () => {
      reread.resolve({ data: { share_meals: true, share_health: true, share_menu: true }, error: null });
    });
    await settle();
    expect(healthSwitch().disabled).toBe(false);
  });

  it('応答が届いたうえでの失敗 (4xx) は、更新されていないので元に戻し、読み直さない (これまでどおり)', async () => {
    selfMemberReadable();
    mockFetch((method, url) => {
      if (method === 'PATCH' && url.pathname === SHARE_PATH) return jsonResponse(400, { error: { code: 'VALIDATION_ERROR' } });
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyMemberDetailPage));

    await click(healthSwitch(), '健康の共有の切り替え');

    expect(healthSwitch().getAttribute('aria-checked')).toBe('false');
    expect(queryCount('family_members', 'maybeSingle')).toBe(0);
    expect(alertSpy).toHaveBeenCalledWith('共有設定の更新に失敗しました');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 設定のメンバーシップ (S3・S2 の共有の設定)
// ─────────────────────────────────────────────────────────────────────────────

describe('#2073 設定のメンバーシップ: 読み込めなかったのを「所属していません」と見せず (S3)、共有の設定の通信が切れたら読み直す (S2)', () => {
  let serverShare: { share_meals: boolean; share_health: boolean; share_menu: boolean };
  const SHARE_PATH = '/api/family/members/me/share';

  function membershipReadable() {
    serverShare = { share_meals: true, share_health: false, share_menu: true };
    supabaseState.responders.user_profiles = () => ({
      data: { family_id: FAMILY_ID, organization_id: null, org_role: null, nickname: '太郎' },
      error: null,
    });
    supabaseState.responders.family_members = (ctx: QueryContext) => {
      // 画面を開いたときの読み込みも、共有の設定の読み直しも、自分の active な行を読む。
      // RLS では同じ家族の他の人の行も読めるので、絞らないと 2 行以上が返って失敗する
      if (!filtersMatch(ctx, OWN_ACTIVE_MEMBER_FILTERS)) return { data: null, error: MULTIPLE_ROWS };
      return { data: { id: MEMBER_A_ID, role: 'adult', ...serverShare }, error: null };
    };
    supabaseState.responders.family_groups = () => ({ data: { id: FAMILY_ID, name: '山田家' }, error: null });
  }

  const healthSwitch = () => container.querySelector<HTMLButtonElement>('[aria-label="健康記録の共有"]');

  it('自分のプロフィールを読み込めなかったら、「所属していません」と家族グループの作成への案内を出さず、読み込めなかった文と「再試行」を出す', async () => {
    membershipReadable();
    supabaseState.responders.user_profiles = () => ({ data: null, error: LOAD_FAILURE });
    await renderElement(createElement(MembershipSettingsPage));

    expect(byTestId('settings-membership-load-error')).toContain('所属の情報を読み込めませんでした');
    expect(text()).not.toContain('所属していません');
    expect(findButton('家族グループを作成・参加')).toBeUndefined();

    membershipReadable();
    await click(findButton('再試行'), '「再試行」');
    expect(byTestId('settings-membership-load-error')).toBeNull();
    expect(text()).toContain('山田家');
  });

  it('家族の中の自分の行を読み込めなかったら、「所属していません」と見せず、読み込めなかった文を出す', async () => {
    membershipReadable();
    supabaseState.responders.family_members = () => ({ data: null, error: LOAD_FAILURE });
    await renderElement(createElement(MembershipSettingsPage));

    expect(byTestId('settings-membership-load-error')).not.toBeNull();
    expect(text()).not.toContain('所属していません');
  });

  it('問い合わせが例外を投げても、「所属していません」と見せず、読み込めなかった文を出す', async () => {
    membershipReadable();
    supabaseState.getUserThrows = true;
    await renderElement(createElement(MembershipSettingsPage));

    expect(byTestId('settings-membership-load-error')).not.toBeNull();
    expect(text()).not.toContain('所属していません');
    expect(unhandled).toEqual([]);
  });

  it('所属していない (family_id・organization_id が空) ときは、これまでどおり「所属していません」と出す', async () => {
    membershipReadable();
    supabaseState.responders.user_profiles = () => ({
      data: { family_id: null, organization_id: null, org_role: null, nickname: '太郎' },
      error: null,
    });
    await renderElement(createElement(MembershipSettingsPage));

    expect(byTestId('settings-membership-load-error')).toBeNull();
    expect(text()).toContain('所属していません');
  });

  it('サーバーが共有の更新を済ませてから応答が切れたとき、元に戻さず、読み直した値 (有効) を出し、失敗の文を出さない', async () => {
    membershipReadable();
    mockFetch((method, url) => {
      if (method === 'PATCH' && url.pathname === SHARE_PATH) {
        serverShare = { ...serverShare, share_health: true };
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(MembershipSettingsPage));
    expect(healthSwitch()?.getAttribute('aria-checked')).toBe('false');

    await click(healthSwitch(), '健康記録の共有の切り替え');

    expect(callsOf('PATCH', SHARE_PATH)).toHaveLength(1);
    // 読み直すのは自分の active な行だけ (他の人の値を出さない)
    expect(filtersOf('family_members', SHARE_REREAD_COLUMNS)).toEqual([OWN_ACTIVE_MEMBER_FILTERS]);
    expect(healthSwitch()?.getAttribute('aria-checked')).toBe('true');
    expect(byTestId('settings-share-error')).toBeNull();
    expect(unhandled).toEqual([]);
  });

  it('更新できていなければ、読み直した値 (無効) を出し、通信エラーの文を出す', async () => {
    membershipReadable();
    mockFetch((method, url) => {
      if (method === 'PATCH' && url.pathname === SHARE_PATH) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(MembershipSettingsPage));

    await click(healthSwitch(), '健康記録の共有の切り替え');

    expect(healthSwitch()?.getAttribute('aria-checked')).toBe('false');
    expect(byTestId('settings-share-error')).toContain(NETWORK_ERROR);
  });

  it('読み直しも失敗したら、切り替える前の値に戻し、「設定を確かめられませんでした」を添える', async () => {
    membershipReadable();
    mockFetch((method, url) => {
      if (method === 'PATCH' && url.pathname === SHARE_PATH) {
        supabaseState.responders.family_members = () => ({ data: null, error: LOAD_FAILURE });
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(MembershipSettingsPage));

    await click(healthSwitch(), '健康記録の共有の切り替え');

    expect(healthSwitch()?.getAttribute('aria-checked')).toBe('false');
    expect(byTestId('settings-share-error')).toContain(SHARE_UNCONFIRMED);
  });

  it('応答が届いたうえでの失敗 (4xx) は、元に戻して失敗の文を出し、読み直さない', async () => {
    membershipReadable();
    mockFetch((method, url) => {
      if (method === 'PATCH' && url.pathname === SHARE_PATH) return jsonResponse(400, { error: { code: 'VALIDATION_ERROR' } });
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(MembershipSettingsPage));
    const loadQueries = queryCount('family_members');

    await click(healthSwitch(), '健康記録の共有の切り替え');

    expect(healthSwitch()?.getAttribute('aria-checked')).toBe('false');
    expect(queryCount('family_members')).toBe(loadQueries);
    expect(byTestId('settings-share-error')).toBe('共有設定の更新に失敗しました');
  });

  it('読み直しの応答を待つあいだは、共有の切り替えを止めたままにする', async () => {
    membershipReadable();
    const reread = deferred<QueryResult>();
    let rereadStarted = false;
    const base = supabaseState.responders.family_members as Responder;
    supabaseState.responders.family_members = (ctx: QueryContext) => {
      // 共有の設定の読み直しは share_* の列だけを読む (画面を開いたときの読み込みは id・role も読む)
      if (ctx.columns === 'share_meals, share_health, share_menu') {
        rereadStarted = true;
        return reread.promise;
      }
      return base(ctx);
    };
    mockFetch((method, url) => {
      if (method === 'PATCH' && url.pathname === SHARE_PATH) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(MembershipSettingsPage));
    expect(healthSwitch()?.disabled).toBe(false);

    await click(healthSwitch(), '健康記録の共有の切り替え');
    expect(rereadStarted).toBe(true);
    expect(healthSwitch()?.disabled).toBe(true);
    expect(text()).toContain('保存中...');

    await act(async () => {
      reread.resolve({ data: { share_meals: true, share_health: true, share_menu: true }, error: null });
    });
    await settle();
    expect(healthSwitch()?.disabled).toBe(false);
    expect(healthSwitch()?.getAttribute('aria-checked')).toBe('true');
    expect(text()).not.toContain('保存中...');
  });

  /** 3 つの共有の切り替えの aria-checked (食事・健康・週間献立) */
  const shareSwitchStates = () =>
    ['食事記録の共有', '健康記録の共有', '週間献立の共有'].map((label) =>
      container.querySelector(`[aria-label="${label}"]`)?.getAttribute('aria-checked'),
    );

  it('画面を開いたとき、共有の設定はサーバーの値を出す (画面の既定の値のままにしない)', async () => {
    membershipReadable();
    // 画面の既定の値 (食事 有効・健康 無効・週間献立 有効) とすべて違う値
    serverShare = { share_meals: false, share_health: true, share_menu: false };
    await renderElement(createElement(MembershipSettingsPage));

    expect(shareSwitchStates()).toEqual(['false', 'true', 'false']);
  });

  it('共有の更新の失敗の文は、次の切り替えで消す (前の失敗の文を残さない)', async () => {
    membershipReadable();
    let patchStatus = 400;
    mockFetch((method, url) => {
      if (method === 'PATCH' && url.pathname === SHARE_PATH) {
        return patchStatus === 200 ? jsonResponse(200, { data: { ok: true } }) : jsonResponse(patchStatus, { error: { code: 'VALIDATION_ERROR' } });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(MembershipSettingsPage));

    await click(healthSwitch(), '健康記録の共有の切り替え (1 回目)');
    expect(byTestId('settings-share-error')).toBe('共有設定の更新に失敗しました');

    patchStatus = 200;
    await click(healthSwitch(), '健康記録の共有の切り替え (2 回目)');

    expect(callsOf('PATCH', SHARE_PATH)).toHaveLength(2);
    expect(healthSwitch()?.getAttribute('aria-checked')).toBe('true');
    expect(byTestId('settings-share-error')).toBeNull();
  });

  describe('読み込みの失敗の分岐 (一度読めたあとの読み直し・組織・家族グループ)', () => {
    const ORG_NAME = '山田商事';
    const FAMILY_NAME = '山田家';
    const DISSOLVE_PATH = selfDissolveApiPath('family');
    /** 所属家族の区画の「所属していません」の文の数 (組織と家族の 2 区画にある) */
    const notMemberCount = () =>
      Array.from(container.querySelectorAll('p')).filter((p) => p.textContent === '所属していません').length;
    const spinner = () => container.querySelector('.animate-spin');

    /** 家族 (代表者) と組織 (メンバー) の両方に入っている */
    function bothMembershipsReadable() {
      membershipReadable();
      supabaseState.responders.user_profiles = () => ({
        data: { family_id: FAMILY_ID, organization_id: ORG_ID, org_role: 'member', nickname: '太郎' },
        error: null,
      });
      supabaseState.responders.family_members = () => ({ data: { id: MEMBER_A_ID, role: 'representative', ...serverShare }, error: null });
      supabaseState.responders.organizations = () => ({ data: { id: ORG_ID, name: ORG_NAME }, error: null });
    }

    it('解散のあとの読み直しが失敗したら、解散した所属を外し、もう一方の所属の区画を残して、その上に読み込めなかった文を出す。「再試行」は画面を保ったまま読み直す', async () => {
      bothMembershipsReadable();
      mockFetch((method, url) => {
        if (method === 'POST' && url.pathname === DISSOLVE_PATH) {
          // 解散は済む (200)。そのあとの所属の読み直しだけが失敗する
          supabaseState.responders.user_profiles = () => ({ data: null, error: LOAD_FAILURE });
          return jsonResponse(200, { data: { dissolved_at: '2026-10-27T00:00:00.000Z' } });
        }
        throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      });
      await renderElement(createElement(MembershipSettingsPage));
      expect(text()).toContain(FAMILY_NAME);
      expect(text()).toContain(ORG_NAME);
      expect(notMemberCount()).toBe(0);

      await click(findButton('家族グループを解散'), '「家族グループを解散」');
      await setValue(container.querySelector<HTMLInputElement>('[data-testid="self-dissolve-family-keyword"]'), SELF_DISSOLVE_CONFIRM_KEYWORD);
      await click(container.querySelector<HTMLButtonElement>('[data-testid="self-dissolve-family-submit"]'), '「家族グループを解散する」');

      expect(callsOf('POST', DISSOLVE_PATH)).toHaveLength(1);
      // 解散のあとに所属を読み直した (画面を開いたときと合わせて 2 回)
      expect(queryCount('user_profiles', 'single')).toBe(2);
      expect(text()).toContain(SELF_DISSOLVE_COPY.family.done);
      expect(byTestId('settings-membership-load-error')).toContain('所属の情報を読み込めませんでした');
      // 全体を読み込み中や空の画面にしない: 組織の区画は残り、解散した家族は「所属していません」になる
      expect(spinner()).toBeNull();
      expect(text()).toContain(ORG_NAME);
      expect(findButton('組織から脱退')).toBeDefined();
      expect(text()).not.toContain(FAMILY_NAME);
      expect(notMemberCount()).toBe(1);

      // 「再試行」: 読み直しの応答を待つあいだも、画面 (組織の区画) を保つ
      const retry = deferred<QueryResult>();
      supabaseState.responders.user_profiles = () => retry.promise;
      await click(findButton('再試行'), '「再試行」');
      expect(spinner()).toBeNull();
      expect(text()).toContain(ORG_NAME);

      await act(async () => {
        retry.resolve({ data: { family_id: null, organization_id: ORG_ID, org_role: 'member', nickname: '太郎' }, error: null });
      });
      await settle();
      expect(byTestId('settings-membership-load-error')).toBeNull();
      expect(text()).toContain(ORG_NAME);
      expect(notMemberCount()).toBe(1);
    });

    it('組織の解散のあとの読み直しで、家族の共有の設定が変わっていれば、読み直した値を出す', async () => {
      bothMembershipsReadable();
      supabaseState.responders.user_profiles = () => ({
        data: { family_id: FAMILY_ID, organization_id: ORG_ID, org_role: 'owner', nickname: '太郎' },
        error: null,
      });
      const ORG_DISSOLVE_PATH = selfDissolveApiPath('organization');
      mockFetch((method, url) => {
        if (method === 'POST' && url.pathname === ORG_DISSOLVE_PATH) {
          // 組織の解散は済む (200)。そのあいだに家族の共有の設定が (別の端末で) 変わっている
          supabaseState.responders.user_profiles = () => ({
            data: { family_id: FAMILY_ID, organization_id: null, org_role: null, nickname: '太郎' },
            error: null,
          });
          serverShare = { share_meals: false, share_health: true, share_menu: false };
          return jsonResponse(200, { data: { dissolved_at: '2026-10-27T00:00:00.000Z' } });
        }
        throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      });
      await renderElement(createElement(MembershipSettingsPage));
      expect(shareSwitchStates()).toEqual(['true', 'false', 'true']);

      await click(findButton('組織を解散'), '「組織を解散」');
      await setValue(container.querySelector<HTMLInputElement>('[data-testid="self-dissolve-organization-keyword"]'), SELF_DISSOLVE_CONFIRM_KEYWORD);
      await click(container.querySelector<HTMLButtonElement>('[data-testid="self-dissolve-organization-submit"]'), '「組織を解散する」');

      expect(callsOf('POST', ORG_DISSOLVE_PATH)).toHaveLength(1);
      expect(queryCount('user_profiles', 'single')).toBe(2);
      expect(byTestId('settings-membership-load-error')).toBeNull();
      expect(text()).toContain(FAMILY_NAME);
      expect(text()).not.toContain(ORG_NAME);
      expect(shareSwitchStates()).toEqual(['false', 'true', 'false']);
    });

    it('画面を開いたときに組織を読み込めなかったら、「所属していません」と見せず、読み込めなかった文を出す', async () => {
      membershipReadable();
      supabaseState.responders.user_profiles = () => ({
        data: { family_id: null, organization_id: ORG_ID, org_role: 'member', nickname: '太郎' },
        error: null,
      });
      supabaseState.responders.organizations = () => ({ data: null, error: LOAD_FAILURE });
      await renderElement(createElement(MembershipSettingsPage));

      expect(queryCount('organizations', 'maybeSingle')).toBe(1);
      expect(byTestId('settings-membership-load-error')).toContain('所属の情報を読み込めませんでした');
      expect(notMemberCount()).toBe(0);
      expect(findButton('家族グループを作成・参加')).toBeUndefined();
      expect(spinner()).toBeNull();

      supabaseState.responders.organizations = () => ({ data: { id: ORG_ID, name: ORG_NAME }, error: null });
      await click(findButton('再試行'), '「再試行」');
      expect(byTestId('settings-membership-load-error')).toBeNull();
      expect(text()).toContain(ORG_NAME);
    });

    it('画面を開いたときに家族グループだけを読み込めなかったら、「所属していません」と見せず、読み込めなかった文を出す', async () => {
      membershipReadable();
      supabaseState.responders.family_groups = () => ({ data: null, error: LOAD_FAILURE });
      await renderElement(createElement(MembershipSettingsPage));

      // 家族の中の自分の行は読めている
      expect(queryCount('family_members', 'maybeSingle')).toBe(1);
      expect(byTestId('settings-membership-load-error')).toContain('所属の情報を読み込めませんでした');
      expect(notMemberCount()).toBe(0);
      expect(findButton('家族グループを作成・参加')).toBeUndefined();

      supabaseState.responders.family_groups = () => ({ data: { id: FAMILY_ID, name: FAMILY_NAME }, error: null });
      await click(findButton('再試行'), '「再試行」');
      expect(byTestId('settings-membership-load-error')).toBeNull();
      expect(text()).toContain(FAMILY_NAME);
    });
  });

  describe('組織の役割を内部の英字の値 (owner / admin / member) のまま出さない', () => {
    function orgMemberReadable(orgRole: string | null) {
      membershipReadable();
      supabaseState.responders.user_profiles = () => ({
        data: { family_id: null, organization_id: ORG_ID, org_role: orgRole, nickname: '太郎' },
        error: null,
      });
      supabaseState.responders.organizations = () => ({ data: { id: ORG_ID, name: '山田商事' }, error: null });
    }
    /** 所属組織の区画の「役割: …」の行 */
    const roleLine = () => Array.from(container.querySelectorAll('p')).find((p) => p.textContent?.startsWith('役割:'))?.textContent;

    it.each([
      ['owner', 'オーナー'],
      ['admin', '管理者'],
      ['member', 'メンバー'],
    ])('役割が %s なら「役割: %s」と出し、英字の値を画面の文に出さない', async (orgRole, label) => {
      orgMemberReadable(orgRole);
      await renderElement(createElement(MembershipSettingsPage));

      expect(text()).toContain('山田商事');
      expect(roleLine()).toBe(`役割: ${label}`);
      expect(text()).not.toMatch(new RegExp(`\\b${orgRole}\\b`));
    });

    it('組織のオーナーなら、役割の文を訳したうえで、譲渡と解散の操作はこれまでどおり出す', async () => {
      orgMemberReadable('owner');
      await renderElement(createElement(MembershipSettingsPage));

      expect(roleLine()).toBe('役割: オーナー');
      expect(findButton('オーナーを譲渡')).toBeDefined();
      expect(findButton('組織を解散')).toBeDefined();
    });

    it('役割が空 (null) なら「メンバー」と出す', async () => {
      orgMemberReadable(null);
      await renderElement(createElement(MembershipSettingsPage));

      expect(roleLine()).toBe('役割: メンバー');
    });

    it('表に無い役割は、内部の値を出さず固定の文 (メンバー) を出す', async () => {
      orgMemberReadable('unexpected_role');
      await renderElement(createElement(MembershipSettingsPage));

      expect(roleLine()).toBe(`役割: ${ROLE_UNKNOWN_LABEL}`);
      expect(text()).not.toContain('unexpected_role');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S2: 子どもの追加
// ─────────────────────────────────────────────────────────────────────────────

describe('#2073 S2 子どもの追加: 追加の通信が切れたら、同じ子どもの行を読み直す (二重に追加しない)', () => {
  const CHILD_PATH = '/api/family/members/child';
  const CHILD_NAME = 'たろう';
  const BIRTH = '1990-01-01';
  /** サーバーの、同じ名前・生年月日の子どもの行の ID */
  let serverChildIds: string[];
  let childReadFails: boolean;

  function familyReadable() {
    serverChildIds = [];
    childReadFails = false;
    profileResponds(inFamily);
    supabaseState.responders.family_members = (ctx: QueryContext) => {
      if (childReadFails) return { data: null, error: LOAD_FAILURE };
      const matches =
        ctx.filters.family_id === FAMILY_ID &&
        ctx.filters.role === 'child' &&
        ctx.filters.status === 'active' &&
        ctx.filters.display_name === CHILD_NAME &&
        ctx.filters.birth_date === BIRTH;
      return { data: matches ? serverChildIds.map((id) => ({ id })) : [], error: null };
    };
  }

  async function fillAndSubmit() {
    await setValue(container.querySelector<HTMLInputElement>('input[type="text"]'), ` ${CHILD_NAME} `);
    await setValue(container.querySelector<HTMLInputElement>('#child-birth-date'), BIRTH);
    await click(submitButton(), '「追加する」');
  }

  it('サーバーが追加を済ませてから応答が切れたとき、読み直して行が増えていれば、成功のときと同じくメンバーの一覧へ移る', async () => {
    familyReadable();
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === CHILD_PATH) {
        serverChildIds = [...serverChildIds, 'child-new'];
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyChildNewPage));

    await fillAndSubmit();

    expect(callsOf('POST', CHILD_PATH)).toHaveLength(1);
    expect(queryCount('family_members', 'list')).toBe(2);
    expect(router.push).toHaveBeenCalledWith('/family/members');
    expect(text()).not.toContain(NETWORK_ERROR);
    expect(unhandled).toEqual([]);
  });

  it('追加できていなければ、通信エラーの文を出し、移らない (送り直してよい)', async () => {
    familyReadable();
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === CHILD_PATH) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyChildNewPage));

    await fillAndSubmit();

    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).not.toContain(STATE_UNCONFIRMED);
  });

  it('同じ名前の子どもが前からいても、行が増えていなければ、追加できたと見なさない', async () => {
    familyReadable();
    serverChildIds = ['child-old'];
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === CHILD_PATH) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyChildNewPage));

    await fillAndSubmit();

    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain(NETWORK_ERROR);
  });

  it('読み直しが失敗したら、通信エラーの文に「状態を確かめられませんでした」を添える', async () => {
    familyReadable();
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === CHILD_PATH) {
        childReadFails = true;
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyChildNewPage));

    await fillAndSubmit();

    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).toContain(STATE_UNCONFIRMED);
  });

  it('送る前の読み込みが失敗し、あとで同じ子どもの行があれば、今回の追加か見分けられないので「状態を確かめられませんでした」を添える', async () => {
    familyReadable();
    childReadFails = true;
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === CHILD_PATH) {
        childReadFails = false;
        serverChildIds = ['child-new'];
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyChildNewPage));

    await fillAndSubmit();

    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain(STATE_UNCONFIRMED);
  });

  it('送る前の読み込みが失敗し、あとで同じ子どもの行が無ければ、追加できていないので、通信エラーの文だけを出す', async () => {
    familyReadable();
    childReadFails = true;
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === CHILD_PATH) {
        // 読み直しは読めるが、同じ子どもの行は無い (serverChildIds は空のまま)
        childReadFails = false;
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyChildNewPage));

    await fillAndSubmit();

    expect(queryCount('family_members', 'list')).toBe(2);
    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).not.toContain(STATE_UNCONFIRMED);
  });

  it('読み直しの応答を待つあいだは、「追加する」を止めたままにする', async () => {
    familyReadable();
    const reread = deferred<QueryResult>();
    let reads = 0;
    supabaseState.responders.family_members = () => {
      reads += 1;
      return reads === 1 ? { data: [], error: null } : reread.promise;
    };
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === CHILD_PATH) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilyChildNewPage));

    await fillAndSubmit();
    expect(reads).toBe(2);
    expect(submitButton()?.disabled).toBe(true);

    await act(async () => {
      reread.resolve({ data: [], error: null });
    });
    await settle();
    expect(submitButton()?.disabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S2: 招待の送信
// ─────────────────────────────────────────────────────────────────────────────

describe('#2073 S2 大人の招待: 送信の通信が切れたら、招待の履歴を読み直す', () => {
  const INVITES_PATH = '/api/family/invites';
  const EMAIL = 'hanako@example.com';
  let serverInvites: Array<{ id: string; email: string; status: string; expires_at: string; created_at: string }>;
  let invitesReadFails: boolean;

  function inviteFetch(onPost: () => void) {
    mockFetch((method, url) => {
      if (url.pathname !== INVITES_PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') {
        if (invitesReadFails) throw new TypeError('Failed to fetch');
        return jsonResponse(200, { data: { invites: serverInvites } });
      }
      onPost();
      throw new TypeError('Failed to fetch');
    });
  }
  const invite = (id: string, email: string) => ({
    id,
    email,
    status: 'pending',
    expires_at: '2999-01-01T00:00:00.000Z',
    created_at: '2026-10-01T00:00:00.000Z',
  });

  async function fillAndSubmit() {
    await setValue(container.querySelector<HTMLInputElement>('input[type="email"]'), ` ${EMAIL.toUpperCase()} `);
    await click(submitButton(), '「招待を送信」');
  }

  beforeEach(() => {
    serverInvites = [];
    invitesReadFails = false;
    profileResponds(inFamily);
  });

  it('サーバーが招待を作ってから応答が切れたとき、読み直して新しい招待があれば、成功のときと同じ表示にする (送り直させない)', async () => {
    inviteFetch(() => {
      serverInvites = [invite('inv-new', EMAIL), ...serverInvites];
    });
    await renderElement(createElement(FamilyInvitePage));

    await fillAndSubmit();

    expect(callsOf('POST', INVITES_PATH)).toHaveLength(1);
    expect(text()).toContain('に招待メールを送信しました');
    expect(text()).not.toContain(NETWORK_ERROR);
    expect(container.querySelector<HTMLInputElement>('input[type="email"]')?.value).toBe('');
    expect(text()).toContain(EMAIL);
    expect(unhandled).toEqual([]);
  });

  it('招待を作れていなければ、通信エラーの文を出し、入力を残す', async () => {
    inviteFetch(() => undefined);
    await renderElement(createElement(FamilyInvitePage));

    await fillAndSubmit();

    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).not.toContain('に招待メールを送信しました');
    expect(container.querySelector<HTMLInputElement>('input[type="email"]')?.value).not.toBe('');
  });

  it('同じ宛先への招待が前からあっても、新しい招待が増えていなければ、作れたと見なさない', async () => {
    serverInvites = [invite('inv-old', EMAIL)];
    inviteFetch(() => undefined);
    await renderElement(createElement(FamilyInvitePage));

    await fillAndSubmit();

    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).not.toContain('に招待メールを送信しました');
  });

  it('増えた招待が別の宛先だけなら (別の端末で別の人を招待した)、今回の招待を作れたと見なさず、入力を残す', async () => {
    const OTHER_EMAIL = 'jiro@example.com';
    inviteFetch(() => {
      serverInvites = [invite('inv-other', OTHER_EMAIL), ...serverInvites];
    });
    await renderElement(createElement(FamilyInvitePage));

    await fillAndSubmit();

    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).not.toContain('に招待メールを送信しました');
    expect(container.querySelector<HTMLInputElement>('input[type="email"]')?.value).not.toBe('');
    // 読み直した履歴は出す
    expect(text()).toContain(OTHER_EMAIL);
  });

  it.each(['accepted', 'expired'])(
    '増えた招待が同じ宛先でも、状態が %s (承認待ちではない) なら、今回の招待を作れたと見なさない',
    async (status) => {
      inviteFetch(() => {
        serverInvites = [{ ...invite('inv-new', EMAIL), status }, ...serverInvites];
      });
      await renderElement(createElement(FamilyInvitePage));

      await fillAndSubmit();

      expect(text()).toContain(NETWORK_ERROR);
      expect(text()).not.toContain('に招待メールを送信しました');
      expect(container.querySelector<HTMLInputElement>('input[type="email"]')?.value).not.toBe('');
    },
  );

  it('サーバーの招待の宛先が大文字まじりでも、同じ宛先として、作れたと見なす', async () => {
    inviteFetch(() => {
      serverInvites = [invite('inv-new', 'Hanako@Example.com'), ...serverInvites];
    });
    await renderElement(createElement(FamilyInvitePage));

    await fillAndSubmit();

    expect(text()).toContain('に招待メールを送信しました');
    expect(text()).not.toContain(NETWORK_ERROR);
  });

  it('読み直しが失敗したら、通信エラーの文に「状態を確かめられませんでした」を添える', async () => {
    inviteFetch(() => {
      invitesReadFails = true;
    });
    await renderElement(createElement(FamilyInvitePage));

    await fillAndSubmit();

    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).toContain(STATE_UNCONFIRMED);
  });

  it('読み直しの応答を待つあいだは、「招待を送信」を止めたままにする', async () => {
    const reread = deferred<Response>();
    let reads = 0;
    mockFetch((method, url) => {
      if (url.pathname !== INVITES_PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') {
        reads += 1;
        // 1 回目は画面を開いたとき、2 回目は送る前、3 回目は通信が切れたあとの読み直し
        return reads < 3 ? jsonResponse(200, { data: { invites: serverInvites } }) : reread.promise;
      }
      throw new TypeError('Failed to fetch');
    });
    await renderElement(createElement(FamilyInvitePage));

    await fillAndSubmit();
    expect(reads).toBe(3);
    expect(submitButton()?.disabled).toBe(true);

    await act(async () => {
      reread.resolve(jsonResponse(200, { data: { invites: serverInvites } }));
    });
    await settle();
    expect(text()).toContain(NETWORK_ERROR);
    expect(submitButton()?.disabled).toBe(false);
  });

  describe('送る前の招待の履歴を読み込めなかったとき', () => {
    /** 招待の履歴の GET を数え、2 回目 (送る前) だけを失敗させる。3 回目 (通信が切れたあと) は serverInvites を返す */
    function beforeReadFails(onPost: () => void) {
      let reads = 0;
      mockFetch((method, url) => {
        if (url.pathname !== INVITES_PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
        if (method === 'GET') {
          reads += 1;
          if (reads === 2) throw new TypeError('Failed to fetch');
          return jsonResponse(200, { data: { invites: serverInvites } });
        }
        onPost();
        throw new TypeError('Failed to fetch');
      });
    }

    it('あとでその宛先への招待があっても、今回の招待か前からの招待か見分けられないので、成功と見なさず「状態を確かめられませんでした」を添える', async () => {
      beforeReadFails(() => {
        serverInvites = [invite('inv-new', EMAIL)];
      });
      await renderElement(createElement(FamilyInvitePage));

      await fillAndSubmit();

      expect(text()).toContain(NETWORK_ERROR);
      expect(text()).toContain(STATE_UNCONFIRMED);
      expect(text()).not.toContain('に招待メールを送信しました');
    });

    it('あとでその宛先への招待が無ければ、作れていないので、通信エラーの文だけを出す', async () => {
      beforeReadFails(() => undefined);
      await renderElement(createElement(FamilyInvitePage));

      await fillAndSubmit();

      expect(text()).toContain(NETWORK_ERROR);
      expect(text()).not.toContain(STATE_UNCONFIRMED);
      expect(text()).not.toContain('に招待メールを送信しました');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S2: 昇格の依頼の送信と取り消し
// ─────────────────────────────────────────────────────────────────────────────

describe('#2073 S2 昇格の依頼: 送信・取り消しの通信が切れたら、承認待ちの依頼を読み直す', () => {
  const PROMOTE_PATH = `/api/family/members/${MEMBER_A_ID}/promote`;
  const EMAIL = 'taro@example.com';
  /** 昇格の依頼の読み込み・読み直しの絞り込み (この子どもの承認待ちの依頼) */
  const PROMOTION_PENDING_FILTERS = { member_id: MEMBER_A_ID, status: 'pending' };
  let serverPending: { id: string; email: string; status: string; expires_at: string } | null;
  let pendingReadFails: boolean;

  beforeEach(() => {
    serverPending = null;
    pendingReadFails = false;
    profileResponds(inFamily);
    supabaseState.responders.family_members = () => ({
      data: { id: MEMBER_A_ID, display_name: 'たろう', role: 'child', user_id: null },
      error: null,
    });
    // この子どもの承認待ちの依頼だけを返す (絞り込みを外すと、本物では他の子ども・処理済みの依頼まで読める)
    supabaseState.responders.family_promotion_requests = (ctx: QueryContext) => {
      if (pendingReadFails) return { data: null, error: LOAD_FAILURE };
      return { data: filtersMatch(ctx, PROMOTION_PENDING_FILTERS) ? serverPending : null, error: null };
    };
  });

  const pendingRow = (id: string, email: string) => ({ id, email, status: 'pending', expires_at: '2999-01-01T00:00:00.000Z' });

  async function fillAndSend() {
    await setValue(container.querySelector<HTMLInputElement>('#promotion-email'), EMAIL);
    await click(submitButton(), '「参加リクエストを送信」');
  }

  it('サーバーが依頼を作ってから応答が切れたとき、読み直して新しい依頼があれば、成功の画面を出す', async () => {
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === PROMOTE_PATH) {
        serverPending = pendingRow('req-new', EMAIL);
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(PromoteMemberPage));

    await fillAndSend();

    expect(callsOf('POST', PROMOTE_PATH)).toHaveLength(1);
    // 開いたときと、通信が切れたあとの読み直しは、どちらもこの子どもの承認待ちの依頼に絞る
    const promotionReads = filtersOf('family_promotion_requests');
    expect(promotionReads.length).toBeGreaterThanOrEqual(2);
    expect(promotionReads).toEqual(promotionReads.map(() => PROMOTION_PENDING_FILTERS));
    expect(text()).toContain('参加リクエストを送信しました');
    expect(text()).toContain(EMAIL);
    expect(text()).not.toContain(NETWORK_ERROR);
    expect(unhandled).toEqual([]);
  });

  it('依頼を作れていなければ、通信エラーの文を出し、送信のフォームを残す', async () => {
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === PROMOTE_PATH) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(PromoteMemberPage));

    await fillAndSend();

    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).not.toContain('参加リクエストを送信しました');
    expect(findButton('参加リクエストを送信')).toBeDefined();
  });

  it('再送で、前の依頼 (同じ宛先) のままなら、作れたと見なさない', async () => {
    serverPending = pendingRow('req-old', EMAIL);
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === PROMOTE_PATH) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(PromoteMemberPage));
    await click(findButton('別のメールアドレスで再送する'), '「別のメールアドレスで再送する」');

    await fillAndSend();

    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).not.toContain('参加リクエストを送信しました');
  });

  it('送信の読み直しが失敗したら、通信エラーの文に「状態を確かめられませんでした」を添える', async () => {
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === PROMOTE_PATH) {
        pendingReadFails = true;
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(PromoteMemberPage));

    await fillAndSend();

    expect(text()).toContain(STATE_UNCONFIRMED);
    expect(text()).not.toContain('参加リクエストを送信しました');
  });

  it('サーバーが取り消しを済ませてから応答が切れたとき、読み直して依頼が無ければ、承認待ちの表示を消し、失敗の文を出さない', async () => {
    serverPending = pendingRow('req-old', EMAIL);
    mockFetch((method, url) => {
      if (method === 'DELETE' && url.pathname === PROMOTE_PATH) {
        serverPending = null;
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(PromoteMemberPage));
    expect(text()).toContain('承認待ちのリクエストがあります');

    await click(findButton('リクエストを取り消す'), '「リクエストを取り消す」');

    expect(callsOf('DELETE', PROMOTE_PATH)).toHaveLength(1);
    expect(text()).not.toContain('承認待ちのリクエストがあります');
    expect(text()).not.toContain(NETWORK_ERROR);
    expect(findButton('参加リクエストを送信')).toBeDefined();
  });

  it('取り消せていなければ、承認待ちの表示を残し、通信エラーの文を出す', async () => {
    serverPending = pendingRow('req-old', EMAIL);
    mockFetch((method, url) => {
      if (method === 'DELETE' && url.pathname === PROMOTE_PATH) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(PromoteMemberPage));

    await click(findButton('リクエストを取り消す'), '「リクエストを取り消す」');

    expect(text()).toContain('承認待ちのリクエストがあります');
    expect(text()).toContain(NETWORK_ERROR);
  });

  it('取り消しの読み直しが失敗したら、通信エラーの文に「状態を確かめられませんでした」を添える', async () => {
    serverPending = pendingRow('req-old', EMAIL);
    mockFetch((method, url) => {
      if (method === 'DELETE' && url.pathname === PROMOTE_PATH) {
        pendingReadFails = true;
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(PromoteMemberPage));

    await click(findButton('リクエストを取り消す'), '「リクエストを取り消す」');

    expect(text()).toContain(STATE_UNCONFIRMED);
  });

  it('送信の読み直しの応答を待つあいだは、「参加リクエストを送信」を止めたままにする', async () => {
    const reread = deferred<QueryResult>();
    let reads = 0;
    supabaseState.responders.family_promotion_requests = () => {
      reads += 1;
      return reads === 1 ? { data: null, error: null } : reread.promise;
    };
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === PROMOTE_PATH) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(PromoteMemberPage));

    await fillAndSend();
    expect(reads).toBe(2);
    expect(submitButton()?.disabled).toBe(true);

    await act(async () => {
      reread.resolve({ data: null, error: null });
    });
    await settle();
    expect(text()).toContain(NETWORK_ERROR);
    expect(submitButton()?.disabled).toBe(false);
  });

  it('取り消しの読み直しの応答を待つあいだは、「リクエストを取り消す」と「別のメールアドレスで再送する」を止めたままにする', async () => {
    const reread = deferred<QueryResult>();
    let reads = 0;
    supabaseState.responders.family_promotion_requests = () => {
      reads += 1;
      return reads === 1 ? { data: pendingRow('req-old', EMAIL), error: null } : reread.promise;
    };
    mockFetch((method, url) => {
      if (method === 'DELETE' && url.pathname === PROMOTE_PATH) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(PromoteMemberPage));

    await click(findButton('リクエストを取り消す'), '「リクエストを取り消す」');
    expect(reads).toBe(2);
    expect(findButton('リクエストを取り消す')).toBeUndefined();
    expect(findButton('取消中…')?.disabled).toBe(true);
    expect(findButton('別のメールアドレスで再送する')?.disabled).toBe(true);

    await act(async () => {
      reread.resolve({ data: pendingRow('req-old', EMAIL), error: null });
    });
    await settle();
    expect(text()).toContain(NETWORK_ERROR);
    expect(findButton('リクエストを取り消す')?.disabled).toBe(false);
    expect(findButton('別のメールアドレスで再送する')?.disabled).toBe(false);
  });

  it('読み直した新しい依頼の宛先が大文字まじりでも、同じ宛先として、作れたと見なす', async () => {
    const STORED_EMAIL = 'Taro@Example.com';
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === PROMOTE_PATH) {
        serverPending = pendingRow('req-new', STORED_EMAIL);
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(PromoteMemberPage));

    await fillAndSend();

    expect(text()).toContain('参加リクエストを送信しました');
    expect(text()).not.toContain(NETWORK_ERROR);
  });

  it('読み直した新しい依頼が別の宛先なら、今回の依頼を作れたと見なさない', async () => {
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === PROMOTE_PATH) {
        serverPending = pendingRow('req-other', 'jiro@example.com');
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(PromoteMemberPage));

    await fillAndSend();

    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).not.toContain('参加リクエストを送信しました');
  });

  it('取り消しの読み直しで承認待ちの依頼が別の依頼に変わっていれば、取り消せていると見なし、読み直した依頼を出して失敗の文を出さない', async () => {
    const OTHER_EMAIL = 'jiro@example.com';
    serverPending = pendingRow('req-old', EMAIL);
    mockFetch((method, url) => {
      if (method === 'DELETE' && url.pathname === PROMOTE_PATH) {
        serverPending = pendingRow('req-other', OTHER_EMAIL);
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(PromoteMemberPage));
    expect(text()).toContain(EMAIL);

    await click(findButton('リクエストを取り消す'), '「リクエストを取り消す」');

    expect(text()).not.toContain(NETWORK_ERROR);
    expect(text()).toContain('承認待ちのリクエストがあります');
    expect(text()).toContain(OTHER_EMAIL);
    expect(text()).not.toContain(EMAIL);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S2: 家族の作成
// ─────────────────────────────────────────────────────────────────────────────

describe('#2073 S2 家族の作成: 作成の通信が切れたら、自分のプロフィールを読み直す', () => {
  const GROUPS_PATH = '/api/family/groups';
  let serverFamilyId: string | null;

  beforeEach(() => {
    serverFamilyId = null;
    profileResponds(() => ({ data: { family_id: serverFamilyId, organization_id: null }, error: null }));
  });

  async function fillAndSubmit() {
    await setValue(container.querySelector<HTMLInputElement>('input[type="text"]'), '山田家');
    await click(submitButton(), '「家族グループを作る」');
  }

  it('サーバーが作成を済ませてから応答が切れたとき、読み直して家族に入っていれば、成功のときと同じくダッシュボードへ移る', async () => {
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === GROUPS_PATH) {
        serverFamilyId = FAMILY_ID;
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilySetupPage));

    await fillAndSubmit();

    expect(callsOf('POST', GROUPS_PATH)).toHaveLength(1);
    expect(router.push).toHaveBeenCalledWith('/family/dashboard');
    expect(text()).not.toContain(NETWORK_ERROR);
  });

  it('作れていなければ、通信エラーの文を出し、移らない', async () => {
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === GROUPS_PATH) throw new TypeError('Failed to fetch');
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilySetupPage));

    await fillAndSubmit();

    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).not.toContain(STATE_UNCONFIRMED);
  });

  it('読み直しも失敗したら、通信エラーの文に「状態を確かめられませんでした」を添える', async () => {
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === GROUPS_PATH) {
        profileResponds(profileLoadFails);
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilySetupPage));

    await fillAndSubmit();

    expect(router.push).not.toHaveBeenCalled();
    expect(text()).toContain(STATE_UNCONFIRMED);
  });

  it('読み直しの応答を待つあいだは、「家族グループを作る」を止めたままにする', async () => {
    const reread = deferred<QueryResult>();
    let rereadStarted = false;
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === GROUPS_PATH) {
        supabaseState.responders.user_profiles = (ctx: QueryContext) => {
          if (ctx.kind === 'single' && ctx.filters.id === USER_ID) {
            rereadStarted = true;
            return reread.promise;
          }
          return { data: null, error: NO_ROWS };
        };
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderElement(createElement(FamilySetupPage));

    await fillAndSubmit();
    expect(rereadStarted).toBe(true);
    expect(submitButton()?.disabled).toBe(true);

    await act(async () => {
      reread.resolve({ data: { family_id: null, organization_id: null }, error: null });
    });
    await settle();
    expect(text()).toContain(NETWORK_ERROR);
    expect(submitButton()?.disabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S8: 譲渡の提案の送信
// ─────────────────────────────────────────────────────────────────────────────

describe('#2073 S8 組織のオーナーの譲渡: 提案の送信の通信が切れたら、提案を作れたか確かめる', () => {
  const PROPOSE_PATH = '/api/org/owner-transfer/propose';
  /** 組織のオーナーの譲渡で読む pending の提案の絞り込み (選んだ組織の pending) */
  const ORG_PENDING_FILTERS = { scope: 'organization', scope_id: ORG_ID, status: 'pending' };
  let serverPending: { id: string; to_user_id: string } | null;
  let pendingReadFails: boolean;

  beforeEach(() => {
    serverPending = null;
    pendingReadFails = false;
    supabaseState.responders.user_profiles = (ctx: QueryContext) => {
      if (ctx.kind === 'single') return { data: { org_role: 'owner', organization_id: ORG_ID }, error: null };
      return { data: [{ id: MEMBER_A_ID, nickname: '花子', org_role: 'member', joined_org_at: null }], error: null };
    };
    // 選んだ組織の pending の提案だけを返す (範囲・対象を取り違えると、本物では提案が見つからない)
    supabaseState.responders.ownership_transfer_proposals = (ctx: QueryContext) => {
      if (pendingReadFails) return { data: null, error: LOAD_FAILURE };
      return { data: filtersMatch(ctx, ORG_PENDING_FILTERS) ? serverPending : null, error: null };
    };
  });

  async function selectAndPropose() {
    await click(container.querySelector<HTMLInputElement>(`input[value="${MEMBER_A_ID}"]`), '譲渡先の候補');
    await click(submitButton(), '「譲渡を提案」');
  }

  function proposeDisconnects(onPost: () => void) {
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === PROPOSE_PATH) {
        onPost();
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  it('サーバーが提案を作ってから応答が切れたとき、読み直して新しい提案があれば、成功のときと同じく送った旨を出してメンバーの一覧へ移る', async () => {
    proposeDisconnects(() => {
      serverPending = { id: NEW_PROPOSAL_ID, to_user_id: MEMBER_A_ID };
    });
    await renderElement(createElement(OwnerTransferPage));

    await selectAndPropose();

    expect(callsOf('POST', PROPOSE_PATH)).toHaveLength(1);
    // 送る前と、通信が切れたあとの 2 回、選んだ組織の pending の提案を読む
    expect(queryCount('ownership_transfer_proposals', 'maybeSingle')).toBe(2);
    expect(filtersOf('ownership_transfer_proposals')).toEqual([ORG_PENDING_FILTERS, ORG_PENDING_FILTERS]);
    expect(alertSpy).toHaveBeenCalledWith(ORG_PROPOSAL_SENT);
    expect(router.push).toHaveBeenCalledWith('/org/members');
    expect(text()).not.toContain(ORG_NETWORK_ERROR);
    expect(unhandled).toEqual([]);
  });

  it('提案を作れていなければ、これまでどおり失敗の文を出し、移らない', async () => {
    proposeDisconnects(() => undefined);
    await renderElement(createElement(OwnerTransferPage));

    await selectAndPropose();

    expect(text()).toContain(ORG_NETWORK_ERROR);
    expect(text()).not.toContain(STATE_UNCONFIRMED);
    expect(router.push).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('前に送った提案 (同じ譲渡先・pending) のままなら、作れたと見なさない', async () => {
    serverPending = { id: OLD_PROPOSAL_ID, to_user_id: MEMBER_A_ID };
    proposeDisconnects(() => undefined);
    await renderElement(createElement(OwnerTransferPage));

    await selectAndPropose();

    expect(text()).toContain(ORG_NETWORK_ERROR);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('読み直しが失敗したら、失敗の文に「状態を確かめられませんでした」を添える', async () => {
    proposeDisconnects(() => {
      pendingReadFails = true;
    });
    await renderElement(createElement(OwnerTransferPage));

    await selectAndPropose();

    expect(text()).toContain(ORG_NETWORK_ERROR);
    expect(text()).toContain(STATE_UNCONFIRMED);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('読み直しの応答を待つあいだは、「譲渡を提案」を止めたままにする', async () => {
    const reread = deferred<QueryResult>();
    let reads = 0;
    supabaseState.responders.ownership_transfer_proposals = () => {
      reads += 1;
      return reads === 1 ? { data: null, error: null } : reread.promise;
    };
    proposeDisconnects(() => undefined);
    await renderElement(createElement(OwnerTransferPage));

    await selectAndPropose();
    expect(reads).toBe(2);
    expect(submitButton()?.disabled).toBe(true);

    await act(async () => {
      reread.resolve({ data: null, error: null });
    });
    await settle();
    expect(submitButton()?.disabled).toBe(false);
  });
});

describe('#2073 S8 家族の代表者の譲渡: 提案の送信の通信が切れたら、提案を作れたか確かめる', () => {
  const PROPOSE_PATH = '/api/family/representative-transfer/propose';
  /** 家族の代表者の譲渡で読む pending の提案の絞り込み (自分の家族の pending) */
  const FAMILY_PENDING_FILTERS = { scope: 'family', scope_id: FAMILY_ID, status: 'pending' };
  let serverPending: { id: string; to_user_id: string } | null;
  let pendingReadFails: boolean;

  beforeEach(() => {
    serverPending = null;
    pendingReadFails = false;
    profileResponds(inFamily);
    supabaseState.responders.family_members = (ctx: QueryContext) => {
      if (ctx.kind === 'maybeSingle') return { data: { role: 'representative' }, error: null };
      return { data: [{ id: 'fm-a', role: 'adult', display_name: '花子', user_id: MEMBER_A_ID }], error: null };
    };
    // 自分の家族の pending の提案だけを返す (範囲・対象を取り違えると、本物では提案が見つからない)
    supabaseState.responders.ownership_transfer_proposals = (ctx: QueryContext) => {
      if (pendingReadFails) return { data: null, error: LOAD_FAILURE };
      return { data: filtersMatch(ctx, FAMILY_PENDING_FILTERS) ? serverPending : null, error: null };
    };
  });

  async function selectAndPropose() {
    await click(container.querySelector<HTMLInputElement>(`input[value="${MEMBER_A_ID}"]`), '譲渡先の候補');
    await click(submitButton(), '「譲渡を提案」');
  }

  function proposeDisconnects(onPost: () => void) {
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === PROPOSE_PATH) {
        onPost();
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  it('サーバーが提案を作ってから応答が切れたとき、読み直して新しい提案があれば、成功の画面を出す (送り直しのボタンを出さない)', async () => {
    proposeDisconnects(() => {
      serverPending = { id: NEW_PROPOSAL_ID, to_user_id: MEMBER_A_ID };
    });
    await renderElement(createElement(FamilyRepresentativeTransferPage));

    await selectAndPropose();

    expect(callsOf('POST', PROPOSE_PATH)).toHaveLength(1);
    // 送る前と、通信が切れたあとの 2 回、自分の家族の pending の提案を読む
    expect(queryCount('ownership_transfer_proposals', 'maybeSingle')).toBe(2);
    expect(filtersOf('ownership_transfer_proposals')).toEqual([FAMILY_PENDING_FILTERS, FAMILY_PENDING_FILTERS]);
    expect(text()).toContain('譲渡提案を送信しました');
    expect(findButton('譲渡を提案')).toBeUndefined();
    expect(text()).not.toContain(NETWORK_ERROR);
  });

  it('提案を作れていなければ、通信エラーの文を出し、フォームを残す', async () => {
    proposeDisconnects(() => undefined);
    await renderElement(createElement(FamilyRepresentativeTransferPage));

    await selectAndPropose();

    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).not.toContain('譲渡提案を送信しました');
    expect(findButton('譲渡を提案')).toBeDefined();
  });

  it('前に送った提案 (同じ譲渡先・pending) のままなら、作れたと見なさない', async () => {
    serverPending = { id: OLD_PROPOSAL_ID, to_user_id: MEMBER_A_ID };
    proposeDisconnects(() => undefined);
    await renderElement(createElement(FamilyRepresentativeTransferPage));

    await selectAndPropose();

    expect(text()).toContain(NETWORK_ERROR);
    expect(text()).not.toContain('譲渡提案を送信しました');
  });

  it('読み直しが失敗したら、通信エラーの文に「状態を確かめられませんでした」を添える', async () => {
    proposeDisconnects(() => {
      pendingReadFails = true;
    });
    await renderElement(createElement(FamilyRepresentativeTransferPage));

    await selectAndPropose();

    expect(text()).toContain(STATE_UNCONFIRMED);
    expect(text()).not.toContain('譲渡提案を送信しました');
  });

  it('読み直しの応答を待つあいだは、「譲渡を提案」を止めたままにする', async () => {
    const reread = deferred<QueryResult>();
    let reads = 0;
    supabaseState.responders.ownership_transfer_proposals = () => {
      reads += 1;
      return reads === 1 ? { data: null, error: null } : reread.promise;
    };
    proposeDisconnects(() => undefined);
    await renderElement(createElement(FamilyRepresentativeTransferPage));

    await selectAndPropose();
    expect(reads).toBe(2);
    expect(submitButton()?.disabled).toBe(true);

    await act(async () => {
      reread.resolve({ data: null, error: null });
    });
    await settle();
    expect(text()).toContain(NETWORK_ERROR);
    expect(submitButton()?.disabled).toBe(false);
  });
});
