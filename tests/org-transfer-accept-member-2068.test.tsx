/**
 * #2068 組織のオーナーの譲渡を一般メンバー (org_role = member) が承諾できなかった — 描画のテスト
 *
 * 承諾の画面 /org/transfer-accept/[proposal_id] は、組織の管理画面の枠 (src/app/(org)/layout.tsx。owner / admin でない人を
 * /home へ送る) の下にあったため、譲渡先が一般メンバーだと開けなかった。直したあとは、家族の譲渡の承諾の画面と同じ
 * ログインした利用者の枠 (src/app/(main)/ の MainLayout) の下に置く (置き場の確かめは tests/org-transfer-accept-route-group-2068.test.ts)。
 *
 * 確かめること:
 *   1. 一般メンバーが承諾の画面を開ける (/home へ送られず、提案と承諾・拒否のボタンが出る)
 *   2. 一般メンバーには管理画面の部品 (組織の管理画面のサイドバーの項目・「管理メニュー」の「組織管理」) が出ない
 *      (同じ枠で管理者 (admin) には「組織管理」が出るので、確かめが空振りしていない)
 *   3. 一般メンバーが承諾すると /org/dashboard へ移り、承諾で owner になった本人は組織の管理画面の枠を通る。拒否すると /home へ移る
 *   4. 組織の管理画面のほかのパスは、今までどおり一般メンバーを /home へ送り、中身を出さない
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '55555555-5555-4555-8555-555555555555';
const OLD_OWNER_ID = '66666666-6666-4666-8666-666666666666';
const ORG_ID = '88888888-8888-4888-8888-888888888888';
const PROPOSAL_ID = 'e1eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const ORG_NAME = 'ほめゴハン株式会社';

/** 組織の管理画面のサイドバーの項目 (src/app/(org)/layout.tsx の orgNavItems) と「管理メニュー」の「組織管理」の行き先 */
const ORG_ADMIN_HREFS = ['/org/dashboard', '/org/members', '/org/invites', '/org/departments', '/org/challenges', '/org/settings'];
/** 組織の管理画面のほかのパス (一般メンバーは /home へ送られる) */
const OTHER_ORG_ADMIN_PATHS = [...ORG_ADMIN_HREFS, '/org/settings/owner-transfer'];

/** 自分のプロフィール (MainLayout と組織の管理画面の枠が読む user_profiles の行) */
type SelfProfile = {
  roles: string[];
  org_role: 'owner' | 'admin' | 'member' | null;
  organization_id: string | null;
  organizations: { name: string; plan: string } | null;
};

function profileWithRole(orgRole: SelfProfile['org_role']): SelfProfile {
  return { roles: ['user'], org_role: orgRole, organization_id: ORG_ID, organizations: { name: ORG_NAME, plan: 'standard' } };
}

const state = vi.hoisted(() => ({
  pathname: '/org/transfer-accept/e1eebc99-9c0b-4ef8-bb6d-6bb9bd380a55',
  selfProfile: null as unknown,
}));

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: () => undefined }));
const params = vi.hoisted(() => ({ proposal_id: 'e1eebc99-9c0b-4ef8-bb6d-6bb9bd380a55' }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useParams: () => params,
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

// アニメーションは本題ではないので、motion.* は同じタグの素の要素、AnimatePresence は子をそのまま返す
vi.mock('framer-motion', () => {
  const MOTION_ONLY_PROPS = ['initial', 'animate', 'exit', 'transition', 'layoutId', 'whileHover', 'whileTap'];
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

// MainLayout の部品のうち、本題 (枠の出し分け) に関係ないものは差し替える
vi.mock('@/components/icons', () => ({ Icons: new Proxy({}, { get: () => () => null }) }));
vi.mock('@/components/AIChatBubble', () => ({ default: () => null }));
vi.mock('@/components/native-app/NativeAppTabRouter', () => ({ NativeAppTabRouter: () => null }));
vi.mock('@/components/native-app/NativeSessionWatcher', () => ({ NativeSessionWatcher: () => null }));
vi.mock('@/components/consent/AiConsentRequiredHost', () => ({ AiConsentRequiredHost: () => null }));
vi.mock('@/components/consent/AiDailyLimitHost', () => ({ AiDailyLimitHost: () => null }));

/** ほめゴハン株式会社のオーナーから、ログイン中の自分 (一般メンバー) への譲渡提案。期限内で pending */
const PROPOSAL = {
  id: PROPOSAL_ID,
  from_user_id: OLD_OWNER_ID,
  to_user_id: USER_ID,
  status: 'pending',
  proposed_at: '2026-10-01T00:00:00.000Z',
  expires_at: '2999-01-01T00:00:00.000Z',
  scope_id: ORG_ID,
};

// MainLayout・組織の管理画面の枠・承諾の画面は、Supabase の 1 行 (single) の問い合わせで読む。
// user_profiles は id で自分 (枠が読む) と提案者 (画面が読む) を分ける
vi.mock('@/lib/supabase/client', () => {
  const NO_ROWS = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };
  const builder = (table: string) => {
    const filters: Record<string, unknown> = {};
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return query;
      },
      single: async () => {
        if (table === 'user_profiles') {
          if (filters.id === USER_ID) return { data: state.selfProfile, error: state.selfProfile ? null : NO_ROWS };
          if (filters.id === OLD_OWNER_ID) return { data: { nickname: '社長' }, error: null };
          return { data: null, error: NO_ROWS };
        }
        if (table === 'ownership_transfer_proposals') return { data: PROPOSAL, error: null };
        if (table === 'organizations') return { data: { name: ORG_NAME }, error: null };
        return { data: null, error: NO_ROWS };
      },
    };
    return query;
  };
  // 本物の createClient (ブラウザではシングルトン) と同じく、毎回同じクライアントを返す
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
    from: (table: string) => builder(table),
  };
  return { createClient: () => client };
});

