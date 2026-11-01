/**
 * #2112 Z3 のテスト: 運営の画面が、状態・区分の英字の内部の値をそのまま出さず、日本語の表示名で出すこと
 *
 * 以前:
 *  - Z3-1: 運営の利用者の一覧 (/admin/users) のステータスの列が「active」「BAN」と英字の直書きだった
 *    (同じ画面の絞り込みの select は「アクティブ」「凍結中」。#2178 Y2 で「BAN 済み」から「凍結」の系に揃えた)。
 *  - Z3-2 (同じ型): 問い合わせの詳細の優先度・カテゴリ (一覧では日本語)・一覧のカテゴリ、サポートの利用者の画面の問い合わせの状態、
 *    リードの流入経路、利用者の詳細の契約の状態・監査ログの重要度、監査ログの画面とバックアップの画面の重要度、フラグの公開の範囲の種類、
 *    クーポンの適用対象、利用者の一覧・詳細・NPS のプラン (plan_key。空は free) が英字の内部の値のままだった。
 *  - 同じ型の取りこぼし (R1 のレビュー): 請求書の詳細の処理の状態の札 (completed など)、利用者の詳細の「手動のプラン付与」の今のプラン・履歴・
 *    付与と取り消しの成功の文 (plan_key)、クーポン詳細の適用履歴の「対象」(personal / org) も英字の内部の値のままだった。
 *
 * 直したあと: 値の一覧と同じ場所の表 (Record<値, string>) の表示名で出す。表に無い値はそのまま出す (知らない値を隠さない)。
 * assert は画面に出た文字 (葉の要素の文字・選択肢の文字) を見る。
 *
 * サーバーの画面 (async の Server Component) は renderToStaticMarkup で、クライアントの画面は react-dom/client + act で描く
 * (tests/admin-users-status-select-2107.test.tsx・tests/admin-list-polish-2107.test.tsx と同じ形)。
 */
