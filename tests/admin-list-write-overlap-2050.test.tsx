/**
 * #2050 (10/26 の整合ゲート 1026e の続き) 組織・運営の画面で、書き込みを重ねて送らない・古い読み直しで表示を上書きしないテスト
 *
 * 次の画面は、1 つの書き込み (とそのあとの読み直し) の応答を待つ間も、同じ画面のほかの書き込みのボタンを押せた。
 * 書き込みのあとの読み直しは、それぞれが自分の書き込みのあとに送るので、応答が送った順と逆に届くと、
 * 後に届いた古い一覧 (例: 消した部署がまだある一覧) で表示が上書きされ、消したはずの行のボタンをもう一度押せてしまう
 * (#2053 のクーポン・機能パッケージ (P3) と同じ型)。
 *   - 組織の部署 (/org/departments): 追加・更新と削除。追加・更新のあとの読み直しは待たずに投げていた
 *   - 組織の招待 (/org/invites): 招待の送信と取消。送信のあとの読み直しは待たずに投げていた
 *   - 組織のチャレンジ (/org/challenges): 作成と開始・終了。作成のあとの読み直しは待たずに投げていた
 *   - 組織のメンバー (/org/members): 別のメンバーの除名を重ねて送れた (止めていたのは同じ行の二度押しだけ)
 *   - サポートのチケットの詳細 (/admin/support/[id]): 返信・担当者の設定・ステータスの変更
 *   - 営業のリードの詳細 (/admin/sales/[id]): 活動の記録とステージの変更
 * 直したあとは、書き込みとその読み直しを待つ間は、同じ画面のほかの書き込みのボタンも止め、押されても送らない
 * (#2053 と同じ形: 書き込み中の ref と、ボタンの disabled)。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_A_ID = '55555555-5555-4555-8555-555555555555';
const MEMBER_B_ID = '66666666-6666-4666-8666-666666666666';

const supabaseState = vi.hoisted(() => ({
  /** メンバーの画面の Supabase の問い合わせの結果 (テストごとに差し替える) */
  profile: { data: null as unknown, error: null as unknown },
  members: { data: null as unknown, error: null as unknown },
}));

// useRouter は毎回同じものを返す (画面は router を useCallback の依存に入れているので、毎回新しいと取得が止まらない)
const router = vi.hoisted(() => ({ push: () => undefined, refresh: () => undefined }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

// メンバーの画面は Supabase の問い合わせで一覧を読む
vi.mock('@/lib/supabase/client', () => {
  const builder = () => {
    const query = {
      select: () => query,
      eq: () => query,
      single: () => Promise.resolve(supabaseState.profile),
      order: () => Promise.resolve(supabaseState.members),
    };
    return query;
  };
  return {
    createClient: () => ({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: USER_ID } } }) },
      from: () => builder(),
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

const { default: OrgDepartmentsPage } = await import('@/app/(org)/org/departments/page');
const { default: OrgInvitesPage } = await import('@/app/(org)/org/invites/page');
const { default: OrgChallengesAdminPage } = await import('@/app/(org)/org/challenges/page');
const { default: MembersPage } = await import('@/app/(org)/org/members/page');
const { default: TicketDetailPage } = await import('@/app/admin/support/[id]/page');
const { default: LeadDetailPage } = await import('@/app/admin/sales/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// チケットの詳細の画面はメッセージの末尾へ scrollIntoView する。テストの DOM には無いので、何もしない関数を置く
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => undefined;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** あとで返す応答 (応答を待つ間の画面を確かめるため) */
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
    root.render(createElement(Suspense, { fallback: null }, element));
  });
  await settle();
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
}

const buttonsLabeled = (label: string) =>
  Array.from(container.querySelectorAll('button')).filter((b) => b.textContent?.trim() === label);

async function click(element: HTMLElement | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeDefined();
  await act(async () => {
    element!.click();
  });
  await settle();
}

