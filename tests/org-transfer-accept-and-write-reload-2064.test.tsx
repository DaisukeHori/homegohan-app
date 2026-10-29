/**
 * #2064 (10/26 の整合ゲート 1026g の候補・triage-1026d) R4・R5 と同じ型の、組織の画面のほかの箇所のテスト
 *
 *   - R4 と同じ型 (読み込めなかったのを、別の状態と見せる・catch が無い):
 *     - オーナーの譲渡の承諾の画面 (/org/transfer-accept/[proposal_id]): 提案の問い合わせの error を見ず、
 *       読み込めなかったのを「提案が見つかりません」と見せていた。組織名・提案者の問い合わせも error を見ず、
 *       try / finally だけで catch が無かった。直したあとは、読み込めなかった旨の文と「再試行」を出し、
 *       「提案が見つかりません」は提案の行が無い (PGRST116) ときだけ出す。提案者を RLS で読めないとき (PGRST116) は、これまでどおり「(不明)」
 *     - 組織の管理画面の枠 (src/app/(org)/layout.tsx): 自分のプロフィールを読み込めなかったときも管理者でない扱いでホームへ移し、
 *       例外を投げたときは catch が無く読み込み中の表示のまま止まっていた。直したあとは、読み込めなかった旨の文と「再試行」を出す
 *   - R5 と同じ型 (書き込みの通信が reject したとき、一覧を読み直さない):
 *     - 承諾の画面の承諾・拒否 / 部署の追加・削除 / 招待の送信・取消 / チャレンジの作成・開始。
 *       サーバーが書き込みを済ませてから応答が切れた場合でも、古い一覧 (古いボタン) が残っていた。
 *       直したあとは、通信エラーの文を出したうえで読み直す (読み直しが失敗したら、一覧の「読み込めませんでした」に任せる)。
 *       組織の管理画面 (部署・招待・チャレンジ) の文は #2080 U4 で「<操作>の応答を受け取れませんでした（通信エラー）」に変えた
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const OLD_OWNER_ID = '44444444-4444-4444-8444-444444444444';
const ORG_ID = '77777777-7777-4777-8777-777777777777';
const PROPOSAL_ID = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';

/** 画面の文 (画面と同じもの) */
const PROPOSAL_NOT_FOUND = '提案が見つかりません';
const PROPOSAL_LOAD_ERROR = '譲渡の提案を読み込めませんでした。しばらくしてから、もう一度お試しください。';
const TRANSFER_NETWORK_ERROR = 'ネットワークエラーが発生しました';
const ORG_ADMIN_LOAD_ERROR = '組織の管理画面を開けませんでした。しばらくしてから、もう一度お試しください。';

/** .single() で行が無いときの PostgREST の失敗 */
const NO_ROWS = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };
/** 行が無いのではなく、読み込めなかった失敗 */
const LOAD_FAILURE = { code: '57014', message: 'canceling statement due to statement timeout' };

type QueryResult = { data: unknown; error: unknown };
/** 問い合わせの結果。関数なら呼ぶたびに決める (読み直しで中身を変えるため)。reject を返すと例外の筋書きになる */
type ResultSource = QueryResult | (() => QueryResult | Promise<QueryResult>);

const supabaseState = vi.hoisted(() => ({
  /** auth.getUser が投げるか */
  getUserThrows: false,
  /** 表ごとの 1 行 (single) の結果 */
  single: {} as Record<string, unknown>,
  /** 表ごとの 1 行 (single) の問い合わせを送った回数 */
  singleCount: {} as Record<string, number>,
}));

