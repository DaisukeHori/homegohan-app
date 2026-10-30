/**
 * #2080 U4 (triage-1029b) 組織の管理画面の書き込みの通信が切れたときの文
 *
 *   直す前: 書き込み (チャレンジの作成・状態の変更 / 招待の送信・取り消し / 部署の追加・更新・削除 / メンバーの除名) の通信が
 *   reject したとき、画面は一覧を読み直して済んだ状態を出すのに、文は「〜できませんでした（通信エラー）」
 *   「招待の取り消しに失敗しました（通信エラー）」「除名失敗: 通信エラーが発生しました」で、自分の操作が失敗したと読めた。
 *   直したあと: 運営の画面 (#2076・src/lib/super-admin/status-change-no-response.ts) と同じく
 *   「<操作>の応答を受け取れませんでした（通信エラー）」とし、読み直しの結果 (読めた / 読めなかった) で後半の案内を出し分ける。
 *   招待の取り消し・除名の alert は、読み直しの結果が分かってから出す。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_A_ID = '55555555-5555-4555-8555-555555555555';
const MEMBER_B_ID = '66666666-6666-4666-8666-666666666666';
const ORG_ID = '77777777-7777-4777-8777-777777777777';

/** 画面の文 (画面と同じもの。文そのものを見張るため、部品の関数を通さずに書く) */
const RELOADED_GUIDE = '一覧を読み込み直したので、今の状態を確かめてから、必要ならもう一度操作してください';
const RELOAD_FAILED_GUIDE = '一覧を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください';
const noResponse = (operation: string, guide: string) => `${operation}の応答を受け取れませんでした（通信エラー）。${guide}`;

/** 自分の操作が失敗したと読める文 (直す前の文の部分)。reject のあとの文には含まない */
const FAILURE_WORDING = [
  'できませんでした（通信エラー）',
  'できませんでした。通信状況',
  'に失敗しました',
  '除名失敗',
  '通信エラーが発生しました',
];

/** supabase.auth.getUser の結果 (本物は通信の失敗を投げずに { data: { user: null }, error } で返す) */
type GetUserResult = { data: { user: { id: string } | null }; error: unknown };