async function typeInto(element: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  expect(element, '入力欄が見つからない').not.toBeNull();
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
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

/**
 * 解決済みの params。React の use() は status が fulfilled の thenable なら止まらずに value を返すので、
 * 描画を Suspense で止めずに済む (毎回の描画で新しい Promise を作ると、解決を待つ間に止まり続けるため)
 */
function fulfilledParams(id: string): Promise<{ id: string }> {
  const value = { id };
  return Object.assign(Promise.resolve(value), { status: 'fulfilled' as const, value });
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
// 組織の部署
// ─────────────────────────────────────────────────────────────────────────────

describe('組織の部署: 追加・更新と削除を重ねて送らず、古い一覧で表示を上書きしない', () => {
  const DEPARTMENTS_PATH = '/api/org/departments';
  function department(id: string, name: string) {
    return { id, name, parentId: null, managerId: null, displayOrder: 0, memberCount: 0, createdAt: '2026-10-01T03:00:00.000Z' };
  }
  /** サーバーの部署 (追加・削除で変わる)。一覧の GET は、受け取った時点のこの値を返す */
  let server: Array<ReturnType<typeof department>>;
  const shownNames = () => Array.from(container.querySelectorAll('h3')).map((h) => h.textContent);
  const serverNames = () => server.map((d) => d.name);

  /** heldGets に入れた番号 (1 始まり) の GET の応答は、値を受け取った時点で決め、返すのは release まで待つ */
  function mockDepartmentsApi(options: { heldGets?: number[]; postGate?: Promise<void>; deleteGate?: Promise<void> } = {}) {
    const releases: Array<() => void> = [];
    let getCount = 0;
    let created = 0;
    mockFetch((method, url, body) => {
      if (url.pathname !== DEPARTMENTS_PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') {
        getCount += 1;
        const response = jsonResponse(200, { departments: [...server] });
        if (options.heldGets?.includes(getCount)) {
          const held = deferred<Response>();
          releases.push(() => held.resolve(response));
          return held.promise;
        }
        return response;
      }
      if (method === 'POST') {
        const apply = () => {
          created += 1;
          server = [...server, department(`dept-new-${created}`, (body as { name: string }).name)];
          return jsonResponse(201, { department: {} });
        };
        return options.postGate ? options.postGate.then(apply) : apply();
      }
      if (method === 'DELETE') {
        const apply = () => {
          const id = url.searchParams.get('id');
          if (!server.some((d) => d.id === id)) return jsonResponse(404, { error: { message: '部署が見つかりません' } });
          server = server.filter((d) => d.id !== id);
          return jsonResponse(200, { success: true });
        };
        return options.deleteGate ? options.deleteGate.then(apply) : apply();
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    return { releaseAll: () => releases.splice(0).forEach((release) => release()) };
  }

  beforeEach(() => {
    server = [department('dept-1', '営業部')];
  });

  it('追加のあとの読み直しを待つ間に削除を押しても送らず、遅れて届いた一覧で消した部署を出し直さない', async () => {
    // 1 本目 = 画面を開いたときの GET、2 本目 = 追加のあとの読み直し (応答を遅らせる)
    const api = mockDepartmentsApi({ heldGets: [2] });
    await renderElement(createElement(OrgDepartmentsPage));

    await click(findButton('+ 部署を追加'), '「+ 部署を追加」ボタン');
    await typeInto(container.querySelector<HTMLInputElement>('form input'), '開発部');
    await submitForm();
    expect(serverNames()).toEqual(['営業部', '開発部']);

    // 読み直しの応答を待つ間は、削除のボタンも止める
    expect(findButton('🗑')!.disabled).toBe(true);
    await click(findButton('🗑'), '営業部の削除ボタン');
    expect(callsOf('DELETE', DEPARTMENTS_PATH)).toHaveLength(0);

    await act(async () => {
      api.releaseAll();
    });
    await settle();

    expect(shownNames()).toEqual(serverNames());
    expect(buttonsLabeled('🗑').every((b) => !b.disabled)).toBe(true);
    expect(container.querySelector('[data-testid="department-error"]')).toBeNull();
  });

  it('削除の応答を待つ間は、追加のボタンを止め、押されても送らない', async () => {
    const del = deferred<void>();
    mockDepartmentsApi({ deleteGate: del.promise });
    await renderElement(createElement(OrgDepartmentsPage));

    await click(findButton('+ 部署を追加'), '「+ 部署を追加」ボタン');
    await typeInto(container.querySelector<HTMLInputElement>('form input'), '開発部');
    await click(findButton('🗑'), '営業部の削除ボタン');

    expect(findButton('追加')!.disabled).toBe(true);
    await submitForm();
    expect(callsOf('POST', DEPARTMENTS_PATH)).toHaveLength(0);

    await act(async () => {
      del.resolve();
    });
    await settle();

    expect(shownNames()).toEqual([]);
    expect(findButton('追加')!.disabled).toBe(false);
    await submitForm();
    expect(callsOf('POST', DEPARTMENTS_PATH)).toHaveLength(1);
    expect(shownNames()).toEqual(['開発部']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 組織の招待
// ─────────────────────────────────────────────────────────────────────────────

describe('組織の招待: 招待の送信と取消を重ねて送らない', () => {
  const INVITES_PATH = '/api/org/invites';
  const INVITE = {
    id: 'inv-1',
    email: 'invitee@example.com',
    role: 'member',
    token: 'tok',
    status: 'pending',
    isExpired: false,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const REVOKE_PATH = `${INVITES_PATH}/${INVITE.id}/revoke`;

  function mockInvitesApi(options: { postGate?: Promise<void>; revokeGate?: Promise<void> } = {}) {
    let revoked = false;
    mockFetch((method, url) => {
      if (method === 'GET' && url.pathname === INVITES_PATH) {
        return jsonResponse(200, { invites: [{ ...INVITE, status: revoked ? 'revoked' : 'pending' }] });
      }
      if (method === 'POST' && url.pathname === INVITES_PATH) {
        const respond = () => jsonResponse(201, { invite: {} });
        return options.postGate ? options.postGate.then(respond) : respond();
      }
      if (method === 'POST' && url.pathname === REVOKE_PATH) {
        const apply = () => {
          revoked = true;
          return jsonResponse(200, { ok: true });
        };
        return options.revokeGate ? options.revokeGate.then(apply) : apply();
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  async function openFormWithEmail() {
    await click(findButton('+ 新しいメンバーを招待'), '「+ 新しいメンバーを招待」ボタン');
    await typeInto(container.querySelector<HTMLInputElement>('input[type="email"]'), 'new@example.com');
  }

  it('招待の送信の応答を待つ間は、取消のボタンを止め、押されても送らない', async () => {
    const post = deferred<void>();
    mockInvitesApi({ postGate: post.promise });
    await renderElement(createElement(OrgInvitesPage));

    await openFormWithEmail();
    await submitForm();
    expect(findButton('取消')!.disabled).toBe(true);
    await click(findButton('取消'), '「取消」ボタン');
    expect(callsOf('POST', REVOKE_PATH)).toHaveLength(0);

    await act(async () => {
      post.resolve();
    });
    await settle();

    expect(findButton('取消')!.disabled).toBe(false);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('取消の応答を待つ間は、招待の送信のボタンを止め、押されても送らない', async () => {
    const revoke = deferred<void>();
    mockInvitesApi({ revokeGate: revoke.promise });
    await renderElement(createElement(OrgInvitesPage));

    await openFormWithEmail();
    await click(findButton('取消'), '「取消」ボタン');
    expect(findButton('招待を送信')!.disabled).toBe(true);
    await submitForm();
    expect(callsOf('POST', INVITES_PATH)).toHaveLength(0);

    await act(async () => {
      revoke.resolve();
    });
    await settle();

    expect(findButton('招待を送信')!.disabled).toBe(false);
    await submitForm();
    expect(callsOf('POST', INVITES_PATH)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 組織のチャレンジ
// ─────────────────────────────────────────────────────────────────────────────

describe('組織のチャレンジ: 作成と開始・終了を重ねて送らない', () => {
  const CHALLENGES_PATH = '/api/org/challenges';
  const CHALLENGE = {
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
  };

  function mockChallengesApi(options: { postGate?: Promise<void>; putGate?: Promise<void> } = {}) {
    let status = CHALLENGE.status;
    mockFetch((method, url) => {
      if (url.pathname !== CHALLENGES_PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
      if (method === 'GET') return jsonResponse(200, { challenges: [{ ...CHALLENGE, status }] });
      if (method === 'POST') {
        const respond = () => jsonResponse(201, { challenge: {} });
        return options.postGate ? options.postGate.then(respond) : respond();
      }
      if (method === 'PUT') {
        const apply = () => {
          status = 'active';
          return jsonResponse(200, { challenge: {} });
        };
        return options.putGate ? options.putGate.then(apply) : apply();
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  it('作成の応答を待つ間は、開始のボタンを止め、押されても送らない', async () => {
    const post = deferred<void>();
    mockChallengesApi({ postGate: post.promise });
    await renderElement(createElement(OrgChallengesAdminPage));

    await click(findButton('+ 新規チャレンジ'), '「+ 新規チャレンジ」ボタン');
    await submitForm();
    expect(callsOf('POST', CHALLENGES_PATH)).toHaveLength(1);
    expect(findButton('開始')!.disabled).toBe(true);
    await click(findButton('開始'), '「開始」ボタン');
    expect(callsOf('PUT', CHALLENGES_PATH)).toHaveLength(0);

    await act(async () => {
      post.resolve();
    });
    await settle();

    expect(findButton('開始')!.disabled).toBe(false);
  });

  it('開始の応答を待つ間は、作成のボタンを止め、押されても送らない', async () => {
    const put = deferred<void>();
    mockChallengesApi({ putGate: put.promise });
    await renderElement(createElement(OrgChallengesAdminPage));

    await click(findButton('+ 新規チャレンジ'), '「+ 新規チャレンジ」ボタン');
    await click(findButton('開始'), '「開始」ボタン');
    expect(findButton('作成')!.disabled).toBe(true);
    await submitForm();
    expect(callsOf('POST', CHALLENGES_PATH)).toHaveLength(0);

    await act(async () => {
      put.resolve();
    });
    await settle();

    expect(findButton('終了')).toBeDefined();
    expect(findButton('作成')!.disabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 組織のメンバー
// ─────────────────────────────────────────────────────────────────────────────

describe('組織のメンバー: 除名の応答を待つ間は、ほかのメンバーの除名も止める', () => {
  it('1 人目の除名の応答を待つ間に 2 人目の「除名」を押しても送らない', async () => {
    const remove = deferred<Response>();
    mockFetch((method, url) => {
      if (method === 'POST' && url.pathname === `/api/org/members/${MEMBER_A_ID}/remove`) return remove.promise;
      if (method === 'POST' && url.pathname === `/api/org/members/${MEMBER_B_ID}/remove`) return jsonResponse(200, { ok: true });
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
    supabaseState.profile = { data: { org_role: 'owner', organization_id: 'org-1' }, error: null };
    supabaseState.members = {
      data: [
        { id: USER_ID, nickname: 'オーナーさん', org_role: 'owner', joined_org_at: '2026-10-01T03:00:00.000Z' },
        { id: MEMBER_A_ID, nickname: 'Aさん', org_role: 'member', joined_org_at: '2026-10-02T03:00:00.000Z' },
        { id: MEMBER_B_ID, nickname: 'Bさん', org_role: 'member', joined_org_at: '2026-10-03T03:00:00.000Z' },
      ],
      error: null,
    };
    await renderElement(createElement(MembersPage));

    expect(buttonsLabeled('除名')).toHaveLength(2);
    await click(buttonsLabeled('除名')[0], 'Aさんの「除名」ボタン');
    const bButton = buttonsLabeled('除名')[0];
    expect(bButton.disabled).toBe(true);
    await click(bButton, 'Bさんの「除名」ボタン');
    expect(callsOf('POST', `/api/org/members/${MEMBER_B_ID}/remove`)).toHaveLength(0);

    supabaseState.members = {
      data: [
        { id: USER_ID, nickname: 'オーナーさん', org_role: 'owner', joined_org_at: '2026-10-01T03:00:00.000Z' },
        { id: MEMBER_B_ID, nickname: 'Bさん', org_role: 'member', joined_org_at: '2026-10-03T03:00:00.000Z' },
      ],
      error: null,
    };
    await act(async () => {
      remove.resolve(jsonResponse(200, { ok: true }));
    });
    await settle();

    expect(buttonsLabeled('除名')).toHaveLength(1);
    expect(buttonsLabeled('除名')[0].disabled).toBe(false);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// サポートのチケットの詳細
// ─────────────────────────────────────────────────────────────────────────────

describe('サポートのチケットの詳細: 返信・担当者の設定・ステータスの変更を重ねて送らない', () => {
  const TICKET_ID = '77777777-7777-4777-8777-777777777777';
  const TICKET_PATH = `/api/admin/support/tickets/${TICKET_ID}`;
  const TICKET = {
    id: TICKET_ID,
    user_id: USER_ID,
    subject: 'ログインできません',
    category: 'account',
    priority: 'medium',
    status: 'open',
    assignee_id: null,
    first_response_at: null,
    resolved_at: null,
    created_at: '2026-10-01T03:00:00.000Z',
    updated_at: '2026-10-01T03:00:00.000Z',
    messages: [],
  };

  function mockTicketApi(options: { patchGate?: Promise<void>; messageGate?: Promise<void> } = {}) {
    let status = TICKET.status;
    mockFetch((method, url, body) => {
      if (method === 'GET' && url.pathname === TICKET_PATH) return jsonResponse(200, { data: { ...TICKET, status } });
      if (method === 'PATCH' && url.pathname === TICKET_PATH) {
        const apply = () => {
          status = (body as { status: string }).status;
          return jsonResponse(200, { data: {} });
        };
        return options.patchGate ? options.patchGate.then(apply) : apply();
      }
      if (method === 'POST' && url.pathname === `${TICKET_PATH}/messages`) {
        const respond = () => jsonResponse(201, { data: {} });
        return options.messageGate ? options.messageGate.then(respond) : respond();
      }
      if (method === 'POST' && url.pathname === `${TICKET_PATH}/assign`) return jsonResponse(200, { data: {} });
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  async function renderTicket() {
    await renderElement(createElement(TicketDetailPage, { params: fulfilledParams(TICKET_ID) }));
    await typeInto(container.querySelector('textarea'), '確認しています');
    await typeInto(container.querySelector<HTMLInputElement>('input[placeholder="ユーザー UUID"]'), USER_ID);
  }

  it('ステータスの変更の応答を待つ間は、返信と担当者の設定のボタンを止め、押されても送らない', async () => {
    const patch = deferred<void>();
    mockTicketApi({ patchGate: patch.promise });
    await renderTicket();

    await click(findButton('対応中'), '「対応中」ボタン');
    expect(findButton('返信を送信')!.disabled).toBe(true);
    expect(findButton('担当者を設定')!.disabled).toBe(true);
    expect(findButton('保留')!.disabled).toBe(true);
    await click(findButton('返信を送信'), '「返信を送信」ボタン');
    await click(findButton('担当者を設定'), '「担当者を設定」ボタン');
    await click(findButton('保留'), '「保留」ボタン');
    expect(callsOf('POST', `${TICKET_PATH}/messages`)).toHaveLength(0);
    expect(callsOf('POST', `${TICKET_PATH}/assign`)).toHaveLength(0);
    expect(callsOf('PATCH', TICKET_PATH)).toHaveLength(1);

    await act(async () => {
      patch.resolve();
    });
    await settle();

    expect(findButton('返信を送信')!.disabled).toBe(false);
    expect(findButton('保留')!.disabled).toBe(false);
  });

  it('返信の応答を待つ間は、ステータスの変更のボタンを止め、押されても送らない', async () => {
    const message = deferred<void>();
    mockTicketApi({ messageGate: message.promise });
    await renderTicket();

    await click(findButton('返信を送信'), '「返信を送信」ボタン');
    expect(findButton('対応中')!.disabled).toBe(true);
    expect(findButton('担当者を設定')!.disabled).toBe(true);
    await click(findButton('対応中'), '「対応中」ボタン');
    expect(callsOf('PATCH', TICKET_PATH)).toHaveLength(0);

    await act(async () => {
      message.resolve();
    });
    await settle();

    expect(findButton('対応中')!.disabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 営業のリードの詳細
// ─────────────────────────────────────────────────────────────────────────────

describe('営業のリードの詳細: 活動の記録とステージの変更を重ねて送らない', () => {
  const LEAD_ID = '11111111-2222-4333-8444-555555555555';
  const LEAD_PATH = `/api/admin/sales/leads/${LEAD_ID}`;
  const LEAD = {
    id: LEAD_ID,
    company_name: '株式会社テスト',
    industry: null,
    employee_count: null,
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    source: null,
    stage: 'approach',
    assigned_to: null,
    estimated_acv: null,
    notes: null,
    converted_org_id: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    activities: [],
  };

  function mockLeadApi(options: { patchGate?: Promise<void>; activityGate?: Promise<void> } = {}) {
    let stage = LEAD.stage;
    mockFetch((method, url, body) => {
      if (method === 'GET' && url.pathname === LEAD_PATH) return jsonResponse(200, { data: { ...LEAD, stage } });
      if (method === 'PATCH' && url.pathname === LEAD_PATH) {
        const apply = () => {
          stage = (body as { stage: string }).stage;
          return jsonResponse(200, { data: {} });
        };
        return options.patchGate ? options.patchGate.then(apply) : apply();
      }
      if (method === 'POST' && url.pathname === `${LEAD_PATH}/activities`) {
        const respond = () => jsonResponse(201, { data: {} });
        return options.activityGate ? options.activityGate.then(respond) : respond();
      }
      throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    });
  }

  /** ステージ変更の欄のボタン */
  function stageButton(label: string): HTMLButtonElement | undefined {
    const section = Array.from(container.querySelectorAll('h2')).find((h) => h.textContent === 'ステージ変更')?.parentElement;
    return Array.from(section?.querySelectorAll('button') ?? []).find((b) => b.textContent === label);
  }

  async function renderLead() {
    await renderElement(createElement(LeadDetailPage, { params: fulfilledParams(LEAD_ID) }));
    await typeInto(container.querySelector('textarea'), '電話で状況を確認した');
  }

  it('ステージの変更の応答を待つ間は、活動の記録のボタンを止め、押されても送らない', async () => {
    const patch = deferred<void>();
    mockLeadApi({ patchGate: patch.promise });
    await renderLead();

    await click(stageButton('商談中'), '「商談中」ボタン');
    expect(findButton('活動を記録')!.disabled).toBe(true);
    await click(findButton('活動を記録'), '「活動を記録」ボタン');
    expect(callsOf('POST', `${LEAD_PATH}/activities`)).toHaveLength(0);

    await act(async () => {
      patch.resolve();
    });
    await settle();

    expect(findButton('活動を記録')!.disabled).toBe(false);
  });

  it('活動の記録の応答を待つ間は、ステージの変更のボタンを止め、押されても送らない', async () => {
    const activity = deferred<void>();
    mockLeadApi({ activityGate: activity.promise });
    await renderLead();

    await click(findButton('活動を記録'), '「活動を記録」ボタン');
    expect(stageButton('商談中')!.disabled).toBe(true);
    await click(stageButton('商談中'), '「商談中」ボタン');
    expect(callsOf('PATCH', LEAD_PATH)).toHaveLength(0);

    await act(async () => {
      activity.resolve();
    });
    await settle();

    expect(stageButton('商談中')!.disabled).toBe(false);
  });
});
