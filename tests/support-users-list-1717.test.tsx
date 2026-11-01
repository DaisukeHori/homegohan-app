/**
 * #1717 サポートの利用者一覧 (/support/users) が GET /api/admin/users の応答を読めること
 *
 * 以前の画面は、応答に無い包み (data.users) と camelCase の鍵 (lastLoginAt・isBanned) で読んでいた。
 * 応答は { data: [...], meta } で鍵は snake_case (last_login_at・is_banned) なので、一覧は出ず、
 * 最終ログインや凍結の印もいつも空だった。修正後は route と画面が同じスキーマ (UsersListResponseSchema) を使う。
 *
 * ここでは route (src/app/api/admin/users/route.ts) の GET を実際に呼んで作った応答を、そのまま画面の fetch に返す
 * (route の形と画面の読み方がずれたら、このテストが落ちる)。Supabase と認可はモック。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/support-inquiries-page.test.tsx と同じ)。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// モック
// ─────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  results: {} as Record<string, unknown>,
}));

/** PostgrestFilterBuilder 相当: どのメソッドでも自分自身を返し、await すると results[key] で解決する */
function makeBuilder(key: string) {
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => unknown) =>
            resolve(mocks.results[key] ?? { data: null, error: null, count: 0 });
        }
        return () => builder;
      },
    },
  );
  return builder;
}

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: mocks.requireRole,
}));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => makeBuilder(table),
    rpc: mocks.rpc,
  }),
  // 監査ログ (admin.user.list) の記録に使う本人のセッションの client
  createClient: () => ({
    from: (table: string) => makeBuilder(`session:${table}`),
  }),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
  generateRequestId: () => 'req_test',
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

