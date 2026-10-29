/**
 * #2086 (triage-1029c) 組織の画面の読み直しの細部
 *
 *   V8 組織のメンバーの画面: 読み直しで自分が組織に属していない (organization_id が無い) と分かったとき、
 *     直す前: 一覧 (members) と自分 (currentUser) を空にせずに「読めた」(true) を返し、前の一覧と「除名」のボタンが残ったまま、
 *     除名の通信が切れたあとの案内は「一覧を読み込み直したので…」と言っていた。
 *     直したあと: 一覧を空・自分を null にし、「組織に所属していません」を出す (除名・脱退・譲渡のボタンを残さない)。
 *   V9 組織のチャレンジ・部署・招待の画面: 書き込みの通信が切れて読み直しにも失敗したときの案内
 *     (「…一覧を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください」) が、
 *     直す前: 「再試行」で読み込めたあとも消えず、まだ読み込めていないように読めた。
 *     直したあと: 「再試行」で読み直せたら、その案内 (errorMessage / submitError) を消す。読み直せなかったときと、
 *     ほかの文 (応答が届いたうえでの失敗の理由など) は残す。
 *   メンバーの画面の除名・招待の取り消しの案内は alert で、画面に残らないので V9 の対象ではない。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORG_WRITE_OPERATION,
  isOrgWriteReloadFailedMessage,
  orgWriteNoResponseMessage,
} from '@/lib/org-write-no-response';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_A_ID = '55555555-5555-4555-8555-555555555555';
const MEMBER_B_ID = '66666666-6666-4666-8666-666666666666';
const ORG_ID = '77777777-7777-4777-8777-777777777777';

/** 画面の文 (画面と同じもの。文そのものを見張るため、部品の関数を通さずに書く) */
const RELOADED_GUIDE = '一覧を読み込み直したので、今の状態を確かめてから、必要ならもう一度操作してください';
const RELOAD_FAILED_GUIDE = '一覧を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください';
const noResponse = (operation: string, guide: string) => `${operation}の応答を受け取れませんでした（通信エラー）。${guide}`;
const NOT_IN_ORG = '組織に所属していません';

