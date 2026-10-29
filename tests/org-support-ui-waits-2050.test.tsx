/**
 * #2050 組織とサポートの画面の、応答を待つ間の操作と読み込みの失敗のテスト
 *
 *   - P1: 組織の招待の「取消」・部署の「削除」(と同じ型の、チャレンジの「開始」・「終了」) が、応答 (と読み直し) を待つ間も
 *     ボタンを止めていなかった。二度押しで 2 本目を送ると、取り消せて (削除できて) いるのに 2 本目が断られ、失敗の文が出る
 *   - P2: サポートの利用者の画面で、メモの追加・詳細の読み込みの応答を待つ間に別の利用者を選ぶと、
 *     届いた応答で詳細の欄が前の利用者になる (次のメモは、いま選んでいる・画面に出ていない利用者に書かれる)。
 *     選び直した利用者の詳細が読めなかったときも、前の利用者の詳細が残っていた
 *   - P4: 組織の部署の一覧の読み込みに失敗すると「部署がありません」と出ていた
 *     (同じ型: 招待の履歴・チャレンジの一覧・メンバーの一覧・サポートのダッシュボード)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orgMemberListKeyOf, orgMemberListResponse } from './helpers/org-member-list-fetch';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER_ID = '44444444-4444-4444-8444-444444444444';

const supabaseState = vi.hoisted(() => ({
  /** メンバーの画面の Supabase の問い合わせの結果 (テストごとに差し替える) */
  profile: { data: null as unknown, error: null as unknown },
  /** メンバーの一覧の API (GET /api/org/members。#2073 S4) の結果。以前の問い合わせと同じ { data, error } で書く
   *  (tests/helpers/org-member-list-fetch.ts が API の応答に直す) */
  members: { data: null as unknown, error: null as unknown },
  /** メンバーの一覧の API の GET を送った回数 */
  membersQueryCount: 0,
}));

vi.mock('next/navigation', () => ({
  // サポートの利用者の画面は ?id= の利用者の詳細を開いた状態で始める
  useSearchParams: () => new URLSearchParams(`id=${USER_ID}`),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

// メンバーの画面は自分のプロフィールを Supabase の問い合わせで読む (一覧は API。下の mockFetch)
vi.mock('@/lib/supabase/client', () => {
  const builder = (table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      single: () => Promise.resolve(supabaseState.profile),
      table,
    };
    return query;
  };
  return {
    createClient: () => ({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: USER_ID } } }) },
      from: (table: string) => builder(table),
    }),
  };
});

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