const { default: TransferAcceptPage } = await import('@/app/(main)/org/transfer-accept/[proposal_id]/page');
const { default: MainLayout } = await import('@/app/(main)/MainLayout');
const { default: OrgLayout } = await import('@/app/(org)/layout');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 認証 → プロフィール・提案の読み込み → 描画の更新まで待つための、マクロタスクの回数 */
const SETTLE_TICKS = 5;
/** 組織の管理画面の枠の中身として描く目印 */
const ORG_CHILD_TEST_ID = 'org-admin-child';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

async function settle() {
  await act(async () => {
    for (let i = 0; i < SETTLE_TICKS; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderElement(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
  await settle();
}

/** 承諾の画面を、置き場の枠 (ログインした利用者の枠) で包んで描く */
async function renderTransferAccept() {
  state.pathname = `/org/transfer-accept/${PROPOSAL_ID}`;
  await renderElement(createElement(MainLayout, null, createElement(TransferAcceptPage)));
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

const hrefs = () => Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
const pushedTo = () => router.push.mock.calls.map(([to]) => to);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('alert', vi.fn());
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    throw new Error(`想定していない fetch: ${(init?.method ?? 'GET').toUpperCase()} ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  router.push.mockReset();
  router.replace.mockReset();
  state.selfProfile = profileWithRole('member');
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('#2068 一般メンバーが組織のオーナーの譲渡の承諾の画面を開ける', () => {
  it('一般メンバーは /home へ送られず、提案と承諾・拒否のボタンが出る', async () => {
    await renderTransferAccept();

    expect(pushedTo()).not.toContain('/home');
    expect(router.replace).not.toHaveBeenCalled();
    expect(container.textContent).toContain('オーナー譲渡の提案');
    expect(container.textContent).toContain(ORG_NAME);
    expect(findButton('承諾')).toBeDefined();
    expect(findButton('拒否')).toBeDefined();
  });

  it('一般メンバーには管理画面の部品 (組織の管理画面のサイドバー・「管理メニュー」の「組織管理」) が出ない', async () => {
    await renderTransferAccept();

    for (const href of ORG_ADMIN_HREFS) {
      expect(hrefs(), `${href} へのリンクが出ている`).not.toContain(href);
    }
    expect(container.textContent).not.toContain('管理メニュー');
    expect(container.textContent).not.toContain('組織管理');
  });

  it('同じ枠で管理者 (admin) が譲渡先なら「組織管理」が出る (確かめが空振りしていない)', async () => {
    state.selfProfile = profileWithRole('admin');
    await renderTransferAccept();

    expect(container.textContent).toContain('オーナー譲渡の提案');
    expect(hrefs()).toContain('/org/dashboard');
    expect(container.textContent).toContain('組織管理');
  });

  it('一般メンバーが承諾すると承諾の API を呼び、/org/dashboard へ移る', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/org/owner-transfer/${PROPOSAL_ID}/accept`);
      expect((init?.method ?? 'GET').toUpperCase()).toBe('POST');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await renderTransferAccept();

    await click(findButton('承諾'), '承諾のボタン');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pushedTo()).toEqual(['/org/dashboard']);
  });

  it('承諾のあとの行き先 /org/dashboard は、owner になった本人なら組織の管理画面の枠を通る', async () => {
    // 承諾の関数 (accept_org_owner_transfer) は承諾した本人の org_role を owner にする
    state.selfProfile = profileWithRole('owner');
    state.pathname = '/org/dashboard';
    await renderElement(
      createElement(OrgLayout, null, createElement('p', { 'data-testid': ORG_CHILD_TEST_ID }, 'dashboard')),
    );

    expect(pushedTo()).not.toContain('/home');
    expect(container.querySelector(`[data-testid="${ORG_CHILD_TEST_ID}"]`)).not.toBeNull();
  });

  it('一般メンバーが拒否すると拒否の API を呼び、一般メンバーも行ける /home へ移る', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      expect(String(input)).toBe(`/api/org/owner-transfer/${PROPOSAL_ID}/decline`);
      expect((init?.method ?? 'GET').toUpperCase()).toBe('POST');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await renderTransferAccept();

    await click(findButton('拒否'), '拒否のボタン');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pushedTo()).toEqual(['/home']);
  });
});

describe('#2068 組織の管理画面のほかのパスは、今までどおり一般メンバーを /home へ送る', () => {
  it.each(OTHER_ORG_ADMIN_PATHS.map((p) => [p]))('%s: 一般メンバーは /home へ送られ、中身は出ない', async (pathname) => {
    state.pathname = pathname;
    await renderElement(
      createElement(OrgLayout, null, createElement('p', { 'data-testid': ORG_CHILD_TEST_ID }, 'admin page')),
    );

    expect(pushedTo()).toEqual(['/home']);
    expect(container.querySelector(`[data-testid="${ORG_CHILD_TEST_ID}"]`)).toBeNull();
  });
});