// アニメーションは本題ではないので、motion.* は同じタグの素の要素、AnimatePresence は子をそのまま返す
vi.mock('framer-motion', () => {
  const MOTION_ONLY_PROPS = ['initial', 'animate', 'exit'];
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

const { GET: listGET } = await import('@/app/api/admin/users/route');
const { AuthError } = await import('@/lib/auth/errors');
const { UNAUTHENTICATED_SCREEN_MESSAGE } = await import('@/lib/admin/api-error-message');
const { UsersListResponseSchema } = await import('@/lib/admin/users-schemas');
const { default: SupportUsersPage } = await import('@/app/(support)/support/users/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ
// ─────────────────────────────────────────────────────────────────────────────

const FROZEN_ID = '11111111-1111-4111-8111-111111111111';
const ACTIVE_ID = '22222222-2222-4222-8222-222222222222';

// 日付は UTC と JST で同じ暦日になる時刻 (UTC 03:00 = JST 12:00) にする (TZ に左右されない)
const FROZEN_LAST_LOGIN = '2026-10-05T03:00:00.000Z';
const FROZEN_REGISTERED = '2026-01-02T03:00:00.000Z';
const ACTIVE_REGISTERED = '2026-03-04T03:00:00.000Z';

/** user_profiles の 1 行 (route が select する列) */
function profileRow(overrides: Record<string, unknown>) {
  return {
    id: ACTIVE_ID,
    nickname: 'ユーザー',
    roles: ['user'],
    organization_id: null,
    plan_key_cached: null,
    last_login_at: null,
    created_at: ACTIVE_REGISTERED,
    frozen_at: null,
    frozen_reason: null,
    frozen_by: null,
    unban_at: null,
    ...overrides,
  };
}

const ROWS = [
  // 無期限で凍結中 (unban_at が無い) → is_banned: true
  profileRow({
    id: FROZEN_ID,
    nickname: '凍結さん',
    last_login_at: FROZEN_LAST_LOGIN,
    created_at: FROZEN_REGISTERED,
    frozen_at: '2026-10-06T03:00:00.000Z',
    frozen_reason: 'spam',
  }),
  // 凍結されていない・一度もログインしていない
  profileRow({ id: ACTIVE_ID, nickname: '通常さん' }),
];

// ─────────────────────────────────────────────────────────────────────────────
// 道具
// ─────────────────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

/** route の GET を実際に呼んで、一覧の応答 (JSON の本文) を作る */
async function routeListBody(): Promise<unknown> {
  const res = await listGET(new Request('http://localhost/api/admin/users?per_page=50'));
  expect(res.status).toBe(200);
  return res.json();
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** GET /api/admin/users にだけ応える。想定外の呼び出しはテストを失敗させる */
function mockListApi(respond: () => Response | Promise<Response>) {
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.pathname === '/api/admin/users' && method === 'GET') return respond();
    throw new Error(`想定していない fetch: ${method} ${input}`);
  });
}

async function renderPage() {
  await act(async () => {
    root.render(createElement(SupportUsersPage));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 一覧の行 (クリックで詳細パネルが開く) */
function findRow(name: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('div.cursor-pointer')).find((el) => el.textContent?.includes(name));
}

const alerts = () => Array.from(container.querySelectorAll('[role="alert"]')).map((el) => el.textContent ?? '');

beforeEach(() => {
  mocks.results = { user_profiles: { data: ROWS, error: null, count: ROWS.length } };
  // support はメールを引かない (RPC を呼ばない)。一覧の形は admin と同じ
  mocks.requireRole.mockResolvedValue({ id: 'support-id', email: 'support@example.com', roles: ['support'], organization_id: null });
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
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
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// テスト
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/users の応答の形 (#1717)', () => {
  it('route の応答は UsersListResponseSchema に合う (鍵は snake_case・包みは data)', async () => {
    const body = await routeListBody();
    const parsed = UsersListResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const frozen = parsed.data.data.find((u) => u.id === FROZEN_ID);
    expect(frozen).toMatchObject({ is_banned: true, last_login_at: FROZEN_LAST_LOGIN, registered_at: FROZEN_REGISTERED });
    const active = parsed.data.data.find((u) => u.id === ACTIVE_ID);
    expect(active).toMatchObject({ is_banned: false, last_login_at: null, registered_at: ACTIVE_REGISTERED });
  });
});

describe('/support/users の一覧 (#1717)', () => {
  it('route が返した最終ログイン・凍結の印・登録日が一覧の行に出る', async () => {
    const body = await routeListBody();
    mockListApi(() => jsonResponse(200, body));
    await renderPage();

    const frozenRow = findRow('凍結さん');
    expect(frozenRow, '凍結中のユーザーの行').toBeDefined();
    expect(frozenRow!.textContent).toContain('最終ログイン: 2026/10/5');
    expect(frozenRow!.textContent).toContain('登録日: 2026/1/2');
    expect(frozenRow!.textContent).toContain('凍結中');
    // 凍結の印は日本語で出す (英字の BAN は出さない。#2166 X3)。個人情報の請求の種類の語「利用停止」も使わない (#2178 Y2)
    expect(frozenRow!.textContent).not.toContain('BAN');
    expect(frozenRow!.textContent).not.toContain('利用停止');

    const activeRow = findRow('通常さん');
    expect(activeRow, '凍結されていないユーザーの行').toBeDefined();
    expect(activeRow!.textContent).toContain('最終ログイン: -');
    expect(activeRow!.textContent).toContain('登録日: 2026/3/4');
    expect(activeRow!.textContent).not.toContain('凍結中');

    expect(container.textContent).not.toContain('ユーザーが見つかりません');
    expect(alerts()).toEqual([]);
  });

  it('凍結中の利用者の詳細パネルは「このユーザーは凍結中です」と理由を出す (英字の BAN・請求の種類の語「利用停止」は出さない。#2178 Y2)', async () => {
    const body = await routeListBody();
    const detail = {
      user: {
        id: FROZEN_ID,
        nickname: '凍結さん',
        ageGroup: '30s',
        gender: 'female',
        roles: ['user'],
        organizationId: null,
        isBanned: true,
        bannedAt: '2026-10-06T03:00:00.000Z',
        bannedReason: 'spam',
        lastLoginAt: FROZEN_LAST_LOGIN,
        loginCount: 1,
        profileCompleteness: 0,
        createdAt: FROZEN_REGISTERED,
      },
      stats: { mealCount: 0, aiSessionCount: 0 },
      inquiries: [],
      notes: [],
    };
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.pathname === '/api/admin/users' && method === 'GET') return jsonResponse(200, body);
      if (url.pathname === `/api/support/users/${FROZEN_ID}` && method === 'GET') return jsonResponse(200, detail);
      throw new Error(`想定していない fetch: ${method} ${input}`);
    });
    await renderPage();

    const frozenRow = findRow('凍結さん');
    expect(frozenRow, '凍結中のユーザーの行').toBeDefined();
    await act(async () => {
      frozenRow!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const notice = Array.from(container.querySelectorAll('p')).find((p) => p.textContent === 'このユーザーは凍結中です');
    expect(notice, '詳細パネルの凍結の文').toBeDefined();
    const panel = notice!.parentElement!;
    expect(panel.textContent).toContain('spam');
    expect(panel.textContent).not.toContain('BAN');
    expect(panel.textContent).not.toContain('利用停止');
  });

  it('一覧は per_page で 50 件を頼む (API が読まない limit は送らない)', async () => {
    const body = await routeListBody();
    mockListApi(() => jsonResponse(200, body));
    await renderPage();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const params = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost').searchParams;
    expect(params.get('per_page')).toBe('50');
    expect(params.has('limit')).toBe(false);
  });

  it('取得に失敗したら「ユーザーが見つかりません」ではなくエラーを出す', async () => {
    mockListApi(() => jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'データベースエラーが発生しました' } }));
    await renderPage();

    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('ユーザー一覧を取得できませんでした');
    expect(container.textContent).not.toContain('ユーザーが見つかりません');
  });

  it('応答が想定の形でない (以前の画面が期待した users の包み・camelCase の鍵) ときは、壊れずにエラーを出す', async () => {
    mockListApi(() =>
      jsonResponse(200, {
        users: [{ id: FROZEN_ID, nickname: '凍結さん', isBanned: true, lastLoginAt: FROZEN_LAST_LOGIN }],
      }),
    );
    await renderPage();

    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('ユーザー一覧を取得できませんでした');
    expect(findRow('凍結さん')).toBeUndefined();
  });

  // #2112 Z4: 一覧の読み込みの 401 は、時間をおいても読めないので「しばらくしてから、もう一度お試しください」にせず、
  // 同じ画面の詳細の読み込み・メモの追加の 401 (operationFailureMessage) と同じ「ログインし直してください」を出す
  it('一覧の読み込みが 401 (ログインが切れた) なら、「しばらくしてから」ではなく「ログインし直してください」を出す (本文の「認証が必要です」も出さない)', async () => {
    // route の 401 の応答そのもの (requireRole が AuthError を投げたとき) を画面に返す
    mocks.requireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));
    const res = await listGET(new Request('http://localhost/api/admin/users?per_page=50'));
    expect(res.status).toBe(401);
    const body: unknown = await res.json();
    expect(body).toEqual({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } });
    mockListApi(() => jsonResponse(401, body));
    await renderPage();

    expect(alerts()).toEqual([UNAUTHENTICATED_SCREEN_MESSAGE]);
    expect(UNAUTHENTICATED_SCREEN_MESSAGE).toBe('ログインし直してください');
    expect(container.textContent).not.toContain('しばらくしてから');
    expect(container.textContent).not.toContain('認証が必要です');
    expect(container.textContent).not.toContain('ユーザーが見つかりません');
  });
});