const supabaseState = vi.hoisted(() => ({
  profile: { data: null, error: null } as { data: unknown; error: unknown },
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
    auth: { getUser: () => Promise.resolve({ data: { user: { id: USER_ID } }, error: null }) },
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
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * サーバーの一覧の筋書き。書き込みを受け取った時点で反映してから、応答の前に通信を切る。
 * failingGets に入っている回目の一覧の GET (1 から数える。1 回目は開いたときの読み込み) も通信を切る
 */
function serverThatAppliesThenDisconnects<T>(options: {
  listPath: string;
  initial: T[];
  listBody: (items: T[]) => unknown;
  apply: (method: string, url: URL, items: T[]) => T[] | null;
  failingGets: readonly number[];
}) {
  let items = [...options.initial];
  let gets = 0;
  mockFetch((method, url) => {
    if (method === 'GET' && url.pathname === options.listPath) {
      gets += 1;
      if (options.failingGets.includes(gets)) return Promise.reject(new TypeError('Failed to fetch'));
      return jsonResponse(200, options.listBody(items));
    }
    const next = options.apply(method, url, items);
    if (next === null) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    items = next;
    throw new TypeError('Failed to fetch');
  });
}

/** 書き込みのあとの読み直し (2 回目の GET) だけ通信を切る (3 回目の「再試行」は読める) */
const RELOAD_FAILS_RETRY_SUCCEEDS = [2] as const;
/** 書き込みのあとの読み直しも、1 回目の「再試行」も通信を切る */
const RELOAD_AND_RETRY_FAIL = [2, 3] as const;

// ─────────────────────────────────────────────────────────────────────────────
// V9: 文を見分ける部品
// ─────────────────────────────────────────────────────────────────────────────

describe('#2086 V9 isOrgWriteReloadFailedMessage: 読み直しにも失敗したときの案内だけを見分ける', () => {
  const operations = Object.values(ORG_WRITE_OPERATION);

  it.each(operations)('「%sの応答を受け取れませんでした…「再試行」で…」は案内として見分ける', (operation) => {
    expect(isOrgWriteReloadFailedMessage(orgWriteNoResponseMessage(operation, 'reload_failed'))).toBe(true);
    expect(isOrgWriteReloadFailedMessage(noResponse(operation, RELOAD_FAILED_GUIDE))).toBe(true);
  });

  it.each(operations)('「%sの応答を受け取れませんでした…読み込み直したので…」は案内ではない (消さない)', (operation) => {
    expect(isOrgWriteReloadFailedMessage(orgWriteNoResponseMessage(operation, 'reloaded'))).toBe(false);
  });

  it('ほかの文 (応答が届いたうえでの失敗の理由・空・null) は案内ではない', () => {
    expect(isOrgWriteReloadFailedMessage(null)).toBe(false);
    expect(isOrgWriteReloadFailedMessage('')).toBe(false);
    expect(isOrgWriteReloadFailedMessage('下書きのチャレンジだけ開始できます')).toBe(false);
    expect(isOrgWriteReloadFailedMessage(RELOAD_FAILED_GUIDE)).toBe(false);
    // 表に無い操作の名前の文は見分けない (組織の画面の書き込みの文だけを消す)
    expect(isOrgWriteReloadFailedMessage(noResponse('ステータス変更', RELOAD_FAILED_GUIDE))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V9: チャレンジ
// ─────────────────────────────────────────────────────────────────────────────

describe('#2086 V9 組織のチャレンジ: 「再試行」で読み直せたら「「再試行」で読み込み直して」の案内を消す', () => {
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

  function mockServer(failingGets: readonly number[]) {
    serverThatAppliesThenDisconnects<Challenge>({
      listPath: CHALLENGES_PATH,
      initial: [FIRST],
      listBody: (items) => ({ challenges: items }),
      failingGets,
      apply: (method, url, items) => {
        if (url.pathname !== CHALLENGES_PATH) return null;
        if (method === 'PUT') return items.map((c) => (c.id === FIRST.id ? { ...c, status: 'active' } : c));
        if (method === 'POST') return [...items, challenge('ch-2', '野菜チャレンジ', 'draft')];
        return null;
      },
    });
  }

  it('状態の変更の通信が切れ、読み直しも失敗したあと、「再試行」で読み直せたら案内を消し、読み直した一覧を出す', async () => {
    mockServer(RELOAD_FAILS_RETRY_SUCCEEDS);
    await renderElement(createElement(OrgChallengesPage));
    await click(findButton('開始'), '「開始」ボタン');
    expect(byTestId('challenge-error')).toBe(noResponse('チャレンジの状態の変更', RELOAD_FAILED_GUIDE));
    expect(byTestId('challenge-load-error')).not.toBeNull();

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(callsOf('GET', CHALLENGES_PATH)).toHaveLength(3);
    expect(byTestId('challenge-load-error')).toBeNull();
    expect(byTestId('challenge-error')).toBeNull();
    expect(text()).not.toContain('「再試行」で読み込み直して');
    // 読み直した一覧では開始が済んでいる
    expect(findButton('開始')).toBeUndefined();
    expect(findButton('終了')).toBeDefined();
  });

  it('作成の通信が切れ、読み直しも失敗したあと、「再試行」で読み直せたら案内を消す', async () => {
    mockServer(RELOAD_FAILS_RETRY_SUCCEEDS);
    await renderElement(createElement(OrgChallengesPage));
    await click(findButton('+ 新規チャレンジ'), '「+ 新規チャレンジ」ボタン');
    await submitForm();
    expect(byTestId('challenge-error')).toBe(noResponse('チャレンジの作成', RELOAD_FAILED_GUIDE));

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(byTestId('challenge-load-error')).toBeNull();
    expect(byTestId('challenge-error')).toBeNull();
    expect(text()).toContain('野菜チャレンジ');
  });

  it('「再試行」でも読めなかったら、案内は残す (まだ読み込めていないので)', async () => {
    mockServer(RELOAD_AND_RETRY_FAIL);
    await renderElement(createElement(OrgChallengesPage));
    await click(findButton('開始'), '「開始」ボタン');

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(callsOf('GET', CHALLENGES_PATH)).toHaveLength(3);
    expect(byTestId('challenge-load-error')).not.toBeNull();
    expect(byTestId('challenge-error')).toBe(noResponse('チャレンジの状態の変更', RELOAD_FAILED_GUIDE));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V9: 部署
// ─────────────────────────────────────────────────────────────────────────────

describe('#2086 V9 組織の部署: 「再試行」で読み直せたら「「再試行」で読み込み直して」の案内を消す', () => {
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

  function mockServer(failingGets: readonly number[]) {
    serverThatAppliesThenDisconnects<Department>({
      listPath: DEPARTMENTS_PATH,
      initial: [SALES],
      listBody: (items) => ({ departments: items }),
      failingGets,
      apply: (method, url, items) => {
        if (url.pathname !== DEPARTMENTS_PATH) return null;
        if (method === 'DELETE') return items.filter((d) => d.id !== url.searchParams.get('id'));
        if (method === 'POST') return [...items, department('dept-2', '開発部')];
        return null;
      },
    });
  }

  it('削除の通信が切れ、読み直しも失敗したあと、「再試行」で読み直せたら案内を消し、読み直した一覧を出す', async () => {
    mockServer(RELOAD_FAILS_RETRY_SUCCEEDS);
    await renderElement(createElement(OrgDepartmentsPage));
    await click(findButton('🗑'), '削除ボタン');
    expect(byTestId('department-error')).toBe(noResponse('部署の削除', RELOAD_FAILED_GUIDE));

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(callsOf('GET', DEPARTMENTS_PATH)).toHaveLength(3);
    expect(byTestId('department-load-error')).toBeNull();
    expect(byTestId('department-error')).toBeNull();
    expect(text()).toContain('0件の部署');
  });

  it('追加の通信が切れ、読み直しも失敗したあと、「再試行」で読み直せたら案内を消す', async () => {
    mockServer(RELOAD_FAILS_RETRY_SUCCEEDS);
    await renderElement(createElement(OrgDepartmentsPage));
    await click(findButton('+ 部署を追加'), '「+ 部署を追加」ボタン');
    await typeInto(nameInput(), '開発部');
    await submitForm();
    expect(byTestId('department-error')).toBe(noResponse('部署の追加', RELOAD_FAILED_GUIDE));

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(byTestId('department-load-error')).toBeNull();
    expect(byTestId('department-error')).toBeNull();
    expect(text()).toContain('2件の部署');
  });

  it('「再試行」でも読めなかったら、案内は残す', async () => {
    mockServer(RELOAD_AND_RETRY_FAIL);
    await renderElement(createElement(OrgDepartmentsPage));
    await click(findButton('🗑'), '削除ボタン');

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(byTestId('department-load-error')).not.toBeNull();
    expect(byTestId('department-error')).toBe(noResponse('部署の削除', RELOAD_FAILED_GUIDE));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V9: 招待
// ─────────────────────────────────────────────────────────────────────────────

describe('#2086 V9 組織の招待: 「再試行」で読み直せたら送信の「「再試行」で読み込み直して」の案内を消す', () => {
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
  type Invite = ReturnType<typeof invite>;

  function mockServer(failingGets: readonly number[]) {
    serverThatAppliesThenDisconnects<Invite>({
      listPath: INVITES_PATH,
      initial: [FIRST],
      listBody: (items) => ({ invites: items }),
      failingGets,
      apply: (method, url, items) =>
        method === 'POST' && url.pathname === INVITES_PATH
          ? [...items, invite('inv-2', 'second-invitee@example.com', 'pending')]
          : null,
    });
  }

  async function sendInvite() {
    await click(findButton('+ 新しいメンバーを招待'), '「+ 新しいメンバーを招待」ボタン');
    await typeInto(container.querySelector<HTMLInputElement>('input[type="email"]'), 'second-invitee@example.com');
    await submitForm();
  }

  it('送信の通信が切れ、読み直しも失敗したあと、「再試行」で読み直せたら案内を消し、読み直した履歴を出す', async () => {
    mockServer(RELOAD_FAILS_RETRY_SUCCEEDS);
    await renderElement(createElement(OrgInvitesPage));
    await sendInvite();
    expect(byTestId('invite-submit-error')).toBe(noResponse('招待の送信', RELOAD_FAILED_GUIDE));

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(callsOf('GET', INVITES_PATH)).toHaveLength(3);
    expect(byTestId('invite-load-error')).toBeNull();
    expect(byTestId('invite-submit-error')).toBeNull();
    expect(text()).toContain('second-invitee@example.com');
  });

  it('「再試行」でも読めなかったら、案内は残す', async () => {
    mockServer(RELOAD_AND_RETRY_FAIL);
    await renderElement(createElement(OrgInvitesPage));
    await sendInvite();

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(byTestId('invite-load-error')).not.toBeNull();
    expect(byTestId('invite-submit-error')).toBe(noResponse('招待の送信', RELOAD_FAILED_GUIDE));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V8: メンバー
// ─────────────────────────────────────────────────────────────────────────────

describe('#2086 V8 組織のメンバー: 読み直しで組織に属していないと分かったら、前の一覧と「除名」を残さない', () => {
  const MEMBERS_PATH = '/api/org/members';
  const REMOVE_PATH = `/api/org/members/${MEMBER_A_ID}/remove`;
  const me = { id: USER_ID, nickname: 'わたし', org_role: 'owner', joined_org_at: '2026-10-01T03:00:00.000Z' };
  const memberA = { id: MEMBER_A_ID, nickname: 'Aさん', org_role: 'member', joined_org_at: '2026-10-02T03:00:00.000Z' };
  const memberB = { id: MEMBER_B_ID, nickname: 'Bさん', org_role: 'member', joined_org_at: '2026-10-03T03:00:00.000Z' };
  type Member = typeof me;

  /** 組織に属していないときの自分のプロフィール (行は読めて、organization_id が無い) */
  const PROFILE_NOT_IN_ORG = { data: { org_role: null, organization_id: null }, error: null };

  function mockServer() {
    serverThatAppliesThenDisconnects<Member>({
      listPath: MEMBERS_PATH,
      initial: [me, memberA, memberB],
      listBody: (items) => ({ members: items }),
      failingGets: [],
      apply: (method, url, items) => {
        if (method !== 'POST' || url.pathname !== REMOVE_PATH) return null;
        // 除名の通信のあいだに、自分が組織から外された (別の管理者の除名・運営の強制解散など)
        supabaseState.profile = PROFILE_NOT_IN_ORG;
        return items;
      },
    });
  }

  const removeButtonOfA = () =>
    Array.from(container.querySelectorAll('tr'))
      .find((row) => row.textContent?.includes('Aさん'))
      ?.querySelector('button') ?? undefined;

  it('除名の通信が切れ、読み直しで組織に属していないと分かったら、一覧・「除名」・脱退・譲渡を消して「組織に所属していません」を出す', async () => {
    supabaseState.profile = { data: { org_role: 'owner', organization_id: ORG_ID }, error: null };
    mockServer();
    await renderElement(createElement(MembersPage));
    expect(text()).toContain('Aさん');
    expect(findButton('除名')).toBeDefined();

    await click(removeButtonOfA(), 'Aさんの「除名」ボタン');

    expect(callsOf('POST', REMOVE_PATH)).toHaveLength(1);
    // 組織に属していないので、一覧の API は読みに行かない (開いたときの 1 回だけ)
    expect(callsOf('GET', MEMBERS_PATH)).toHaveLength(1);
    expect(byTestId('member-not-in-org')).toBe(NOT_IN_ORG);
    // 前の一覧 (自分を含む) と、除名・脱退・譲渡を残さない
    expect(text()).not.toContain('Aさん');
    expect(text()).not.toContain('Bさん');
    expect(text()).not.toContain('わたし');
    expect(findButton('除名')).toBeUndefined();
    expect(findButton('組織を脱退')).toBeUndefined();
    expect(text()).not.toContain('オーナーを譲渡');
    // 人数も「メンバーがいません」も出さない
    expect(text()).not.toContain('組織メンバー (');
    expect(text()).not.toContain('メンバーがいません');
    expect(byTestId('member-load-error')).toBeNull();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(String(alertSpy.mock.calls[0][0])).toBe(noResponse('除名', RELOADED_GUIDE));
  });

  it('開いたときに組織に属していなければ、「メンバーがいません」ではなく「組織に所属していません」を出す', async () => {
    supabaseState.profile = PROFILE_NOT_IN_ORG;
    mockServer();

    await renderElement(createElement(MembersPage));

    expect(byTestId('member-not-in-org')).toBe(NOT_IN_ORG);
    expect(text()).not.toContain('メンバーがいません');
    expect(text()).not.toContain('組織メンバー (');
    expect(findButton('組織を脱退')).toBeUndefined();
    expect(callsOf('GET', MEMBERS_PATH)).toHaveLength(0);
  });
});