function resolveSource(source: unknown): Promise<QueryResult> {
  const s = source as ResultSource | undefined;
  if (s === undefined) return Promise.resolve({ data: null, error: NO_ROWS });
  return Promise.resolve(typeof s === 'function' ? s() : s);
}

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: () => undefined }));
const params = vi.hoisted(() => ({ proposal_id: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44' }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useParams: () => params,
  usePathname: () => '/org/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

// アニメーションは本題ではないので、motion.* は同じタグの素の要素、AnimatePresence は子をそのまま返す
vi.mock('framer-motion', () => {
  const MOTION_ONLY_PROPS = ['initial', 'animate', 'exit', 'transition'];
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

// 承諾の画面と組織の管理画面の枠は Supabase の 1 行 (single) の問い合わせで読む。表ごとに結果を分ける
vi.mock('@/lib/supabase/client', () => {
  const builder = (table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      single: () => {
        supabaseState.singleCount[table] = (supabaseState.singleCount[table] ?? 0) + 1;
        return resolveSource(supabaseState.single[table]);
      },
    };
    return query;
  };
  // 本物の createClient (ブラウザではシングルトン) と同じく、毎回同じクライアントを返す
  // (画面は supabase を useCallback / useEffect の依存に入れているため、描画のたびに別物だと読み込みが繰り返される)
  const client = {
    auth: {
      getUser: () =>
        supabaseState.getUserThrows
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve({ data: { user: { id: USER_ID } }, error: null }),
      signOut: () => Promise.resolve({ error: null }),
    },
    from: (table: string) => builder(table),
  };
  return { createClient: () => client };
});

const { default: TransferAcceptPage } = await import('@/app/(main)/org/transfer-accept/[proposal_id]/page');
const { default: OrgLayout } = await import('@/app/(org)/layout');
const { default: OrgDepartmentsPage } = await import('@/app/(org)/org/departments/page');
const { default: OrgInvitesPage } = await import('@/app/(org)/org/invites/page');
const { default: OrgChallengesPage } = await import('@/app/(org)/org/challenges/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let alertSpy: ReturnType<typeof vi.fn>;
let unhandled: unknown[];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

type Handler = (method: string, url: URL, body: unknown) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    return handler(method, url, body);
  });
  vi.stubGlobal('fetch', fetchMock);
}

const callsOf = (method: string, pathname: string) =>
  fetchMock.mock.calls.filter(([input, init]) => {
    const m = ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    return m === method && new URL(String(input), 'http://localhost').pathname === pathname;
  });

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

async function click(element: HTMLElement | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeDefined();
  await act(async () => {
    element!.click();
  });
  await settle();
}

async function typeInto(element: HTMLInputElement | null, value: string) {
  expect(element, '入力欄が見つからない').not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(element, value);
    element!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** フォームを送る (必須の欄の検査は本題ではないので、submit の事件を直接送る) */
async function submitForm() {
  const form = container.querySelector('form');
  expect(form, 'フォームが見つからない').not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
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
  supabaseState.single = {};
  supabaseState.singleCount = {};
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
// R4 と同じ型: オーナーの譲渡の承諾の画面の読み込み
// ─────────────────────────────────────────────────────────────────────────────

/** ほめゴハン株式会社のオーナーから、ログイン中の自分への譲渡提案。期限内で pending */
const PROPOSAL = {
  id: PROPOSAL_ID,
  from_user_id: OLD_OWNER_ID,
  to_user_id: USER_ID,
  status: 'pending',
  proposed_at: '2026-10-01T00:00:00.000Z',
  expires_at: '2999-01-01T00:00:00.000Z',
  scope_id: ORG_ID,
};
const ORG_NAME = 'ほめゴハン株式会社';

/** 3 つの問い合わせ (提案・組織名・提案者) がすべて読める状態にする */
function proposalReadable(overrides: { proposal?: ResultSource; org?: ResultSource; fromUser?: ResultSource } = {}) {
  supabaseState.single.ownership_transfer_proposals = overrides.proposal ?? { data: PROPOSAL, error: null };
  supabaseState.single.organizations = overrides.org ?? { data: { name: ORG_NAME }, error: null };
  supabaseState.single.user_profiles = overrides.fromUser ?? { data: { nickname: '社長' }, error: null };
}

const proposalQueryCount = () => supabaseState.singleCount.ownership_transfer_proposals ?? 0;
const transferLoadErrorBox = () => byTestId('transfer-accept-load-error');

describe('#2064 R4 と同じ型 オーナーの譲渡の承諾: 読み込めなかったことを「提案が見つかりません」と見せない', () => {
  it('提案の問い合わせが失敗したら、読み込めなかった文と「再試行」を出し、「提案が見つかりません」を出さない', async () => {
    proposalReadable({ proposal: { data: null, error: LOAD_FAILURE } });
    await renderElement(createElement(TransferAcceptPage));

    expect(transferLoadErrorBox()).toContain(PROPOSAL_LOAD_ERROR);
    expect(findButton('再試行')).toBeDefined();
    expect(text()).not.toContain(PROPOSAL_NOT_FOUND);
    expect(findButton('承諾')).toBeUndefined();
  });

  it('提案の行が無い (PGRST116) ときは、これまでどおり「提案が見つかりません」を出す (読み込めなかった文は出さない)', async () => {
    proposalReadable({ proposal: { data: null, error: NO_ROWS } });
    await renderElement(createElement(TransferAcceptPage));

    expect(text()).toContain(PROPOSAL_NOT_FOUND);
    expect(transferLoadErrorBox()).toBeNull();
    expect(findButton('再試行')).toBeUndefined();
    // 組織名・提案者は問い合わせない
    expect(supabaseState.singleCount.organizations ?? 0).toBe(0);
  });

  it('組織名の問い合わせが失敗したら、読み込めなかった文を出し、承諾・拒否を出さない', async () => {
    proposalReadable({ org: { data: null, error: LOAD_FAILURE } });
    await renderElement(createElement(TransferAcceptPage));

    expect(transferLoadErrorBox()).toContain(PROPOSAL_LOAD_ERROR);
    expect(findButton('承諾')).toBeUndefined();
    expect(findButton('拒否')).toBeUndefined();
  });

  it('提案者の問い合わせが失敗したら、読み込めなかった文を出し、承諾・拒否を出さない', async () => {
    proposalReadable({ fromUser: { data: null, error: LOAD_FAILURE } });
    await renderElement(createElement(TransferAcceptPage));

    expect(transferLoadErrorBox()).toContain(PROPOSAL_LOAD_ERROR);
    expect(findButton('承諾')).toBeUndefined();
  });

  it('提案者を RLS で読めない (PGRST116) ときは、これまでどおり「(不明)」と出し、承諾・拒否を出す', async () => {
    proposalReadable({ fromUser: { data: null, error: NO_ROWS } });
    await renderElement(createElement(TransferAcceptPage));

    expect(transferLoadErrorBox()).toBeNull();
    expect(text()).toContain('(不明)');
    expect(text()).toContain(ORG_NAME);
    expect(findButton('承諾')).toBeDefined();
    expect(findButton('拒否')).toBeDefined();
  });

  it('問い合わせが例外を投げても、未処理の reject にせず、読み込めなかった文を出す', async () => {
    supabaseState.getUserThrows = true;
    await renderElement(createElement(TransferAcceptPage));

    expect(transferLoadErrorBox()).toContain(PROPOSAL_LOAD_ERROR);
    expect(text()).not.toContain(PROPOSAL_NOT_FOUND);
    expect(unhandled).toEqual([]);
  });

  it('提案の問い合わせが例外を投げても、読み込めなかった文を出す', async () => {
    proposalReadable({ proposal: () => Promise.reject(new TypeError('Failed to fetch')) });
    await renderElement(createElement(TransferAcceptPage));

    expect(transferLoadErrorBox()).toContain(PROPOSAL_LOAD_ERROR);
    expect(unhandled).toEqual([]);
  });

  it('「再試行」で読み直し、読めたら提案と承諾・拒否を出す', async () => {
    proposalReadable({ proposal: { data: null, error: LOAD_FAILURE } });
    await renderElement(createElement(TransferAcceptPage));
    expect(proposalQueryCount()).toBe(1);

    supabaseState.single.ownership_transfer_proposals = { data: PROPOSAL, error: null };
    await click(findButton('再試行'), '「再試行」ボタン');

    expect(proposalQueryCount()).toBe(2);
    expect(transferLoadErrorBox()).toBeNull();
    expect(text()).toContain(ORG_NAME);
    expect(text()).toContain('社長');
    expect(findButton('承諾')).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R5 と同じ型: 承諾・拒否の通信エラーのあとの読み直し
// ─────────────────────────────────────────────────────────────────────────────

describe('#2064 R5 と同じ型 オーナーの譲渡の承諾: 承諾・拒否の通信が失敗 (reject) したら、提案を読み直す', () => {
  const ACCEPT_PATH = `/api/org/owner-transfer/${PROPOSAL_ID}/accept`;
  const DECLINE_PATH = `/api/org/owner-transfer/${PROPOSAL_ID}/decline`;

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
    await renderElement(createElement(TransferAcceptPage));
    expect(proposalQueryCount()).toBe(1);

    await click(findButton('承諾'), '「承諾」ボタン');

    expect(callsOf('POST', ACCEPT_PATH)).toHaveLength(1);
    expect(proposalQueryCount()).toBe(2);
    expect(text()).toContain(TRANSFER_NETWORK_ERROR);
    expect(text()).toContain('この提案はすでに承諾済みです');
    expect(findButton('承諾')).toBeUndefined();
    expect(findButton('拒否')).toBeUndefined();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('サーバーが拒否を済ませてから応答が切れたとき、読み直して拒否済みと出す', async () => {
    serverAppliesThenDisconnects(DECLINE_PATH, 'rejected');
    await renderElement(createElement(TransferAcceptPage));

    await click(findButton('拒否'), '「拒否」ボタン');

    expect(callsOf('POST', DECLINE_PATH)).toHaveLength(1);
    expect(proposalQueryCount()).toBe(2);
    expect(text()).toContain(TRANSFER_NETWORK_ERROR);
    expect(text()).toContain('この提案は拒否済みです');
    expect(findButton('承諾')).toBeUndefined();
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
    await renderElement(createElement(TransferAcceptPage));

    await click(findButton('承諾'), '「承諾」ボタン');

    expect(proposalQueryCount()).toBe(2);
    expect(transferLoadErrorBox()).toContain(PROPOSAL_LOAD_ERROR);
    expect(transferLoadErrorBox()).toContain(TRANSFER_NETWORK_ERROR);
    expect(findButton('再試行')).toBeDefined();
    expect(unhandled).toEqual([]);
  });

  it('応答が届いたうえでの失敗 (4xx) は、承諾されていないので読み直さない (これまでどおり)', async () => {
    proposalReadable();
    mockFetch(() => jsonResponse(409, { error: { code: 'PROPOSAL_NOT_PENDING', message: 'この提案はすでに処理されています' } }));
    await renderElement(createElement(TransferAcceptPage));

    await click(findButton('承諾'), '「承諾」ボタン');

    expect(proposalQueryCount()).toBe(1);
    expect(text()).toContain('この提案はすでに処理されています');
    expect(findButton('承諾')).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4 と同じ型: 組織の管理画面の枠
// ─────────────────────────────────────────────────────────────────────────────

describe('#2064 R4 と同じ型 組織の管理画面の枠: 自分のプロフィールを読み込めなかったことを「管理者でない」と見せない', () => {
  const adminProfile = {
    data: { org_role: 'admin', organization_id: ORG_ID, organizations: { name: ORG_NAME, plan: 'standard' } },
    error: null,
  };
  const child = createElement('p', { 'data-testid': 'org-child' }, '子の画面');
  const layoutLoadErrorBox = () => byTestId('org-layout-load-error');

  it('プロフィールの問い合わせが失敗したら、ホームへ移さず、読み込めなかった文と「再試行」を出す', async () => {
    supabaseState.single.user_profiles = { data: null, error: LOAD_FAILURE };
    await renderElement(createElement(OrgLayout, null, child));

    expect(router.push).not.toHaveBeenCalled();
    expect(layoutLoadErrorBox()).toContain(ORG_ADMIN_LOAD_ERROR);
    expect(findButton('再試行')).toBeDefined();
    expect(byTestId('org-child')).toBeNull();
  });

  it('「再試行」で読み直し、管理者と分かったら画面を出す', async () => {
    supabaseState.single.user_profiles = { data: null, error: LOAD_FAILURE };
    await renderElement(createElement(OrgLayout, null, child));
    expect(supabaseState.singleCount.user_profiles).toBe(1);

    supabaseState.single.user_profiles = adminProfile;
    await click(findButton('再試行'), '「再試行」ボタン');

    expect(supabaseState.singleCount.user_profiles).toBe(2);
    expect(layoutLoadErrorBox()).toBeNull();
    expect(byTestId('org-child')).toBe('子の画面');
    expect(text()).toContain(ORG_NAME);
  });

  it('問い合わせが例外を投げても、読み込み中のまま止まらず、読み込めなかった文を出す', async () => {
    supabaseState.getUserThrows = true;
    await renderElement(createElement(OrgLayout, null, child));

    expect(layoutLoadErrorBox()).toContain(ORG_ADMIN_LOAD_ERROR);
    expect(router.push).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it('プロフィールの行が無い (PGRST116) ときは、これまでどおり管理者でない扱いでホームへ移す', async () => {
    supabaseState.single.user_profiles = { data: null, error: NO_ROWS };
    await renderElement(createElement(OrgLayout, null, child));

    expect(router.push).toHaveBeenCalledWith('/home');
    expect(layoutLoadErrorBox()).toBeNull();
  });

  it('管理者でないとわかったときは、これまでどおりホームへ移す', async () => {
    supabaseState.single.user_profiles = { data: { org_role: 'member', organization_id: ORG_ID, organizations: null }, error: null };
    await renderElement(createElement(OrgLayout, null, child));

    expect(router.push).toHaveBeenCalledWith('/home');
    expect(layoutLoadErrorBox()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R5 と同じ型: 部署の追加・削除
// ─────────────────────────────────────────────────────────────────────────────

describe('#2064 R5 と同じ型 組織の部署: 追加・削除の通信が失敗 (reject) したら、一覧を読み直す', () => {
  const DEPARTMENTS_PATH = '/api/org/departments';
  const department = (id: string, name: string) => ({
    id,
    name,
    parentId: null,
    managerId: null,
    displayOrder: 0,
    memberCount: 0,
    createdAt: '2026-10-01T03:00:00.000Z',
  });
  const SALES = department('dept-1', '営業部');
  const DEV = department('dept-2', '開発部');
  const nameInput = () => container.querySelector<HTMLInputElement>('input[placeholder="例: 営業部"]');

  /** サーバーの一覧。書き込みを受け取った時点で反映してから、応答の前に通信が切れる */
  function mockDepartmentsServer(options: { failReload?: boolean } = {}) {
    let server = [SALES];
    let gets = 0;
    mockFetch((method, url) => {
      if (url.pathname !== DEPARTMENTS_PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') {
        gets += 1;
        if (options.failReload && gets > 1) return Promise.reject(new TypeError('Failed to fetch'));
        return jsonResponse(200, { departments: [...server] });
      }
      if (method === 'DELETE') {
        const id = url.searchParams.get('id');
        server = server.filter((d) => d.id !== id);
        throw new TypeError('Failed to fetch');
      }
      if (method === 'POST') {
        server = [...server, DEV];
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  it('サーバーが削除を済ませてから応答が切れたとき、通信エラーの文を出したうえで読み直し、削除した部署を一覧から消す', async () => {
    mockDepartmentsServer();
    await renderElement(createElement(OrgDepartmentsPage));
    expect(text()).toContain('営業部');

    await click(findButton('🗑'), '削除ボタン');

    expect(callsOf('DELETE', DEPARTMENTS_PATH)).toHaveLength(1);
    expect(callsOf('GET', DEPARTMENTS_PATH)).toHaveLength(2);
    // 文は「削除できませんでした」と言わない (読み直した一覧で削除が済んでいるため。#2080 U4)
    expect(byTestId('department-error')).toContain('部署の削除の応答を受け取れませんでした（通信エラー）');
    expect(text()).not.toContain('営業部');
    expect(findButton('🗑')).toBeUndefined();
    expect(text()).toContain('0件の部署');
  });

  it('サーバーが追加を済ませてから応答が切れたとき、読み直して追加された部署を出し、フォームと入力した名前は残す', async () => {
    mockDepartmentsServer();
    await renderElement(createElement(OrgDepartmentsPage));
    await click(findButton('+ 部署を追加'), '「+ 部署を追加」ボタン');
    await typeInto(nameInput(), '開発部');

    await submitForm();

    expect(callsOf('POST', DEPARTMENTS_PATH)).toHaveLength(1);
    expect(callsOf('GET', DEPARTMENTS_PATH)).toHaveLength(2);
    expect(byTestId('department-error')).toContain('部署の追加の応答を受け取れませんでした（通信エラー）');
    expect(text()).toContain('2件の部署');
    expect(nameInput()!.value).toBe('開発部');
  });

  it('削除の通信が失敗し、読み直しも失敗したら、一覧の「読み込めませんでした」と「再試行」を出す', async () => {
    mockDepartmentsServer({ failReload: true });
    await renderElement(createElement(OrgDepartmentsPage));

    await click(findButton('🗑'), '削除ボタン');

    expect(callsOf('GET', DEPARTMENTS_PATH)).toHaveLength(2);
    expect(byTestId('department-error')).toContain('部署の削除の応答を受け取れませんでした（通信エラー）');
    expect(byTestId('department-load-error')).toContain('部署の一覧を読み込めませんでした');
    const retry = findButton('再試行');
    expect(retry).toBeDefined();
    expect(retry!.disabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R5 と同じ型: 招待の送信・取消
// ─────────────────────────────────────────────────────────────────────────────

describe('#2064 R5 と同じ型 組織の招待: 送信・取消の通信が失敗 (reject) したら、履歴を読み直す', () => {
  const INVITES_PATH = '/api/org/invites';
  const invite = (id: string, email: string, status: string) => ({
    id,
    email,
    role: 'member',
    token: `tok-${id}`,
    status,
    isExpired: false,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const FIRST = invite('inv-1', 'first-invitee@example.com', 'pending');
  const REVOKE_PATH = `/api/org/invites/${FIRST.id}/revoke`;

  function mockInvitesServer() {
    let server = [FIRST];
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === INVITES_PATH) return jsonResponse(200, { invites: [...server] });
      if (method === 'POST' && url.pathname === REVOKE_PATH) {
        server = server.map((i) => (i.id === FIRST.id ? { ...i, status: 'revoked' } : i));
        throw new TypeError('Failed to fetch');
      }
      if (method === 'POST' && url.pathname === INVITES_PATH) {
        server = [...server, invite('inv-2', 'second-invitee@example.com', 'pending')];
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  it('サーバーが取消を済ませてから応答が切れたとき、通信エラーを知らせたうえで読み直し、取消のボタンを消す', async () => {
    mockInvitesServer();
    await renderElement(createElement(OrgInvitesPage));
    expect(findButton('取消')).toBeDefined();

    await click(findButton('取消'), '「取消」ボタン');

    expect(callsOf('POST', REVOKE_PATH)).toHaveLength(1);
    expect(callsOf('GET', INVITES_PATH)).toHaveLength(2);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(String(alertSpy.mock.calls[0][0])).toContain('招待の取り消しの応答を受け取れませんでした（通信エラー）');
    expect(text()).toContain('取消済');
    expect(findButton('取消')).toBeUndefined();
  });

  it('サーバーが招待を作ってから応答が切れたとき、読み直して作られた招待を履歴に出す', async () => {
    mockInvitesServer();
    await renderElement(createElement(OrgInvitesPage));
    await click(findButton('+ 新しいメンバーを招待'), '「+ 新しいメンバーを招待」ボタン');
    await typeInto(container.querySelector<HTMLInputElement>('input[type="email"]'), 'second-invitee@example.com');

    await submitForm();

    expect(callsOf('POST', INVITES_PATH)).toHaveLength(1);
    expect(callsOf('GET', INVITES_PATH)).toHaveLength(2);
    expect(text()).toContain('招待の送信の応答を受け取れませんでした（通信エラー）');
    // 入力欄の値は textContent に入らないので、履歴に出たときだけ文字に現れる
    expect(text()).toContain('second-invitee@example.com');
    expect(text()).toContain('first-invitee@example.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R5 と同じ型: チャレンジの作成・開始
// ─────────────────────────────────────────────────────────────────────────────

describe('#2064 R5 と同じ型 組織のチャレンジ: 作成・開始の通信が失敗 (reject) したら、一覧を読み直す', () => {
  const CHALLENGES_PATH = '/api/org/challenges';
  const challenge = (id: string, title: string, status: string) => ({
    id,
    title,
    description: null,
    challengeType: 'breakfast_rate',
    targetValue: 80,
    targetUnit: '%',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    rewardDescription: null,
    status,
    participantCount: null,
    aggregate: { minParticipants: 10, visible: false, averageValue: null },
    createdAt: '2026-09-01T00:00:00Z',
  });
  const FIRST = challenge('ch-1', '朝ごはんチャレンジ', 'draft');

  function mockChallengesServer() {
    let server = [FIRST];
    mockFetch((method, url) => {
      if (url.pathname !== CHALLENGES_PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') return jsonResponse(200, { challenges: [...server] });
      if (method === 'PUT') {
        server = server.map((c) => (c.id === FIRST.id ? { ...c, status: 'active' } : c));
        throw new TypeError('Failed to fetch');
      }
      if (method === 'POST') {
        server = [...server, challenge('ch-2', '野菜チャレンジ', 'draft')];
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  it('サーバーが開始を済ませてから応答が切れたとき、通信エラーの文を出したうえで読み直し、前の状態のボタン (開始) を消す', async () => {
    mockChallengesServer();
    await renderElement(createElement(OrgChallengesPage));
    expect(findButton('開始')).toBeDefined();

    await click(findButton('開始'), '「開始」ボタン');

    expect(callsOf('PUT', CHALLENGES_PATH)).toHaveLength(1);
    expect(callsOf('GET', CHALLENGES_PATH)).toHaveLength(2);
    expect(text()).toContain('チャレンジの状態の変更の応答を受け取れませんでした（通信エラー）');
    expect(findButton('開始')).toBeUndefined();
    expect(findButton('終了')).toBeDefined();
    expect(findButton('終了')!.disabled).toBe(false);
  });

  it('サーバーが作成を済ませてから応答が切れたとき、読み直して作られたチャレンジを一覧に出す', async () => {
    mockChallengesServer();
    await renderElement(createElement(OrgChallengesPage));
    await click(findButton('+ 新規チャレンジ'), '「+ 新規チャレンジ」ボタン');

    await submitForm();

    expect(callsOf('POST', CHALLENGES_PATH)).toHaveLength(1);
    expect(callsOf('GET', CHALLENGES_PATH)).toHaveLength(2);
    expect(text()).toContain('チャレンジの作成の応答を受け取れませんでした（通信エラー）');
    expect(text()).toContain('野菜チャレンジ');
  });
});