const supabaseState = vi.hoisted(() => ({
  profile: { data: null, error: null } as { data: unknown; error: unknown },
  /** getUser が順に返す結果。空なら自分 (USER_ID) を返す */
  getUserResults: [] as GetUserResult[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: () => undefined }),
  useParams: () => ({}),
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

// メンバーの画面は自分のプロフィールを Supabase の 1 行 (single) で読む。本物と同じく毎回同じクライアントを返す
vi.mock('@/lib/supabase/client', () => {
  const query = {
    select: () => query,
    eq: () => query,
    single: () => Promise.resolve(supabaseState.profile),
  };
  const client = {
    auth: {
      getUser: () =>
        Promise.resolve(supabaseState.getUserResults.shift() ?? { data: { user: { id: USER_ID } }, error: null }),
    },
    from: () => query,
  };
  return { createClient: () => client };
});

const { default: OrgChallengesPage } = await import('@/app/(org)/org/challenges/page');
const { default: OrgInvitesPage } = await import('@/app/(org)/org/invites/page');
const { default: OrgDepartmentsPage } = await import('@/app/(org)/org/departments/page');
const { default: MembersPage } = await import('@/app/(org)/org/members/page');

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

/** reject のあとの文が、自分の操作が失敗したと読める言い方を含まない */
function expectNoFailureWording(message: string | null) {
  for (const wording of FAILURE_WORDING) expect(message ?? '').not.toContain(wording);
}

/** alert で出した文 (1 回だけ出す) */
function onlyAlert(): string {
  expect(alertSpy).toHaveBeenCalledTimes(1);
  return String(alertSpy.mock.calls[0][0]);
}

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
  supabaseState.profile = { data: null, error: null };
  supabaseState.getUserResults = [];
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

/**
 * サーバーの一覧の筋書き。書き込みを受け取った時点で反映してから、応答の前に通信を切る。
 * failReload のときは、書き込みのあとの読み直し (2 回目以降の GET) も通信を切る
 */
function serverThatAppliesThenDisconnects<T>(options: {
  listPath: string;
  initial: T[];
  listBody: (items: T[]) => unknown;
  apply: (method: string, url: URL, items: T[]) => T[] | null;
  failReload: boolean;
}) {
  let items = [...options.initial];
  let gets = 0;
  mockFetch((method, url) => {
    if (method === 'GET' && url.pathname === options.listPath) {
      gets += 1;
      if (options.failReload && gets > 1) return Promise.reject(new TypeError('Failed to fetch'));
      return jsonResponse(200, options.listBody(items));
    }
    const next = options.apply(method, url, items);
    if (next === null) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    items = next;
    throw new TypeError('Failed to fetch');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// チャレンジの作成・状態の変更
// ─────────────────────────────────────────────────────────────────────────────

describe('#2080 U4 組織のチャレンジ: 作成・状態の変更の通信が切れたときの文', () => {
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
  type Challenge = ReturnType<typeof challenge>;

  function mockServer(failReload: boolean) {
    serverThatAppliesThenDisconnects<Challenge>({
      listPath: CHALLENGES_PATH,
      initial: [FIRST],
      listBody: (items) => ({ challenges: items }),
      failReload,
      apply: (method, url, items) => {
        if (url.pathname !== CHALLENGES_PATH) return null;
        if (method === 'PUT') return items.map((c) => (c.id === FIRST.id ? { ...c, status: 'active' } : c));
        if (method === 'POST') return [...items, challenge('ch-2', '野菜チャレンジ', 'draft')];
        return null;
      },
    });
  }

  it('状態の変更 (開始) が済んでから応答が切れ、一覧を読み直せたら、「状態の変更の応答を受け取れませんでした」と読み直した旨を出す', async () => {
    mockServer(false);
    await renderElement(createElement(OrgChallengesPage));

    await click(findButton('開始'), '「開始」ボタン');

    expect(callsOf('PUT', CHALLENGES_PATH)).toHaveLength(1);
    expect(callsOf('GET', CHALLENGES_PATH)).toHaveLength(2);
    expect(byTestId('challenge-error')).toBe(noResponse('チャレンジの状態の変更', RELOADED_GUIDE));
    expectNoFailureWording(byTestId('challenge-error'));
    // 読み直した一覧では開始が済んでいる
    expect(findButton('開始')).toBeUndefined();
    expect(findButton('終了')).toBeDefined();
  });

  it('状態の変更の通信が切れ、一覧の読み直しも失敗したら、「再試行」で読み直すよう促す', async () => {
    mockServer(true);
    await renderElement(createElement(OrgChallengesPage));

    await click(findButton('開始'), '「開始」ボタン');

    expect(byTestId('challenge-error')).toBe(noResponse('チャレンジの状態の変更', RELOAD_FAILED_GUIDE));
    expect(byTestId('challenge-load-error')).toContain('チャレンジの一覧を読み込めませんでした');
    expect(findButton('再試行')).toBeDefined();
  });

  it('作成が済んでから応答が切れ、一覧を読み直せたら、「作成の応答を受け取れませんでした」と読み直した旨を出す', async () => {
    mockServer(false);
    await renderElement(createElement(OrgChallengesPage));
    await click(findButton('+ 新規チャレンジ'), '「+ 新規チャレンジ」ボタン');

    await submitForm();

    expect(callsOf('POST', CHALLENGES_PATH)).toHaveLength(1);
    expect(callsOf('GET', CHALLENGES_PATH)).toHaveLength(2);
    expect(byTestId('challenge-error')).toBe(noResponse('チャレンジの作成', RELOADED_GUIDE));
    expectNoFailureWording(byTestId('challenge-error'));
    expect(text()).toContain('野菜チャレンジ');
  });

  it('作成の通信が切れ、一覧の読み直しも失敗したら、「再試行」で読み直すよう促す', async () => {
    mockServer(true);
    await renderElement(createElement(OrgChallengesPage));
    await click(findButton('+ 新規チャレンジ'), '「+ 新規チャレンジ」ボタン');

    await submitForm();

    expect(byTestId('challenge-error')).toBe(noResponse('チャレンジの作成', RELOAD_FAILED_GUIDE));
    expect(byTestId('challenge-load-error')).toContain('チャレンジの一覧を読み込めませんでした');
  });

  it('応答が届いたうえでの失敗 (4xx) は、これまでどおり理由の文を出す (応答を受け取れなかった文にしない)', async () => {
    mockFetch((method) =>
      method === 'GET'
        ? jsonResponse(200, { challenges: [FIRST] })
        : jsonResponse(409, { error: { message: '下書きのチャレンジだけ開始できます' } }),
    );
    await renderElement(createElement(OrgChallengesPage));

    await click(findButton('開始'), '「開始」ボタン');

    expect(byTestId('challenge-error')).toBe('下書きのチャレンジだけ開始できます');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 招待の送信・取り消し
// ─────────────────────────────────────────────────────────────────────────────

describe('#2080 U4 組織の招待: 送信・取り消しの通信が切れたときの文', () => {
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
  type Invite = ReturnType<typeof invite>;

  function mockServer(failReload: boolean) {
    serverThatAppliesThenDisconnects<Invite>({
      listPath: INVITES_PATH,
      initial: [FIRST],
      listBody: (items) => ({ invites: items }),
      failReload,
      apply: (method, url, items) => {
        if (method === 'POST' && url.pathname === REVOKE_PATH)
          return items.map((i) => (i.id === FIRST.id ? { ...i, status: 'revoked' } : i));
        if (method === 'POST' && url.pathname === INVITES_PATH)
          return [...items, invite('inv-2', 'second-invitee@example.com', 'pending')];
        return null;
      },
    });
  }

  async function sendInvite() {
    await click(findButton('+ 新しいメンバーを招待'), '「+ 新しいメンバーを招待」ボタン');
    await typeInto(container.querySelector<HTMLInputElement>('input[type="email"]'), 'second-invitee@example.com');
    await submitForm();
  }

  it('取り消しが済んでから応答が切れ、履歴を読み直せたら、読み直したあとに「取り消しの応答を受け取れませんでした」を出す', async () => {
    mockServer(false);
    await renderElement(createElement(OrgInvitesPage));
    let getsWhenAlerted = -1;
    alertSpy.mockImplementation(() => {
      getsWhenAlerted = callsOf('GET', INVITES_PATH).length;
    });

    await click(findButton('取消'), '「取消」ボタン');

    expect(callsOf('POST', REVOKE_PATH)).toHaveLength(1);
    const message = onlyAlert();
    expect(message).toBe(noResponse('招待の取り消し', RELOADED_GUIDE));
    expectNoFailureWording(message);
    // alert は読み直しの結果が分かってから出す (読み直しの GET を送り終えたあと)
    expect(getsWhenAlerted).toBe(2);
    expect(text()).toContain('取消済');
    expect(findButton('取消')).toBeUndefined();
  });

  it('取り消しの通信が切れ、履歴の読み直しも失敗したら、「再試行」で読み直すよう促す', async () => {
    mockServer(true);
    await renderElement(createElement(OrgInvitesPage));

    await click(findButton('取消'), '「取消」ボタン');

    expect(onlyAlert()).toBe(noResponse('招待の取り消し', RELOAD_FAILED_GUIDE));
    expect(byTestId('invite-load-error')).toContain('招待の履歴を読み込めませんでした');
    expect(findButton('再試行')).toBeDefined();
  });

  it('送信が済んでから応答が切れ、履歴を読み直せたら、「送信の応答を受け取れませんでした」と読み直した旨を出す', async () => {
    mockServer(false);
    await renderElement(createElement(OrgInvitesPage));

    await sendInvite();

    expect(callsOf('POST', INVITES_PATH)).toHaveLength(1);
    expect(callsOf('GET', INVITES_PATH)).toHaveLength(2);
    expect(byTestId('invite-submit-error')).toBe(noResponse('招待の送信', RELOADED_GUIDE));
    expectNoFailureWording(byTestId('invite-submit-error'));
    expect(text()).toContain('second-invitee@example.com');
  });

  it('送信の通信が切れ、履歴の読み直しも失敗したら、「再試行」で読み直すよう促す', async () => {
    mockServer(true);
    await renderElement(createElement(OrgInvitesPage));

    await sendInvite();

    expect(byTestId('invite-submit-error')).toBe(noResponse('招待の送信', RELOAD_FAILED_GUIDE));
    expect(byTestId('invite-load-error')).toContain('招待の履歴を読み込めませんでした');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 部署の追加・更新・削除
// ─────────────────────────────────────────────────────────────────────────────

describe('#2080 U4 組織の部署: 追加・更新・削除の通信が切れたときの文', () => {
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
  type Department = ReturnType<typeof department>;
  const nameInput = () => container.querySelector<HTMLInputElement>('input[placeholder="例: 営業部"]');

  function mockServer(failReload: boolean) {
    serverThatAppliesThenDisconnects<Department>({
      listPath: DEPARTMENTS_PATH,
      initial: [SALES],
      listBody: (items) => ({ departments: items }),
      failReload,
      apply: (method, url, items) => {
        if (url.pathname !== DEPARTMENTS_PATH) return null;
        if (method === 'DELETE') return items.filter((d) => d.id !== url.searchParams.get('id'));
        if (method === 'POST') return [...items, department('dept-2', '開発部')];
        if (method === 'PUT') return items.map((d) => (d.id === SALES.id ? { ...d, name: '第一営業部' } : d));
        return null;
      },
    });
  }

  it('削除が済んでから応答が切れ、一覧を読み直せたら、「削除の応答を受け取れませんでした」と読み直した旨を出す', async () => {
    mockServer(false);
    await renderElement(createElement(OrgDepartmentsPage));

    await click(findButton('🗑'), '削除ボタン');

    expect(callsOf('DELETE', DEPARTMENTS_PATH)).toHaveLength(1);
    expect(callsOf('GET', DEPARTMENTS_PATH)).toHaveLength(2);
    expect(byTestId('department-error')).toBe(noResponse('部署の削除', RELOADED_GUIDE));
    expectNoFailureWording(byTestId('department-error'));
    expect(text()).toContain('0件の部署');
  });

  it('削除の通信が切れ、一覧の読み直しも失敗したら、「再試行」で読み直すよう促す', async () => {
    mockServer(true);
    await renderElement(createElement(OrgDepartmentsPage));

    await click(findButton('🗑'), '削除ボタン');

    expect(byTestId('department-error')).toBe(noResponse('部署の削除', RELOAD_FAILED_GUIDE));
    expect(byTestId('department-load-error')).toContain('部署の一覧を読み込めませんでした');
  });

  it('追加が済んでから応答が切れ、一覧を読み直せたら、「追加の応答を受け取れませんでした」と読み直した旨を出す', async () => {
    mockServer(false);
    await renderElement(createElement(OrgDepartmentsPage));
    await click(findButton('+ 部署を追加'), '「+ 部署を追加」ボタン');
    await typeInto(nameInput(), '開発部');

    await submitForm();

    expect(byTestId('department-error')).toBe(noResponse('部署の追加', RELOADED_GUIDE));
    expectNoFailureWording(byTestId('department-error'));
    expect(text()).toContain('2件の部署');
  });

  it('追加の通信が切れ、一覧の読み直しも失敗したら、「再試行」で読み直すよう促す', async () => {
    mockServer(true);
    await renderElement(createElement(OrgDepartmentsPage));
    await click(findButton('+ 部署を追加'), '「+ 部署を追加」ボタン');
    await typeInto(nameInput(), '開発部');

    await submitForm();

    expect(byTestId('department-error')).toBe(noResponse('部署の追加', RELOAD_FAILED_GUIDE));
  });

  it('更新が済んでから応答が切れ、一覧を読み直せたら、「更新の応答を受け取れませんでした」と読み直した旨を出す', async () => {
    mockServer(false);
    await renderElement(createElement(OrgDepartmentsPage));
    await click(findButton('✏️'), '編集ボタン');
    await typeInto(nameInput(), '第一営業部');

    await submitForm();

    expect(callsOf('PUT', DEPARTMENTS_PATH)).toHaveLength(1);
    expect(byTestId('department-error')).toBe(noResponse('部署の更新', RELOADED_GUIDE));
    expectNoFailureWording(byTestId('department-error'));
  });

  it('応答が届いたうえでの失敗 (409) は、これまでどおり「部署を削除できませんでした（理由）」を出す', async () => {
    mockFetch((method) =>
      method === 'GET'
        ? jsonResponse(200, { departments: [SALES] })
        : jsonResponse(409, { error: { message: 'メンバーが所属している部署は削除できません' } }),
    );
    await renderElement(createElement(OrgDepartmentsPage));

    await click(findButton('🗑'), '削除ボタン');

    expect(byTestId('department-error')).toBe('部署を削除できませんでした（メンバーが所属している部署は削除できません）');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// メンバーの除名
// ─────────────────────────────────────────────────────────────────────────────

describe('#2080 U4 組織のメンバー: 除名の通信が切れたときの文', () => {
  const MEMBERS_PATH = '/api/org/members';
  const REMOVE_PATH = `/api/org/members/${MEMBER_A_ID}/remove`;
  const me = { id: USER_ID, nickname: 'わたし', org_role: 'owner', joined_org_at: '2026-10-01T03:00:00.000Z' };
  const memberA = { id: MEMBER_A_ID, nickname: 'Aさん', org_role: 'member', joined_org_at: '2026-10-02T03:00:00.000Z' };
  const memberB = { id: MEMBER_B_ID, nickname: 'Bさん', org_role: 'member', joined_org_at: '2026-10-03T03:00:00.000Z' };
  type Member = typeof me;

  beforeEach(() => {
    supabaseState.profile = { data: { org_role: 'owner', organization_id: ORG_ID }, error: null };
  });

  function mockServer(failReload: boolean) {
    serverThatAppliesThenDisconnects<Member>({
      listPath: MEMBERS_PATH,
      initial: [me, memberA, memberB],
      listBody: (items) => ({ members: items }),
      failReload,
      apply: (method, url, items) =>
        method === 'POST' && url.pathname === REMOVE_PATH ? items.filter((m) => m.id !== MEMBER_A_ID) : null,
    });
  }

  const removeButtonOfA = () =>
    Array.from(container.querySelectorAll('tr'))
      .find((row) => row.textContent?.includes('Aさん'))
      ?.querySelector('button') ?? undefined;

  it('除名が済んでから応答が切れ、一覧を読み直せたら、読み直したあとに「除名の応答を受け取れませんでした」を出す', async () => {
    mockServer(false);
    await renderElement(createElement(MembersPage));
    let getsWhenAlerted = -1;
    alertSpy.mockImplementation(() => {
      getsWhenAlerted = callsOf('GET', MEMBERS_PATH).length;
    });

    await click(removeButtonOfA(), 'Aさんの「除名」ボタン');

    expect(callsOf('POST', REMOVE_PATH)).toHaveLength(1);
    const message = onlyAlert();
    expect(message).toBe(noResponse('除名', RELOADED_GUIDE));
    expectNoFailureWording(message);
    expect(getsWhenAlerted).toBe(2);
    expect(text()).not.toContain('Aさん');
    expect(text()).toContain('組織メンバー (2 名)');
  });

  it('除名の通信が切れ、一覧の読み直しも失敗したら、「再試行」で読み直すよう促す', async () => {
    mockServer(true);
    await renderElement(createElement(MembersPage));

    await click(removeButtonOfA(), 'Aさんの「除名」ボタン');

    expect(onlyAlert()).toBe(noResponse('除名', RELOAD_FAILED_GUIDE));
    expect(byTestId('member-load-error')).not.toBeNull();
    expect(findButton('再試行')).toBeDefined();
    expect(unhandled).toEqual([]);
  });

  /**
   * オフラインのとき、読み直しの最初の supabase.auth.getUser は投げずに { data: { user: null }, error } を返す
   * (@supabase/auth-js は通信の失敗を AuthRetryableFetchError にし、_getUser の catch が投げずに返す)。
   * 直す前は、この経路で fetchData が「読み込めませんでした」を出さずに false を返し、alert は「「再試行」で読み込み直して」と言うのに、
   * 画面には「再試行」が無く、除名の前の一覧が今の状態のまま残っていた (R1 指摘 1)
   */
  const AUTH_NETWORK_FAILURE: GetUserResult = {
    data: { user: null },
    error: Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0, __isAuthError: true }),
  };

  // getUser が user なし・error なしで返す (ログインしていない) ときは、#2093 W9 からログインの画面へ移す
  // (「再試行」を出しても変わらないため)。その経路は下のテストと tests/membership-getuser-remaining-2093.test.tsx が見る
  it.each<[string, GetUserResult]>([
    ['自分を確かめる通信も失敗した (getUser が error を返す)', AUTH_NETWORK_FAILURE],
  ])(
    '除名の通信が切れ、読み直しで%s ときも、alert の「再試行」の案内と画面の「読み込めませんでした」「再試行」が合う',
    async (_case, getUserResult) => {
      mockServer(false);
      await renderElement(createElement(MembersPage));
      expect(text()).toContain('Aさん');
      // 開いたときの getUser は済んでいる。次の getUser (除名のあとの読み直し) から返す
      supabaseState.getUserResults = [getUserResult];
      let loadErrorWhenAlerted: string | null = null;
      alertSpy.mockImplementation(() => {
        loadErrorWhenAlerted = byTestId('member-load-error');
      });

      await click(removeButtonOfA(), 'Aさんの「除名」ボタン');

      expect(callsOf('POST', REMOVE_PATH)).toHaveLength(1);
      expect(onlyAlert()).toBe(noResponse('除名', RELOAD_FAILED_GUIDE));
      // alert を出した時点で、画面はもう「読み込めませんでした」を出している (案内と画面が食い違わない)
      expect(loadErrorWhenAlerted).toContain('メンバーの一覧を読み込めませんでした');
      expect(byTestId('member-load-error')).toContain('メンバーの一覧を読み込めませんでした');
      expect(findButton('再試行')).toBeDefined();
      // 除名の前の一覧 (除名が済んでいたかもしれない A さん) を今の状態として残さない・人数も出さない
      expect(text()).not.toContain('Aさん');
      expect(text()).not.toContain('組織メンバー (');
      // 一覧の API は読みに行かない (自分を確かめられていないので)
      expect(callsOf('GET', MEMBERS_PATH)).toHaveLength(1);
      expect(unhandled).toEqual([]);

      // 「再試行」で読み直すと、済んでいた除名が写った一覧が出る
      await click(findButton('再試行'), '「再試行」ボタン');
      expect(byTestId('member-load-error')).toBeNull();
      expect(text()).not.toContain('Aさん');
      expect(text()).toContain('組織メンバー (2 名)');
    },
  );

  it('除名の通信が切れ、読み直しでログインしていない (user も error も無い) と分かったら、「再試行」の案内を出さず、前の一覧も残さない (#2093 W9)', async () => {
    mockServer(false);
    await renderElement(createElement(MembersPage));
    expect(text()).toContain('Aさん');
    supabaseState.getUserResults = [{ data: { user: null }, error: null }];

    await click(removeButtonOfA(), 'Aさんの「除名」ボタン');

    expect(callsOf('POST', REMOVE_PATH)).toHaveLength(1);
    // ログインの画面へ移るので、「「再試行」で読み込み直して」の案内を出さない (画面に「再試行」が無い)
    expect(alertSpy).not.toHaveBeenCalled();
    expect(byTestId('member-load-error')).toBeNull();
    expect(text()).not.toContain('Aさん');
    expect(unhandled).toEqual([]);
  });

  it('開いたときに自分を確かめられなかったら、「メンバーがいません」と出さずに「読み込めませんでした」と「再試行」を出す', async () => {
    mockServer(false);
    supabaseState.getUserResults = [AUTH_NETWORK_FAILURE];

    await renderElement(createElement(MembersPage));

    expect(byTestId('member-load-error')).toContain('メンバーの一覧を読み込めませんでした');
    expect(findButton('再試行')).toBeDefined();
    expect(text()).not.toContain('メンバーがいません');
    expect(text()).not.toContain('組織メンバー (0 名)');
    expect(callsOf('GET', MEMBERS_PATH)).toHaveLength(0);
  });
});