const { default: SupportUsersPage } = await import('@/app/(support)/support/users/page');
const { default: SupportDashboard } = await import('@/app/(support)/support/page');
const { default: OrgDepartmentsPage } = await import('@/app/(org)/org/departments/page');
const { default: OrgInvitesPage } = await import('@/app/(org)/org/invites/page');
const { default: OrgChallengesAdminPage } = await import('@/app/(org)/org/challenges/page');
const { default: MembersPage } = await import('@/app/(org)/org/members/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 本文が JSON でない応答 (プロキシの 502 など) */
function htmlResponse(status: number) {
  return new Response('<html>Bad Gateway</html>', { status, headers: { 'content-type': 'text/html' } });
}

/** あとで返す応答 (応答を待つ間の画面を確かめるため) */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let alertSpy: ReturnType<typeof vi.fn>;

type Handler = (method: string, url: URL, body: unknown) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    // メンバーの一覧の API の GET は supabaseState.members から返す (#2073 S4)
    const listKey = orgMemberListKeyOf(input, init);
    if (listKey !== null) {
      supabaseState.membersQueryCount += 1;
      return orgMemberListResponse(listKey, supabaseState.members);
    }
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

const text = () => container.textContent ?? '';
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage(component: () => React.ReactNode) {
  await act(async () => {
    root.render(createElement(component));
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  alertSpy = vi.fn();
  vi.stubGlobal('alert', alertSpy);
  supabaseState.profile = { data: null, error: null };
  supabaseState.members = { data: null, error: null };
  supabaseState.membersQueryCount = 0;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// P1: 組織の招待の取消
// ─────────────────────────────────────────────────────────────────────────────

describe('組織の招待: 取消の応答を待つ間はボタンを止める (P1)', () => {
  const INVITE = {
    id: 'inv-1',
    email: 'invitee@example.com',
    role: 'member',
    token: 'tok',
    status: 'pending',
    isExpired: false,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const REVOKE_PATH = `/api/org/invites/${INVITE.id}/revoke`;

  it('二度押ししても 2 本目を送らず、取り消せたのに失敗の文を出さない', async () => {
    const revoke = deferred<Response>();
    let revoked = false;
    let revokeCount = 0;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/org/invites') {
        return jsonResponse(200, { invites: [{ ...INVITE, status: revoked ? 'revoked' : 'pending' }] });
      }
      if (method === 'POST' && url.pathname === REVOKE_PATH) {
        revokeCount += 1;
        // 2 本目は、取り消し済みの招待として断られる (本番の route と同じ)
        if (revokeCount > 1) return jsonResponse(404, { error: { code: 'INVITE_NOT_FOUND', message: '招待が見つかりません' } });
        return revoke.promise.then((res) => {
          revoked = true;
          return res;
        });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderPage(OrgInvitesPage);

    await click(findButton('取消'), '「取消」ボタン');
    expect(findButton('取消')!.disabled).toBe(true);
    await click(findButton('取消'), '「取消」ボタン (2 回目)');

    expect(callsOf('POST', REVOKE_PATH)).toHaveLength(1);

    await act(async () => {
      revoke.resolve(jsonResponse(200, { ok: true }));
    });
    await settle();

    expect(callsOf('POST', REVOKE_PATH)).toHaveLength(1);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(text()).toContain('取消済');
    expect(findButton('取消')).toBeUndefined();
  });

  it('取消が断られたら、ボタンを戻してもう一度押せる', async () => {
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/org/invites') return jsonResponse(200, { invites: [INVITE] });
      if (method === 'POST' && url.pathname === REVOKE_PATH) return jsonResponse(500, { error: { message: 'サーバーエラーが発生しました' } });
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderPage(OrgInvitesPage);

    await click(findButton('取消'), '「取消」ボタン');
    expect(alertSpy).toHaveBeenCalledWith('サーバーエラーが発生しました');
    expect(findButton('取消')!.disabled).toBe(false);

    await click(findButton('取消'), '「取消」ボタン (2 回目)');
    expect(callsOf('POST', REVOKE_PATH)).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1: 組織の部署の削除
// ─────────────────────────────────────────────────────────────────────────────

const DEPARTMENT = {
  id: 'dept-1',
  name: '営業部',
  parentId: null,
  managerId: null,
  displayOrder: 0,
  memberCount: 3,
  createdAt: '2026-10-01T03:00:00.000Z',
};

describe('組織の部署: 削除の応答を待つ間はボタンを止める (P1)', () => {
  it('二度押ししても 2 本目の DELETE を送らず、削除できたのに失敗の文を出さない', async () => {
    const del = deferred<Response>();
    let deleted = false;
    let deleteCount = 0;
    mockFetch((method, url) => {
      if (url.pathname !== '/api/org/departments') throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') return jsonResponse(200, { departments: deleted ? [] : [DEPARTMENT] });
      if (method === 'DELETE') {
        deleteCount += 1;
        // 2 本目は、削除済みの部署として断られる (本番の route と同じ)
        if (deleteCount > 1) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: '部署が見つかりません' } });
        return del.promise.then((res) => {
          deleted = true;
          return res;
        });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderPage(OrgDepartmentsPage);

    await click(findButton('🗑'), '削除ボタン');
    expect(findButton('🗑')!.disabled).toBe(true);
    await click(findButton('🗑'), '削除ボタン (2 回目)');

    expect(callsOf('DELETE', '/api/org/departments')).toHaveLength(1);

    await act(async () => {
      del.resolve(jsonResponse(200, { success: true }));
    });
    await settle();

    expect(callsOf('DELETE', '/api/org/departments')).toHaveLength(1);
    expect(byTestId('department-error')).toBeNull();
    expect(text()).toContain('部署がありません');
  });

  it('削除が断られたら、ボタンを戻してもう一度押せる', async () => {
    mockFetch((method, url) => {
      if (url.pathname !== '/api/org/departments') throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') return jsonResponse(200, { departments: [DEPARTMENT] });
      if (method === 'DELETE') return jsonResponse(500, { error: { message: 'サーバーエラーが発生しました' } });
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderPage(OrgDepartmentsPage);

    await click(findButton('🗑'), '削除ボタン');
    expect(byTestId('department-error')).toContain('部署を削除できませんでした');
    expect(findButton('🗑')!.disabled).toBe(false);

    await click(findButton('🗑'), '削除ボタン (2 回目)');
    expect(callsOf('DELETE', '/api/org/departments')).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1 と同じ型: 組織のチャレンジの開始・終了
// ─────────────────────────────────────────────────────────────────────────────

function adminChallenge(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000d1',
    title: '朝食チャレンジ',
    description: null,
    challengeType: 'breakfast_rate',
    targetValue: 80,
    targetUnit: '%',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    rewardDescription: null,
    status: 'draft',
    departmentId: null,
    departmentName: null,
    participantCount: 12,
    aggregate: { minParticipants: 10, visible: false, averageValue: null },
    createdAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

describe('組織のチャレンジ: 状態の変更の応答を待つ間はボタンを止める (P1 と同じ型)', () => {
  it('「開始」を二度押ししても 2 本目の PUT を送らず、変えられたのに失敗の文を出さない', async () => {
    const put = deferred<Response>();
    let started = false;
    let putCount = 0;
    mockFetch((method, url) => {
      if (url.pathname !== '/api/org/challenges') throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') return jsonResponse(200, { challenges: [adminChallenge({ status: started ? 'active' : 'draft' })] });
      if (method === 'PUT') {
        putCount += 1;
        if (putCount > 1) return jsonResponse(409, { error: { message: 'このチャレンジはすでに開始しています' } });
        return put.promise.then((res) => {
          started = true;
          return res;
        });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderPage(OrgChallengesAdminPage);

    await click(findButton('開始'), '「開始」ボタン');
    expect(findButton('開始')!.disabled).toBe(true);
    await click(findButton('開始'), '「開始」ボタン (2 回目)');
    expect(callsOf('PUT', '/api/org/challenges')).toHaveLength(1);

    await act(async () => {
      put.resolve(jsonResponse(200, { challenge: {} }));
    });
    await settle();

    expect(callsOf('PUT', '/api/org/challenges')).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(findButton('終了')).toBeDefined();
    expect(findButton('終了')!.disabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P4: 一覧の読み込みの失敗を、空の一覧と見せない
// ─────────────────────────────────────────────────────────────────────────────

describe('組織の部署: 一覧を読み込めなかったら「部署がありません」と出さない (P4)', () => {
  it.each([
    ['500', () => jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' } }), 'サーバーエラーが発生しました'],
    ['403 (権限が無い)', () => jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'Forbidden' } }), '権限がありません'],
    ['本文が JSON でない 502', () => htmlResponse(502), 'HTTP 502'],
    ['通信エラー', () => Promise.reject(new TypeError('Failed to fetch')), '通信エラー'],
  ])('一覧の GET が %s なら、理由と「再試行」を出す', async (_label, get, reason) => {
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/org/departments') return get();
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderPage(OrgDepartmentsPage);

    expect(byTestId('department-load-error')).toContain('部署の一覧を読み込めませんでした');
    expect(byTestId('department-load-error')).toContain(reason);
    expect(text()).not.toContain('部署がありません');
    expect(text()).not.toContain('0件の部署');
    expect(findButton('再試行')).toBeDefined();
  });

  it('「再試行」で読めたら、失敗の文を消して一覧を出す', async () => {
    let attempt = 0;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/org/departments') {
        attempt += 1;
        return attempt === 1 ? jsonResponse(500, { error: { message: 'サーバーエラーが発生しました' } }) : jsonResponse(200, { departments: [DEPARTMENT] });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderPage(OrgDepartmentsPage);
    expect(byTestId('department-load-error')).not.toBeNull();

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(byTestId('department-load-error')).toBeNull();
    expect(text()).toContain('営業部');
    expect(text()).toContain('1件の部署');
    expect(callsOf('GET', '/api/org/departments')).toHaveLength(2);
  });

  it('本当に部署が無いときは、これまでどおり「部署がありません」と出す', async () => {
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/org/departments') return jsonResponse(200, { departments: [] });
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderPage(OrgDepartmentsPage);

    expect(byTestId('department-load-error')).toBeNull();
    expect(text()).toContain('部署がありません');
  });
});

describe('組織の招待: 履歴を読み込めなかったら「招待はありません」と出さない (P4 と同じ型)', () => {
  it.each([
    ['500', () => jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' } }), 'サーバーエラーが発生しました'],
    ['通信エラー', () => Promise.reject(new TypeError('Failed to fetch')), '通信エラー'],
  ])('履歴の GET が %s なら、理由と「再試行」を出し、再試行で読めたら履歴を出す', async (_label, firstGet, reason) => {
    let attempt = 0;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/org/invites') {
        attempt += 1;
        return attempt === 1
          ? firstGet()
          : jsonResponse(200, { invites: [{ id: 'inv-1', email: 'invitee@example.com', role: 'member', token: 't', status: 'pending', isExpired: false, expiresAt: '2099-01-01T00:00:00.000Z' }] });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderPage(OrgInvitesPage);

    expect(byTestId('invite-load-error')).toContain('招待の履歴を読み込めませんでした');
    expect(byTestId('invite-load-error')).toContain(reason);
    expect(text()).not.toContain('招待はありません');

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(byTestId('invite-load-error')).toBeNull();
    expect(text()).toContain('invitee@example.com');
  });
});

describe('組織のチャレンジ: 一覧を読み込めなかったら「チャレンジがありません」と出さない (P4 と同じ型)', () => {
  it('一覧の GET が 500 なら理由と「再試行」を出し、再試行で読めたら一覧を出す', async () => {
    let attempt = 0;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/org/challenges') {
        attempt += 1;
        return attempt === 1
          ? jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' } })
          : jsonResponse(200, { challenges: [adminChallenge()] });
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderPage(OrgChallengesAdminPage);

    expect(byTestId('challenge-load-error')).toContain('チャレンジの一覧を読み込めませんでした');
    expect(byTestId('challenge-load-error')).toContain('サーバーエラーが発生しました');
    expect(text()).not.toContain('チャレンジがありません');

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(byTestId('challenge-load-error')).toBeNull();
    expect(text()).toContain('朝食チャレンジ');
  });

  it('通信エラーでも「チャレンジがありません」と出さない', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderPage(OrgChallengesAdminPage);

    expect(byTestId('challenge-load-error')).toContain('通信エラー');
    expect(text()).not.toContain('チャレンジがありません');
  });
});

describe('組織のメンバー: 一覧を読み込めなかったら「メンバーがいません」と出さない (P4 と同じ型)', () => {
  const MEMBER = { id: USER_ID, nickname: '管理者さん', org_role: 'admin', joined_org_at: '2026-10-01T03:00:00.000Z' };

  it('メンバーの一覧の API が失敗したら、失敗の文と「再試行」を出し、再試行で読めたら一覧を出す', async () => {
    mockFetch((method, url) => {
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    supabaseState.profile = { data: { org_role: 'admin', organization_id: 'org-1' }, error: null };
    supabaseState.members = { data: null, error: { message: 'permission denied for table user_profiles', code: '42501' } };
    await renderPage(MembersPage);

    expect(byTestId('member-load-error')).toContain('メンバーの一覧を読み込めませんでした');
    // 内部の英語の文は出さない
    expect(text()).not.toContain('permission denied');
    expect(text()).not.toContain('メンバーがいません');
    expect(text()).not.toContain('(0 名)');

    supabaseState.members = { data: [MEMBER], error: null };
    await click(findButton('再試行'), '「再試行」ボタン');

    expect(byTestId('member-load-error')).toBeNull();
    expect(text()).toContain('管理者さん');
    expect(text()).toContain('(1 名)');
    expect(supabaseState.membersQueryCount).toBe(2);
  });

  it('自分のプロフィールの問い合わせが失敗しても、「メンバーがいません」と出さない', async () => {
    mockFetch((method, url) => {
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    supabaseState.profile = { data: null, error: { message: 'JWT expired', code: 'PGRST301' } };
    await renderPage(MembersPage);

    expect(byTestId('member-load-error')).toContain('メンバーの一覧を読み込めませんでした');
    expect(text()).not.toContain('メンバーがいません');
  });
});

describe('サポートのダッシュボード: 対応状況を読み込めなかったら「0 件」と出さない (P4 と同じ型)', () => {
  const STATS = {
    overview: { pendingInquiries: 4, inProgressInquiries: 2, resolvedToday: 1, totalInquiries: 20, myResolvedThisWeek: 3 },
    inquiriesByType: {},
    recentInquiries: [],
  };

  it('GET が 500 なら理由と「再試行」を出し、件数と「問い合わせはありません」は出さない。再試行で読めたら件数を出す', async () => {
    let attempt = 0;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/support/stats') {
        attempt += 1;
        return attempt === 1 ? jsonResponse(500, { error: 'サーバーエラーが発生しました' }) : jsonResponse(200, STATS);
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    await renderPage(SupportDashboard);

    expect(byTestId('support-stats-load-error')).toContain('対応状況を読み込めませんでした');
    expect(byTestId('support-stats-load-error')).toContain('サーバーエラーが発生しました');
    expect(text()).not.toContain('問い合わせはありません');
    expect(text()).not.toContain('未対応');

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(byTestId('support-stats-load-error')).toBeNull();
    expect(text()).toContain('未対応');
    expect(text()).toContain('4');
  });

  it('通信エラーでも件数を 0 と出さない', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderPage(SupportDashboard);

    expect(byTestId('support-stats-load-error')).toContain('通信エラー');
    expect(text()).not.toContain('問い合わせはありません');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2: サポートの利用者の画面で、応答を待つ間に別の利用者を選ぶ
// ─────────────────────────────────────────────────────────────────────────────

describe('サポートの利用者: 応答を待つ間に別の利用者を選んでも、詳細の欄は選んだ利用者のまま (P2)', () => {
  const notesPath = (id: string) => `/api/support/users/${id}/notes`;

  function userDetail(id: string, nickname: string) {
    return {
      user: {
        id,
        nickname,
        ageGroup: '30s',
        gender: 'female',
        roles: ['user'],
        organizationId: null,
        isBanned: false,
        bannedAt: null,
        bannedReason: null,
        lastLoginAt: null,
        loginCount: 1,
        profileCompleteness: 50,
        createdAt: '2026-10-01T03:00:00.000Z',
      },
      stats: { mealCount: 0, aiSessionCount: 0 },
      inquiries: [],
      notes: [],
    };
  }

  const NICKNAME_A = 'サポート対象さん';
  const NICKNAME_B = '別の利用者さん';

  /** 一覧の 1 行 (GET /api/admin/users の UserListItem) */
  const OTHER_USER_ROW = {
    id: OTHER_USER_ID,
    email: null,
    nickname: NICKNAME_B,
    plan_key: 'free',
    roles: ['user'],
    is_banned: false,
    frozen_at: null,
    frozen_reason: null,
    frozen_by: null,
    unban_at: null,
    last_login_at: null,
    registered_at: '2026-10-01T03:00:00.000Z',
    meal_count: 0,
    organization_id: null,
  };

  interface SupportApi {
    detailA?: () => Response | Promise<Response>;
    detailB?: () => Response | Promise<Response>;
    postA?: () => Response | Promise<Response>;
    postB?: () => Response | Promise<Response>;
  }

  function mockSupportApi(api: SupportApi) {
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === '/api/admin/users') {
        return jsonResponse(200, { data: [OTHER_USER_ROW], meta: { total: 1, page: 1, per_page: 50 } });
      }
      if (method === 'GET' && url.pathname === `/api/support/users/${USER_ID}`) {
        return api.detailA ? api.detailA() : jsonResponse(200, userDetail(USER_ID, NICKNAME_A));
      }
      if (method === 'GET' && url.pathname === `/api/support/users/${OTHER_USER_ID}`) {
        return api.detailB ? api.detailB() : jsonResponse(200, userDetail(OTHER_USER_ID, NICKNAME_B));
      }
      if (method === 'POST' && url.pathname === notesPath(USER_ID) && api.postA) return api.postA();
      if (method === 'POST' && url.pathname === notesPath(OTHER_USER_ID) && api.postB) return api.postB();
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  const noteInput = () => container.querySelector<HTMLInputElement>('input[placeholder="メモを追加..."]');
  const detailName = () => container.querySelector('h2')?.textContent ?? null;
  const otherRow = () => Array.from(container.querySelectorAll('p')).find((el) => el.textContent === NICKNAME_B);

  it('メモの追加の応答を待つ間に別の利用者を選ぶと、成功の応答が届いても詳細の欄は選んだ利用者のまま。次のメモは詳細の欄の利用者に送る', async () => {
    const postA = deferred<Response>();
    mockSupportApi({ postA: () => postA.promise, postB: () => jsonResponse(201, { note: {} }) });
    await renderPage(SupportUsersPage);
    await vi.waitFor(() => expect(detailName()).toBe(NICKNAME_A));

    await typeInto(noteInput(), 'A さんへのメモ');
    await click(findButton('追加'), '「追加」ボタン');
    await click(otherRow(), '別の利用者の行');
    await vi.waitFor(() => expect(detailName()).toBe(NICKNAME_B));

    const detailACallsBefore = callsOf('GET', `/api/support/users/${USER_ID}`).length;
    await act(async () => {
      postA.resolve(jsonResponse(201, { note: {} }));
    });
    await settle();

    // 送った利用者 (A) の詳細を読み直して、選んでいる B の欄を A で上書きしない
    expect(callsOf('GET', `/api/support/users/${USER_ID}`)).toHaveLength(detailACallsBefore);
    expect(detailName()).toBe(NICKNAME_B);

    // 次のメモは、詳細の欄に出ている利用者 (B) に送る
    await typeInto(noteInput(), 'B さんへのメモ');
    await click(findButton('追加'), '「追加」ボタン (B)');
    expect(callsOf('POST', notesPath(OTHER_USER_ID))).toHaveLength(1);
    expect(callsOf('POST', notesPath(USER_ID))).toHaveLength(1);
    expect(detailName()).toBe(NICKNAME_B);
  });

  it('別の利用者を選んだら、前の利用者に宛てた書きかけのメモを入力欄に残さない (選んだ利用者に追加しないように)', async () => {
    mockSupportApi({});
    await renderPage(SupportUsersPage);
    await vi.waitFor(() => expect(detailName()).toBe(NICKNAME_A));

    await typeInto(noteInput(), 'A さんへのメモ');
    await click(otherRow(), '別の利用者の行');
    await vi.waitFor(() => expect(detailName()).toBe(NICKNAME_B));

    expect(noteInput()!.value).toBe('');
    expect(findButton('追加')!.disabled).toBe(true);
  });

  it('応答を待つ間に別の利用者を選んで書き始めたメモは、前の利用者へのメモの成功の応答で消さない', async () => {
    const postA = deferred<Response>();
    mockSupportApi({ postA: () => postA.promise });
    await renderPage(SupportUsersPage);
    await vi.waitFor(() => expect(detailName()).toBe(NICKNAME_A));

    await typeInto(noteInput(), '1 つ目のメモ');
    await click(findButton('追加'), '「追加」ボタン');
    await click(otherRow(), '別の利用者の行');
    await vi.waitFor(() => expect(detailName()).toBe(NICKNAME_B));
    await typeInto(noteInput(), 'B さんへの書きかけ');

    await act(async () => {
      postA.resolve(jsonResponse(201, { note: {} }));
    });
    await settle();

    expect(noteInput()!.value).toBe('B さんへの書きかけ');
    expect(detailName()).toBe(NICKNAME_B);
  });

  it('メモの追加の応答を待つ間に入力欄を書き直したら、成功の応答で書き直したメモを消さない', async () => {
    const postA = deferred<Response>();
    mockSupportApi({ postA: () => postA.promise });
    await renderPage(SupportUsersPage);
    await vi.waitFor(() => expect(detailName()).toBe(NICKNAME_A));

    await typeInto(noteInput(), '1 つ目のメモ');
    await click(findButton('追加'), '「追加」ボタン');
    await typeInto(noteInput(), '2 つ目のメモ');

    await act(async () => {
      postA.resolve(jsonResponse(201, { note: {} }));
    });
    await settle();

    expect(noteInput()!.value).toBe('2 つ目のメモ');
    // 送ったのは 1 つ目のメモ
    const [, init] = callsOf('POST', notesPath(USER_ID))[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ note: '1 つ目のメモ' });
  });

  it('メモの追加の応答を待つ間に別の利用者を選ぶと、失敗の応答が届いても選んだ利用者の詳細に失敗の文を出さない', async () => {
    const postA = deferred<Response>();
    mockSupportApi({ postA: () => postA.promise });
    await renderPage(SupportUsersPage);
    await vi.waitFor(() => expect(detailName()).toBe(NICKNAME_A));

    await typeInto(noteInput(), 'A さんへのメモ');
    await click(findButton('追加'), '「追加」ボタン');
    await click(otherRow(), '別の利用者の行');
    await vi.waitFor(() => expect(detailName()).toBe(NICKNAME_B));

    await act(async () => {
      postA.resolve(jsonResponse(500, { error: 'サーバーエラーが発生しました' }));
    });
    await settle();

    expect(byTestId('note-add-error')).toBeNull();
    expect(detailName()).toBe(NICKNAME_B);
  });

  it('前の利用者の詳細の応答が、選び直した利用者の詳細より後に届いても、詳細の欄は選び直した利用者のまま', async () => {
    const detailA = deferred<Response>();
    mockSupportApi({ detailA: () => detailA.promise });
    await renderPage(SupportUsersPage);

    // A の詳細を待つ間に B を選ぶ
    await click(otherRow(), '別の利用者の行');
    await vi.waitFor(() => expect(detailName()).toBe(NICKNAME_B));

    await act(async () => {
      detailA.resolve(jsonResponse(200, userDetail(USER_ID, NICKNAME_A)));
    });
    await settle();

    expect(detailName()).toBe(NICKNAME_B);
    expect(text()).not.toContain(NICKNAME_A);
  });

  it('選び直した利用者の詳細を読み込めなかったら、前の利用者の詳細を残さず失敗の文を出す', async () => {
    mockSupportApi({ detailB: () => jsonResponse(500, { error: 'サーバーエラーが発生しました' }) });
    await renderPage(SupportUsersPage);
    await vi.waitFor(() => expect(detailName()).toBe(NICKNAME_A));

    await click(otherRow(), '別の利用者の行');

    await vi.waitFor(() => expect(byTestId('user-detail-load-error')).toContain('ユーザーの詳細を読み込めませんでした'));
    expect(byTestId('user-detail-load-error')).toContain('サーバーエラーが発生しました');
    expect(detailName()).toBeNull();
    expect(noteInput()).toBeNull();
  });
});