import { act, createElement, Suspense, type ComponentType, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireRoleForPage = vi.hoisted(() => vi.fn());
const adminFetch = vi.hoisted(() => vi.fn());
// 描画のたびに同じ router を返す (画面の useCallback が router に依存するので、毎回別の値を返すと読み込みが止まらない)
const nav = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  searchParams: new URLSearchParams(),
  params: {} as Record<string, string>,
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useRouter: () => nav.router,
  usePathname: () => '/admin',
  useSearchParams: () => nav.searchParams,
  useParams: () => nav.params,
}));
vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));
vi.mock('@/lib/auth/page-guard', () => ({ requireRoleForPage }));
vi.mock('@/lib/admin/fetch', () => ({ adminFetch }));
// アニメーションは本題ではないので、motion.* は同じタグの素の要素、AnimatePresence は子をそのまま返す (tests/support-users-list-1717.test.tsx と同じ)
vi.mock('framer-motion', () => {
  const MOTION_ONLY_PROPS = ['initial', 'animate', 'exit', 'transition', 'whileHover', 'whileTap', 'layout'];
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

const { USER_LIST_STATUS_LABELS } = await import('@/lib/admin/users-schemas');
const { TICKET_CATEGORY_LABELS, TICKET_PRIORITY_LABELS, TICKET_STATUS_LABELS } = await import('@/lib/admin/support-schemas');
const { INQUIRY_STATUS_LABELS } = await import('@/lib/admin/inquiry-labels');
const { LEAD_SOURCE_LABELS } = await import('@/lib/admin/sales-schemas');
const { ADMIN_PLAN_KEY_LABELS } = await import('@/lib/admin/plan-key-labels');
const { ADMIN_SUBSCRIPTION_STATUS_LABELS } = await import('@/lib/admin/subscription-status-labels');
const { ADMIN_AUDIT_SEVERITIES, ADMIN_AUDIT_SEVERITY_LABELS } = await import('@/lib/admin/audit-severity-labels');
const { ROLLOUT_STRATEGY_TYPE_LABELS } = await import('@/lib/super-admin/flags-schemas');
const { COUPON_APPLICABLE_TO_LABELS, COUPON_SUBSCRIPTION_TARGETS, COUPON_SUBSCRIPTION_TARGET_LABELS } = await import(
  '@/lib/super-admin/coupons-schemas'
);
const { INVOICE_PROCESSING_STATUSES } = await import('@/lib/admin/finance-schemas');
const { INVOICE_PROCESSING_STATUS_LABELS } = await import('@/lib/admin/invoice-processing-status-labels');
const { default: AdminUsersPage } = await import('@/app/admin/users/page');
const { default: AdminUserDetailPage } = await import('@/app/admin/users/[id]/page');

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HTTP_OK = 200;
const adminActor = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roles: ['admin'], email: 'admin@example.com' };
const superAdminActor = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', roles: ['super_admin'], email: 'sa@example.com' };
const ROW_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';
/** 表に無い値 (将来の値・壊れた応答)。表示名が無いのでそのまま出す */
const UNKNOWN_VALUE = 'brand_new_value';

/** adminFetch (サーバーの画面) の応答の形 */
function adminJson(body: unknown, status = HTTP_OK) {
  return { ok: status >= HTTP_OK && status < 300, status, json: () => Promise.resolve(body) };
}

/** fetch (クライアントの画面) の応答 */
function fetchJson(body: unknown, status = HTTP_OK) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 子の要素を持たない要素 (札・セル・選択肢) の文字の一覧 */
function leafTexts(host: ParentNode): string[] {
  return Array.from(host.querySelectorAll('*'))
    .filter((el) => el.children.length === 0)
    .map((el) => el.textContent?.trim() ?? '')
    .filter((text) => text !== '');
}

/** select の選択肢の文字 (value が空の「すべて」を除く) */
function optionTexts(select: HTMLSelectElement | null): string[] {
  if (!select) throw new Error('select がありません');
  return Array.from(select.options)
    .filter((option) => option.value !== '')
    .map((option) => option.textContent?.trim() ?? '');
}

async function renderServer(element: ReactElement | Promise<ReactElement>): Promise<HTMLDivElement> {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(await element);
  document.body.appendChild(host);
  return host;
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  // 応答の本文の読み込み (Response.json) をまたぐ読み込みの連鎖が終わるまで回す
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderClient(element: ReactElement) {
  await act(async () => {
    root.render(createElement(Suspense, { fallback: null }, element));
  });
  await flush();
}

/** パスごとに応答を返す fetch の偽物を置く (知らないパスはテストの誤りとして投げる) */
function routeFetch(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = new URL(String(input), 'http://localhost');
    const route = routes[url.pathname];
    if (!route) throw new Error(`想定外の呼び出し: ${url.pathname}`);
    return route();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  nav.searchParams = new URLSearchParams();
  nav.params = {};
  requireRoleForPage.mockResolvedValue(adminActor);
  // メッセージの一覧の末尾へのスクロール (テストの DOM には無いので、何もしない関数を置く)
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// ─── 利用者の一覧 (/admin/users) ───────────────────────────────────────────────

describe('#2112 Z3-1 運営の利用者の一覧 (/admin/users) のステータスとプランの列', () => {
  const USERS_PER_PAGE = 50;

  function userRow(n: number, overrides: Record<string, unknown>) {
    return {
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      email: null,
      nickname: `利用者${n}`,
      roles: ['user'],
      plan_key: null,
      is_banned: false,
      frozen_at: null,
      frozen_reason: null,
      frozen_by: null,
      unban_at: null,
      last_login_at: null,
      registered_at: '2026-01-01T00:00:00+00:00',
      meal_count: 0,
      organization_id: null,
      ...overrides,
    };
  }

  async function renderUsers(rows: unknown[]) {
    adminFetch.mockResolvedValue(adminJson({ data: rows, meta: { total: rows.length, page: 1, per_page: USERS_PER_PAGE } }));
    return renderServer(AdminUsersPage({ searchParams: Promise.resolve({ status: '' }) }));
  }

  it('凍結中の行は「凍結中」、それ以外は「アクティブ」(英字の active / BAN を出さない。#2178 Y2)', async () => {
    const page = await renderUsers([userRow(1, { is_banned: true }), userRow(2, {})]);
    const body = page.querySelector('tbody');
    if (!body) throw new Error('一覧の表がありません');
    const texts = leafTexts(body);
    expect(texts).toContain(USER_LIST_STATUS_LABELS.banned);
    expect(texts).toContain(USER_LIST_STATUS_LABELS.active);
    expect(texts).toContain('凍結中');
    expect(texts).toContain('アクティブ');
    expect(texts).not.toContain('active');
    expect(texts).not.toContain('BAN');
  });

  it('プランの列は表示名 (空は無料プラン)。表に無い plan_key はそのまま出す', async () => {
    const page = await renderUsers([
      userRow(1, { plan_key: null }),
      userRow(2, { plan_key: 'family_basic' }),
      userRow(3, { plan_key: UNKNOWN_VALUE }),
    ]);
    const body = page.querySelector('tbody');
    if (!body) throw new Error('一覧の表がありません');
    const texts = leafTexts(body);
    expect(texts).toContain('無料プラン');
    expect(texts).toContain(ADMIN_PLAN_KEY_LABELS.family_basic);
    expect(texts).toContain('家族 Basic');
    expect(texts).toContain(UNKNOWN_VALUE);
    expect(texts).not.toContain('free');
    expect(texts).not.toContain('family_basic');
  });
});

// ─── 利用者の詳細 (/admin/users/{id}) ─────────────────────────────────────────

describe('#2112 Z3-2 運営の利用者の詳細 (/admin/users/{id}) のプラン・契約の状態・監査ログの重要度', () => {
  function routeDetail(profile: Record<string, unknown>) {
    adminFetch.mockImplementation(async (path: string) => {
      if (path === `/api/admin/users/${ROW_ID}`) return adminJson({ data: profile });
      if (path === `/api/admin/users/${ROW_ID}/login-history`) return adminJson({ data: { entries: [] } });
      throw new Error(`想定外の adminFetch(${path})`);
    });
  }

  const baseProfile = {
    id: ROW_ID,
    email: 'target@example.com',
    nickname: '対象さん',
    roles: ['user'],
    plan_key: 'pro',
    is_banned: false,
    frozen_at: null,
    frozen_reason: null,
    last_login_at: null,
    registered_at: '2026-01-01T00:00:00+00:00',
    active_subscription: { plan_key: 'family_pro', status: 'past_due', next_billing_at: null },
    ban_history: [
      { id: 'log-1', action_type: 'admin.user.ban', created_at: '2026-10-01T00:00:00Z', severity: 'warn', details: {} },
      { id: 'log-2', action_type: 'admin.user.unban', created_at: '2026-10-02T00:00:00Z', severity: 'critical', details: {} },
    ],
  };

  it('プラン・現在のサブスクリプションのプランと状態・監査ログの重要度を表示名で出す (英字の内部の値を出さない)', async () => {
    requireRoleForPage.mockResolvedValue(superAdminActor);
    routeDetail(baseProfile);
    const page = await renderServer(AdminUserDetailPage({ params: Promise.resolve({ id: ROW_ID }) }));
    const texts = leafTexts(page);
    expect(texts).toContain(ADMIN_PLAN_KEY_LABELS.pro);
    expect(texts).toContain('個人 Pro');
    expect(texts).toContain(ADMIN_PLAN_KEY_LABELS.family_pro);
    expect(texts).toContain(ADMIN_SUBSCRIPTION_STATUS_LABELS.past_due);
    expect(texts).toContain('支払い遅延');
    expect(texts).toContain(ADMIN_AUDIT_SEVERITY_LABELS.warn);
    expect(texts).toContain('警告');
    expect(texts).toContain(ADMIN_AUDIT_SEVERITY_LABELS.critical);
    for (const raw of ['pro', 'family_pro', 'past_due', 'warn', 'critical']) {
      expect(texts).not.toContain(raw);
    }
    // 監査ログの操作 (action_type) は識別子として code の字体のまま出す (変えない)
    expect(texts).toContain('admin.user.ban');
  });

  it('plan_key が空なら無料プラン、表に無い契約の状態はそのまま出す', async () => {
    routeDetail({
      ...baseProfile,
      plan_key: null,
      active_subscription: { plan_key: 'pro', status: UNKNOWN_VALUE, next_billing_at: null },
    });
    const page = await renderServer(AdminUserDetailPage({ params: Promise.resolve({ id: ROW_ID }) }));
    const texts = leafTexts(page);
    expect(texts).toContain('無料プラン');
    expect(texts).not.toContain('free');
    expect(texts).toContain(UNKNOWN_VALUE);
  });
});

// ─── 問い合わせ (/admin/support・/admin/support/{id}・/admin/support/new) ───────

describe('#2112 Z3-2 問い合わせの一覧・詳細・作成のカテゴリ・優先度・状態', () => {
  const TICKETS_PATH = '/api/admin/support/tickets';
  const PER_PAGE = 50;

  function ticket(overrides: Record<string, unknown>) {
    return {
      id: ROW_ID,
      user_id: OTHER_ID,
      subject: 'ラベルの確かめの件名',
      category: 'billing',
      priority: 'high',
      status: 'pending',
      assignee_id: null,
      first_response_at: null,
      resolved_at: null,
      created_at: '2026-10-29T00:00:00.000Z',
      updated_at: '2026-10-29T00:00:00.000Z',
      messages: [],
      ...overrides,
    };
  }

  it('一覧: カテゴリ・優先度・状態の列は表示名 (以前はカテゴリが billing のままだった)。優先度の絞り込みの選択肢も表示名', async () => {
    routeFetch({
      [TICKETS_PATH]: () =>
        fetchJson({
          data: [ticket({}), ticket({ id: OTHER_ID, category: UNKNOWN_VALUE })],
          meta: { total: 2, page: 1, per_page: PER_PAGE },
        }),
    });
    const { default: SupportTicketsPage } = await import('@/app/admin/support/page');
    await renderClient(createElement(SupportTicketsPage as ComponentType));
    const body = container.querySelector('tbody');
    if (!body) throw new Error('チケットの表がありません');
    const texts = leafTexts(body);
    expect(texts).toContain(TICKET_CATEGORY_LABELS.billing);
    expect(texts).toContain('課金');
    expect(texts).toContain(TICKET_PRIORITY_LABELS.high);
    expect(texts).toContain(TICKET_STATUS_LABELS.pending);
    expect(texts).toContain(UNKNOWN_VALUE);
    for (const raw of ['billing', 'high', 'pending']) expect(texts).not.toContain(raw);
    expect(optionTexts(container.querySelector<HTMLSelectElement>('#priority-filter'))).toEqual(['緊急', '高', '中', '低']);
  });

  it('詳細: カテゴリ・優先度・状態は一覧と同じ表示名 (以前は優先度 urgent・カテゴリ bug のままだった)', async () => {
    routeFetch({
      [`${TICKETS_PATH}/${ROW_ID}`]: () => fetchJson({ data: ticket({ category: 'bug', priority: 'urgent', status: 'resolved' }) }),
    });
    const { default: TicketDetailPage } = await import('@/app/admin/support/[id]/page');
    await renderClient(createElement(TicketDetailPage, { params: Promise.resolve({ id: ROW_ID }) }));
    const texts = leafTexts(container);
    expect(texts).toContain(TICKET_CATEGORY_LABELS.bug);
    expect(texts).toContain('バグ');
    expect(texts).toContain(TICKET_PRIORITY_LABELS.urgent);
    expect(texts).toContain('緊急');
    expect(texts).toContain(TICKET_STATUS_LABELS.resolved);
    for (const raw of ['bug', 'urgent', 'resolved']) expect(texts).not.toContain(raw);
  });

  it('作成: カテゴリ・優先度の選択肢は値の一覧の順の表示名', async () => {
    const { default: NewTicketPage } = await import('@/app/admin/support/new/page');
    await renderClient(createElement(NewTicketPage as ComponentType));
    expect(optionTexts(container.querySelector<HTMLSelectElement>('#category'))).toEqual([
      'アカウント',
      '課金',
      '機能リクエスト',
      'バグ',
      'その他',
    ]);
    expect(optionTexts(container.querySelector<HTMLSelectElement>('#priority'))).toEqual(['低', '中', '高', '緊急']);
  });
});

// ─── サポートの利用者の画面の問い合わせの履歴 (/support/users) ───────────────────

describe('#2112 Z3-2 サポートの利用者の画面 (/support/users) の問い合わせの履歴の状態', () => {
  it('問い合わせの状態は表示名 (以前は in_progress のまま)。表に無い値はそのまま出す', async () => {
    nav.searchParams = new URLSearchParams({ id: ROW_ID });
    routeFetch({
      '/api/admin/users': () => fetchJson({ data: [], meta: { total: 0, page: 1, per_page: 50 } }),
      [`/api/support/users/${ROW_ID}`]: () =>
        fetchJson({
          user: {
            id: ROW_ID,
            nickname: '対象さん',
            ageGroup: '30代',
            gender: '未回答',
            roles: ['user'],
            organizationId: null,
            isBanned: false,
            bannedAt: null,
            bannedReason: null,
            lastLoginAt: null,
            loginCount: 0,
            profileCompleteness: 0,
            createdAt: '2026-01-01T00:00:00Z',
          },
          stats: { mealCount: 0, aiSessionCount: 0 },
          inquiries: [
            { id: 'inq-1', inquiry_type: 'support', subject: '件名その 1', status: 'in_progress', created_at: '2026-10-01T03:00:00Z' },
            { id: 'inq-2', inquiry_type: 'support', subject: '件名その 2', status: UNKNOWN_VALUE, created_at: '2026-10-01T03:00:00Z' },
          ],
          notes: [],
        }),
    });
    const { default: SupportUsersPage } = await import('@/app/(support)/support/users/page');
    await renderClient(createElement(SupportUsersPage as ComponentType));
    const text = container.textContent ?? '';
    expect(text).toContain('件名その 1');
    expect(text).toContain(`- ${INQUIRY_STATUS_LABELS.in_progress}`);
    expect(text).toContain('- 対応中');
    expect(text).not.toContain('in_progress');
    expect(text).toContain(`- ${UNKNOWN_VALUE}`);
  });
});

// ─── リードの詳細 (/admin/sales/{id}) ─────────────────────────────────────────

describe('#2112 Z3-2 リードの詳細 (/admin/sales/{id}) の流入経路', () => {
  function lead(source: string) {
    return {
      id: ROW_ID,
      company_name: '株式会社ラベル',
      industry: null,
      employee_count: null,
      contact_name: null,
      contact_email: null,
      contact_phone: null,
      source,
      stage: 'meeting',
      assigned_to: null,
      estimated_acv: null,
      notes: null,
      converted_org_id: null,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      activities: [],
    };
  }

  it.each([
    ['cold_call', LEAD_SOURCE_LABELS.cold_call],
    ['referral', '紹介'],
    [UNKNOWN_VALUE, UNKNOWN_VALUE],
  ])('流入経路 %s は「%s」と出す', async (source, expected) => {
    routeFetch({ [`/api/admin/sales/leads/${ROW_ID}`]: () => fetchJson({ data: lead(source) }) });
    const { default: LeadDetailPage } = await import('@/app/admin/sales/[id]/page');
    await renderClient(createElement(LeadDetailPage, { params: Promise.resolve({ id: ROW_ID }) }));
    const sourceTerm = Array.from(container.querySelectorAll('dt')).find((dt) => dt.textContent?.trim() === '流入経路');
    expect(sourceTerm?.nextElementSibling?.textContent?.trim()).toBe(expected);
  });

  it('作成の画面の流入経路の選択肢は表示名', async () => {
    const { default: NewLeadPage } = await import('@/app/admin/sales/new/page');
    await renderClient(createElement(NewLeadPage as ComponentType));
    expect(optionTexts(container.querySelector<HTMLSelectElement>('#source'))).toEqual([
      'ウェブサイト',
      '紹介',
      'イベント',
      'コールドコール',
      'その他',
    ]);
  });
});

// ─── 監査ログ (/super-admin/audit-logs)・バックアップ (/super-admin/backups) ─────

describe('#2112 Z3-2 監査ログの画面 (/super-admin/audit-logs) の重要度', () => {
  it('一覧の重要度の札と絞り込みの選択肢は表示名 (以前は info / warn / critical のまま)', async () => {
    routeFetch({
      '/api/super-admin/audit-logs': () =>
        fetchJson({
          data: [
            {
              id: 'log-1',
              actor_id: superAdminActor.id,
              actor_email_snapshot: 'sa@example.com',
              actor_role_snapshot: 'super_admin',
              action_type: 'admin.user.ban',
              target_id: ROW_ID,
              target_type: 'user',
              details: {},
              severity: 'warn',
              ip_address: null,
              created_at: '2026-10-01T00:00:00Z',
            },
          ],
          meta: { total: 1 },
        }),
    });
    const { default: AuditLogsPage } = await import('@/app/super-admin/audit-logs/page');
    await renderClient(createElement(AuditLogsPage as ComponentType));
    const body = container.querySelector('tbody');
    if (!body) throw new Error('監査ログの表がありません');
    const texts = leafTexts(body);
    expect(texts).toContain(ADMIN_AUDIT_SEVERITY_LABELS.warn);
    expect(texts).not.toContain('warn');
    const severitySelect = Array.from(container.querySelectorAll('select')).find((select) =>
      Array.from(select.options).some((option) => option.textContent === '全重要度'),
    );
    expect(optionTexts(severitySelect ?? null)).toEqual(ADMIN_AUDIT_SEVERITIES.map((value) => ADMIN_AUDIT_SEVERITY_LABELS[value]));
    expect(optionTexts(severitySelect ?? null)).toEqual(['情報', '警告', '重大']);
  });
});

// ─── 機能フラグ (/super-admin/flags) ─────────────────────────────────────────

describe('#2112 Z3-2 機能フラグの一覧 (/super-admin/flags) の公開の範囲の種類', () => {
  it('種類は表示名 (段階公開 30% など)。表に無い種類はそのまま出す', async () => {
    routeFetch({
      '/api/super-admin/flags': () =>
        fetchJson({
          data: [
            {
              key: 'flag_rollout_half',
              description: '段階公開のフラグ',
              enabled: true,
              rollout_strategy: { type: 'percentage', value: 30 },
              constraints: null,
              active_user_count: null,
              updated_at: '2026-10-01T00:00:00Z',
            },
            {
              key: 'flag_unknown',
              description: '知らない種類のフラグ',
              enabled: false,
              rollout_strategy: { type: UNKNOWN_VALUE },
              constraints: null,
              active_user_count: null,
              updated_at: '2026-10-01T00:00:00Z',
            },
          ],
        }),
    });
    const { default: FlagsPage } = await import('@/app/super-admin/flags/page');
    await renderClient(createElement(FlagsPage as ComponentType));
    const text = container.textContent ?? '';
    expect(text).toContain(`${ROLLOUT_STRATEGY_TYPE_LABELS.percentage} 30%`);
    expect(text).toContain('段階公開 30%');
    expect(text).not.toContain('percentage');
    expect(text).toContain(UNKNOWN_VALUE);
  });
});

// ─── クーポン (/super-admin/coupons・/super-admin/coupons/{id}) ───────────────

describe('#2112 Z3-2 クーポンの一覧・詳細の適用対象', () => {
  function coupon(applicableTo: string) {
    return {
      id: ROW_ID,
      code: 'LABEL2112',
      display_name: 'ラベルのクーポン',
      discount_type: 'fixed',
      discount_value: 100,
      applicable_to: applicableTo,
      applicable_plans: [],
      valid_from: '2026-10-01T00:00:00Z',
      valid_until: '2099-12-31T14:59:59Z',
      max_uses: null,
      uses_count: 0,
      per_user_limit: 1,
      duration_months: null,
      gross_margin_preview_jpy: null,
      status: 'active',
      created_by: superAdminActor.id,
      created_at: '2026-10-01T00:00:00Z',
    };
  }

  it('一覧: 適用対象は表示名 (以前は personal のまま)', async () => {
    requireRoleForPage.mockResolvedValue(superAdminActor);
    adminFetch.mockResolvedValue(adminJson({ data: [coupon('personal')], meta: { total: 1, page: 1, per_page: 100 } }));
    const { default: CouponsPage } = await import('@/app/super-admin/coupons/page');
    const page = await renderServer(CouponsPage());
    const texts = leafTexts(page);
    expect(texts).toContain(COUPON_APPLICABLE_TO_LABELS.personal);
    expect(texts).toContain('個人');
    expect(texts).not.toContain('personal');
  });

  it('詳細: 「適用対象: 家族」と出す (以前は「適用対象: family」)', async () => {
    nav.params = { id: ROW_ID };
    routeFetch({
      [`/api/super-admin/coupons/${ROW_ID}`]: () => fetchJson({ data: coupon('family') }),
      [`/api/super-admin/coupons/${ROW_ID}/redemptions`]: () => fetchJson({ data: [], meta: { total: 0 } }),
    });
    const { default: CouponDetailPage } = await import('@/app/super-admin/coupons/[id]/page');
    await renderClient(createElement(CouponDetailPage as ComponentType));
    const text = container.textContent ?? '';
    expect(text).toContain(`適用対象: ${COUPON_APPLICABLE_TO_LABELS.family}`);
    expect(text).toContain('適用対象: 家族');
    expect(text).not.toContain('適用対象: family');
  });

  it('詳細の適用履歴: 「対象」の列は表示名 (個人 / 組織。以前は personal / org のまま)', async () => {
    nav.params = { id: ROW_ID };
    const redemption = (n: number, target: string) => ({
      id: `r-${n}`,
      coupon_id: ROW_ID,
      user_id: target === 'org' ? null : OTHER_ID,
      organization_id: target === 'org' ? OTHER_ID : null,
      subscription_target: target,
      discount_amount_jpy: 100,
      redeemed_at: '2026-10-10T03:00:00.000Z',
      ended_at: null,
    });
    const rows = [...COUPON_SUBSCRIPTION_TARGETS, UNKNOWN_VALUE].map((target, i) => redemption(i + 1, target));
    routeFetch({
      [`/api/super-admin/coupons/${ROW_ID}`]: () => fetchJson({ data: coupon('all') }),
      [`/api/super-admin/coupons/${ROW_ID}/redemptions`]: () =>
        fetchJson({ data: rows, meta: { total: rows.length, page: 1, per_page: rows.length } }),
    });
    const { default: CouponDetailPage } = await import('@/app/super-admin/coupons/[id]/page');
    await renderClient(createElement(CouponDetailPage as ComponentType));
    const tab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('適用履歴'));
    if (!tab) throw new Error('適用履歴のタブがありません');
    await act(async () => {
      tab.click();
    });
    await flush();
    const targets = Array.from(container.querySelectorAll('tbody tr')).map(
      (tr) => tr.querySelectorAll('td')[1]?.textContent?.split(' / ')[0] ?? '',
    );
    expect(targets).toEqual([COUPON_SUBSCRIPTION_TARGET_LABELS.personal, COUPON_SUBSCRIPTION_TARGET_LABELS.org, UNKNOWN_VALUE]);
    expect(targets).toEqual(['個人', '組織', UNKNOWN_VALUE]);
    for (const raw of COUPON_SUBSCRIPTION_TARGETS) expect(targets).not.toContain(raw);
  });
});

// ─── 請求書の詳細 (/admin/finance/invoices/{id}) ───────────────────────────────

describe('#2112 Z3-2 請求書の詳細 (/admin/finance/invoices/{id}) の処理の状態の札', () => {
  function invoiceOf(processingStatus: string) {
    return {
      id: ROW_ID,
      stripe_event_id: 'evt_2112',
      event_type: 'invoice.paid',
      processing_status: processingStatus,
      user_id: null,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      stripe_invoice_id: null,
      amount_paid: null,
      amount_due: null,
      currency: 'jpy',
      invoice_number: 'HG-2112',
      invoice_pdf: null,
      period_start: null,
      period_end: null,
      stripe_links: { customer: null, subscription: null, invoice: null },
      received_at: '2026-10-01T00:00:00Z',
      processed_at: null,
      error_message: null,
    };
  }

  async function renderInvoice(processingStatus: string) {
    nav.params = { id: ROW_ID };
    routeFetch({ [`/api/admin/finance/invoices/${ROW_ID}`]: () => fetchJson({ data: invoiceOf(processingStatus) }) });
    const { default: InvoiceDetailPage } = await import('@/app/admin/finance/invoices/[id]/page');
    await renderClient(createElement(InvoiceDetailPage as ComponentType));
    return leafTexts(container);
  }

  it.each(INVOICE_PROCESSING_STATUSES.map((status) => [status]))('%s は表示名の札で出す (英字の内部の値を出さない)', async (status) => {
    const texts = await renderInvoice(status);
    expect(texts).toContain('請求書詳細');
    expect(texts).toContain(INVOICE_PROCESSING_STATUS_LABELS[status]);
    for (const raw of INVOICE_PROCESSING_STATUSES) expect(texts).not.toContain(raw);
  });

  it.each([
    ['completed', '処理済み'],
    ['failed', '失敗'],
    [UNKNOWN_VALUE, UNKNOWN_VALUE],
  ])('%s の札は「%s」(表に無い値はそのまま出す)', async (status, label) => {
    expect(await renderInvoice(status)).toContain(label);
  });
});

// ─── 利用者の詳細の「手動のプラン付与」(src/components/admin/ManualPlanGrantSection.tsx) ──

describe('#2112 Z3-2 利用者の詳細の「手動のプラン付与」のプラン (今の契約・履歴・付与と取り消しの文)', () => {
  const MANUAL_PLAN_PATH = `/api/super-admin/users/${ROW_ID}/manual-plan`;
  const SUBSCRIPTION_ID = '00000000-0000-4000-8000-000000002112';
  const GRANTED_PLAN_KEY = 'family_pro';
  const GRANTED_PLAN_LABEL = '家族 Pro';
  const PLANS = [{ plan_key: GRANTED_PLAN_KEY, display_name: GRANTED_PLAN_LABEL, plan_type: 'family', max_members: null }];
  const manualCurrent = {
    subscription_id: SUBSCRIPTION_ID,
    plan_key: GRANTED_PLAN_KEY,
    status: 'active',
    source: 'manual',
    starts_at: '2026-10-29T00:00:00.000Z',
    expires_at: null,
  };
  const history = [
    {
      id: '00000000-0000-4000-8000-000000002113',
      action_type: 'admin.billing.manual_grant',
      actor_id: superAdminActor.id,
      created_at: '2026-10-29T00:00:00.000Z',
      plan_key: GRANTED_PLAN_KEY,
      expires_at: null,
      reason: '検証のため',
    },
    {
      id: '00000000-0000-4000-8000-000000002114',
      action_type: 'system.billing.manual_grant_expired',
      actor_id: null,
      created_at: '2026-10-28T00:00:00.000Z',
      plan_key: null,
      expires_at: null,
      reason: null,
    },
  ];

  /** method ごとに応答を順に返す fetch の偽物 (知らない呼び出しはテストの誤りとして投げる) */
  function manualPlanFetch(responses: Record<'GET' | 'POST' | 'DELETE', unknown[]>) {
    const queues = { GET: [...responses.GET], POST: [...responses.POST], DELETE: [...responses.DELETE] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        const method = (init?.method ?? 'GET') as keyof typeof queues;
        const body = url.pathname === MANUAL_PLAN_PATH ? queues[method]?.shift() : undefined;
        if (body === undefined) throw new Error(`想定外の呼び出し: ${method} ${url.pathname}`);
        return fetchJson(body);
      }),
    );
  }

  async function renderSection() {
    const { ManualPlanGrantSection } = await import('@/components/admin/ManualPlanGrantSection');
    await renderClient(createElement(ManualPlanGrantSection, { userId: ROW_ID }));
    const section = container.querySelector('[data-testid="manual-plan-grant"]');
    if (!section) throw new Error('手動のプラン付与の節がありません');
    return section;
  }

  async function setValue(selector: string, value: string) {
    const field = container.querySelector<HTMLSelectElement | HTMLTextAreaElement>(selector);
    if (!field) throw new Error(`${selector} がありません`);
    await act(async () => {
      const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
  }

  async function submit(testId: string) {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (!button?.form) throw new Error(`${testId} のフォームがありません`);
    await act(async () => {
      button.form?.requestSubmit(button);
    });
    await flush();
  }

  const resultText = () => container.querySelector('[data-testid="manual-plan-grant-result"]')?.textContent ?? '';

  beforeEach(() => {
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  it('今の契約のプランと履歴のプランは表示名 (以前は family_pro のまま)。履歴の plan_key が無い行は「-」', async () => {
    manualPlanFetch({ GET: [{ data: { current: manualCurrent, plans: PLANS, history } }], POST: [], DELETE: [] });
    const section = await renderSection();
    const current = section.querySelector('[data-testid="manual-plan-grant-current"]');
    if (!current) throw new Error('今の契約の欄がありません');
    expect(leafTexts(current)).toContain(ADMIN_PLAN_KEY_LABELS.family_pro);
    expect(leafTexts(current)).toContain(GRANTED_PLAN_LABEL);
    const historyBox = section.querySelector('[data-testid="manual-plan-grant-history"]');
    if (!historyBox) throw new Error('履歴がありません');
    expect(leafTexts(historyBox)).toContain(GRANTED_PLAN_LABEL);
    expect(leafTexts(historyBox)).toContain('-');
    expect(leafTexts(section)).not.toContain(GRANTED_PLAN_KEY);
  });

  it('付与の成功の文は「家族 Pro を付与しました」(以前は「family_pro を付与しました」)', async () => {
    manualPlanFetch({
      GET: [
        { data: { current: null, plans: PLANS, history: [] } },
        { data: { current: manualCurrent, plans: PLANS, history: [] } },
      ],
      POST: [
        { data: { subscription_id: SUBSCRIPTION_ID, user_id: ROW_ID, plan_key: GRANTED_PLAN_KEY, status: 'active', expires_at: null } },
      ],
      DELETE: [],
    });
    await renderSection();
    await setValue('[data-testid="manual-plan-grant-plan"]', GRANTED_PLAN_KEY);
    await setValue('[data-testid="manual-plan-grant-reason"]', '検証のため');
    await submit('manual-plan-grant-submit');
    expect(resultText().startsWith(`${GRANTED_PLAN_LABEL} を付与しました`)).toBe(true);
    expect(resultText()).not.toContain(GRANTED_PLAN_KEY);
  });

  it('取り消しの成功の文は「家族 Pro の付与を取り消しました」(以前は「family_pro の付与を取り消しました」)', async () => {
    manualPlanFetch({
      GET: [
        { data: { current: manualCurrent, plans: PLANS, history: [] } },
        { data: { current: null, plans: PLANS, history: [] } },
      ],
      POST: [],
      DELETE: [
        {
          data: {
            subscription_id: SUBSCRIPTION_ID,
            user_id: ROW_ID,
            plan_key: GRANTED_PLAN_KEY,
            status_from: 'active',
            status_to: 'cancelled',
          },
        },
      ],
    });
    await renderSection();
    await setValue('[data-testid="manual-plan-revoke-reason"]', '検証の終了');
    await submit('manual-plan-revoke-submit');
    expect(resultText()).toBe(`${GRANTED_PLAN_LABEL} の付与を取り消しました`);
  });
});

// ─── NPS (/admin/finance/nps) ─────────────────────────────────────────────────

describe('#2112 Z3-2 NPS の画面 (/admin/finance/nps) のプラン', () => {
  it('最近のコメントのプランと絞り込みの選択肢は表示名 (送る値は plan_key のまま)', async () => {
    routeFetch({
      '/api/admin/finance/nps': () =>
        fetchJson({
          data: {
            nps: {
              total_responses: 1,
              promoters: 1,
              passives: 0,
              detractors: 0,
              nps_score: 100,
              avg_score: 10,
              response_rate: 50,
              recent_comments: [
                { id: 'c-1', score: 10, comment: 'とても良い', plan_key: 'family_basic', responded_at: '2026-10-01T03:00:00Z' },
              ],
            },
            csat: { total_responses: 0, avg_score: 0, score_distribution: {}, recent_feedbacks: [] },
          },
        }),
    });
    const { default: NpsPage } = await import('@/app/admin/finance/nps/page');
    await renderClient(createElement(NpsPage as ComponentType));
    const texts = leafTexts(container);
    expect(texts).toContain(ADMIN_PLAN_KEY_LABELS.family_basic);
    const planSelect = Array.from(container.querySelectorAll('select')).find((select) =>
      Array.from(select.options).some((option) => option.value === 'family_basic'),
    );
    if (!planSelect) throw new Error('プランの絞り込みがありません');
    const familyBasic = Array.from(planSelect.options).find((option) => option.value === 'family_basic');
    expect(familyBasic?.textContent).toBe('家族 Basic');
    for (const option of Array.from(planSelect.options)) {
      if (option.value === '') continue;
      expect(option.textContent).not.toBe(option.value);
    }
    expect(texts).not.toContain('family_basic');
  });
});
