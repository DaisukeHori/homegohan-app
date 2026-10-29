/**
 * #1326 運営の閲覧の監査ログ (一覧・検索、モデレーション詳細、請求書、営業リード、クーポン適用履歴)
 *
 * (a) 閲覧の記録を足した GET が、情報を返したときに admin_audit_logs へちょうど 1 行だけ記録すること
 *     - 一覧は「1 回の検索 = 1 行」。details には検索条件と件数だけを入れ、返した行の ID や値は入れない
 *     - 詳細は対象の ID を入れる (ユーザーの情報なら target はその本人)
 *     - 0 件・404・403 のときは記録しない (07-audit-monitoring.md §4.1.1)
 *     - 記録が失敗しても閲覧のレスポンスは変わらない (fail-open)
 * (b) src/app/api/admin と src/app/api/super-admin の中で、admin_audit_logs への直接の INSERT と
 *     x-forwarded-for の直読みが 0 件であること (コメントは数えない。記録は src/lib/admin/audit.ts の recordAdminAudit に揃える)
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@/lib/auth/errors';

// ─────────────────────────────────────────────────────────────────────────────
// モック
// ─────────────────────────────────────────────────────────────────────────────

const mockRequireRole = vi.fn();
const mockLoggerError = vi.fn();
const mockFetchModerationSingle = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (...errorArgs: unknown[]) => mockLoggerError(...errorArgs),
    withUser: vi.fn().mockReturnThis(),
  }),
  generateRequestId: () => 'req_test',
}));

// ユーザー一覧のメールアドレス (#1145) は service_role の RPC で引く。このテストの対象外なので、取得結果だけを差し替える
vi.mock('@/lib/admin/user-emails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/user-emails')>();
  return {
    ...actual,
    fetchUserEmails: vi.fn(async () => new Map<string, string>()),
    findUserIdsByEmail: vi.fn(async () => []),
  };
});

// モデレーションの 1 件の取得 (テーブルの結合) はこのテストの対象外なので、結果だけを差し替える
vi.mock('@/lib/admin/moderation-backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/moderation-backend')>();
  return {
    ...actual,
    fetchModerationSingle: (...args: unknown[]) => mockFetchModerationSingle(...args),
  };
});

type QueryResult = { data?: unknown; error?: unknown; count?: number | null };
type Insert = { table: string; row: Record<string, unknown> };

interface FakeClient {
  from: ReturnType<typeof vi.fn>;
  inserts: Insert[];
  auditRows: () => Array<Record<string, unknown>>;
}

/**
 * テーブルごとに「from() が呼ばれた順」で結果を返す簡易 Supabase モック。
 * チェーンのメソッドは何でも受け付けて自身を返し、insert だけは引数を記録する。結果を使い切ったら最後の結果を使い回す。
 */
function makeClient(tables: Record<string, QueryResult[]>): FakeClient {
  const queues = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, [...v]]));
  const inserts: Insert[] = [];
  const from = vi.fn((table: string) => {
    const queue = queues[table];
    if (!queue || queue.length === 0) throw new Error(`unexpected from("${table}")`);
    const result = queue.length > 1 ? queue.shift()! : queue[0];
    const settle = () => Promise.resolve(result);
    const builder: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
              settle().then(onFulfilled, onRejected);
          }
          if (prop === 'insert') {
            return (row: Record<string, unknown>) => {
              inserts.push({ table, row });
              return builder;
            };
          }
          if (prop === 'single' || prop === 'maybeSingle') return () => settle();
          return () => builder;
        },
      },
    );
    return builder;
  });
  return {
    from,
    inserts,
    auditRows: () => inserts.filter((i) => i.table === 'admin_audit_logs').map((i) => i.row),
  };
}

let userScopedClient: FakeClient;
let serviceRoleClient: FakeClient;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(userScopedClient),
  getSupabaseAdmin: () => serviceRoleClient,
}));

const usersRoute = await import('@/app/api/admin/users/route');
const ticketsRoute = await import('@/app/api/admin/support/tickets/route');
const moderationRoute = await import('@/app/api/admin/moderation/[type]/[id]/route');
const invoiceRoute = await import('@/app/api/admin/finance/invoices/[id]/route');
const leadsRoute = await import('@/app/api/admin/sales/leads/route');
const leadRoute = await import('@/app/api/admin/sales/leads/[id]/route');
const redemptionsRoute = await import('@/app/api/super-admin/coupons/[id]/redemptions/route');

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_B = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const FLAG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONTENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const LEAD_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const COUPON_ID = '12121212-1212-4121-8121-121212121212';
const TICKET_ID = '34343434-3434-4343-8343-343434343434';
const EVENT_ID = 'evt_1326_test';

// 返した値。監査ログの details に混ざってはいけない文字列
const SECRET_NICKNAME = '秘密のニックネーム太郎';
const SECRET_SUBJECT = '病気のことで相談です';
const SECRET_CONTACT = 'lead-contact@example.com';
const SECRET_PHOTO = 'https://example.com/secret-photo.jpg';

const actor = { id: ACTOR_ID, email: 'admin@example.com', roles: ['admin'], organization_id: null };
const INSERT_OK = { data: null, error: null };
const INSERT_FAILED = { data: null, error: { message: 'permission denied for table admin_audit_logs', code: '42501' } };
const CLIENT_IP = '203.0.113.7';

function get(url: string) {
  return new Request(url, {
    method: 'GET',
    headers: { 'x-forwarded-for': `${CLIENT_IP}, 70.41.3.18`, 'user-agent': 'vitest' },
  });
}

/** NextRequest を受ける route (request.nextUrl を読む) 向け */
async function nextGet(url: string) {
  const { NextRequest } = await import('next/server');
  return new NextRequest(url, {
    method: 'GET',
    headers: { 'x-forwarded-for': `${CLIENT_IP}, 70.41.3.18`, 'user-agent': 'vitest' },
  });
}

function expectNoValuesIn(details: unknown, ...secrets: string[]) {
  const serialized = JSON.stringify(details);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(actor);
  userScopedClient = makeClient({ admin_audit_logs: [INSERT_OK] });
  serviceRoleClient = makeClient({});
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) 閲覧の記録
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/users (一覧・検索) -> admin.user.list', () => {
  const profileRow = (id: string) => ({
    id,
    nickname: SECRET_NICKNAME,
    roles: ['user'],
    organization_id: null,
    plan_key_cached: 'free',
    last_login_at: null,
    created_at: '2026-01-01T00:00:00Z',
    frozen_at: null,
    frozen_reason: null,
    frozen_by: null,
    unban_at: null,
  });

  it('1 回の検索を 1 行だけ、本人の権限の client で記録する (検索条件と件数。行の ID や値は入れない)', async () => {
    serviceRoleClient = makeClient({
      user_profiles: [{ data: [profileRow(USER_A), profileRow(USER_B)], error: null, count: 57 }],
    });

    const res = await usersRoute.GET(get('http://localhost/api/admin/users?q=%E5%A4%AA%E9%83%8E&role=user&page=2&per_page=2'));

    expect(res.status).toBe(200);
    expect(serviceRoleClient.auditRows()).toHaveLength(0);
    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: ACTOR_ID,
      action_type: 'admin.user.list',
      target_id: null,
      target_type: 'user',
      severity: 'info',
      ip_address: CLIENT_IP,
      user_agent: 'vitest',
      details: {
        filters: { q: '太郎', role: 'user', order: 'desc', page: 2, per_page: 2 },
        returned_count: 2,
        total: 57,
      },
    });
    expectNoValuesIn(rows[0].details, USER_A, USER_B, SECRET_NICKNAME);
  });

  it('検索語は長さの上限で切り詰める (巨大な入力で監査行を膨らませない)', async () => {
    serviceRoleClient = makeClient({ user_profiles: [{ data: [profileRow(USER_A)], error: null, count: 1 }] });
    const longTerm = 'あ'.repeat(500);

    await usersRoute.GET(get(`http://localhost/api/admin/users?q=${encodeURIComponent(longTerm)}`));

    const details = userScopedClient.auditRows()[0].details as { filters: { q: string } };
    expect(details.filters.q).toBe('あ'.repeat(200));
  });

  it('0 件のときは記録しない', async () => {
    serviceRoleClient = makeClient({ user_profiles: [{ data: [], error: null, count: 0 }] });

    const res = await usersRoute.GET(get('http://localhost/api/admin/users?q=nobody'));

    expect(res.status).toBe(200);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });

  it('403 のときは記録しない', async () => {
    mockRequireRole.mockRejectedValue(new ForbiddenError('OP_PERMISSION_DENIED'));

    const res = await usersRoute.GET(get('http://localhost/api/admin/users'));

    expect(res.status).toBe(403);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });

  it('記録に失敗しても一覧は返し、失敗は db-logger に残る', async () => {
    serviceRoleClient = makeClient({ user_profiles: [{ data: [profileRow(USER_A)], error: null, count: 1 }] });
    userScopedClient = makeClient({ admin_audit_logs: [INSERT_FAILED] });

    const res = await usersRoute.GET(get('http://localhost/api/admin/users'));

    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(1);
    expect(userScopedClient.auditRows()).toHaveLength(1);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/admin/support/tickets (一覧) -> admin.support.ticket.list', () => {
  const ticket = { id: TICKET_ID, user_id: USER_A, subject: SECRET_SUBJECT, status: 'open' };

  it('1 回の取得を 1 行だけ記録する (絞り込みの条件と件数だけ)', async () => {
    userScopedClient = makeClient({
      support_tickets: [{ data: [ticket], error: null, count: 1 }],
      admin_audit_logs: [INSERT_OK],
    });

    const res = await ticketsRoute.GET((await nextGet('http://localhost/api/admin/support/tickets?status=open')) as never);

    expect(res.status).toBe(200);
    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: ACTOR_ID,
      action_type: 'admin.support.ticket.list',
      target_id: null,
      target_type: 'support_ticket',
      ip_address: CLIENT_IP,
      details: { filters: { status: 'open', page: 1, per_page: 50 }, returned_count: 1, total: 1 },
    });
    expectNoValuesIn(rows[0].details, TICKET_ID, USER_A, SECRET_SUBJECT);
  });

  it('0 件のときは記録しない', async () => {
    userScopedClient = makeClient({ support_tickets: [{ data: [], error: null, count: 0 }], admin_audit_logs: [INSERT_OK] });

    const res = await ticketsRoute.GET((await nextGet('http://localhost/api/admin/support/tickets')) as never);

    expect(res.status).toBe(200);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });
});

describe('GET /api/admin/moderation/[type]/[id] -> admin.moderation.view', () => {
  const item = (userId: string | null) => ({
    id: FLAG_ID,
    type: 'food',
    content_id: CONTENT_ID,
    content_url: SECRET_PHOTO,
    reporter_count: 1,
    user_id: userId,
    status: 'pending',
    reason: 'spam',
    resolution_note: null,
    resolved_by: null,
    resolved_at: null,
    created_at: '2026-10-01T00:00:00Z',
  });

  it('返すときに 1 行だけ記録し、対象はコンテンツの持ち主 (本人) にする', async () => {
    mockFetchModerationSingle.mockResolvedValue(item(USER_A));

    const res = await moderationRoute.GET(get(`http://localhost/api/admin/moderation/food/${FLAG_ID}`), {
      params: { type: 'food', id: FLAG_ID },
    });

    expect(res.status).toBe(200);
    expect(serviceRoleClient.auditRows()).toHaveLength(0);
    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: ACTOR_ID,
      action_type: 'admin.moderation.view',
      target_id: USER_A,
      target_type: 'user',
      ip_address: CLIENT_IP,
      details: { moderation_type: 'food', flag_id: FLAG_ID, content_id: CONTENT_ID },
    });
    expect((rows[0].details as { viewed_fields: string[] }).viewed_fields).toContain('content_url');
    expectNoValuesIn(rows[0].details, SECRET_PHOTO);
  });

  it('持ち主が分からないときは通報そのものを対象にする', async () => {
    mockFetchModerationSingle.mockResolvedValue(item(null));

    await moderationRoute.GET(get(`http://localhost/api/admin/moderation/food/${FLAG_ID}`), {
      params: { type: 'food', id: FLAG_ID },
    });

    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_id: FLAG_ID, target_type: 'moderation_item:food' });
  });

  it('404 のときは記録しない', async () => {
    mockFetchModerationSingle.mockResolvedValue(null);

    const res = await moderationRoute.GET(get(`http://localhost/api/admin/moderation/food/${FLAG_ID}`), {
      params: { type: 'food', id: FLAG_ID },
    });

    expect(res.status).toBe(404);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });
});

describe('GET /api/admin/finance/invoices/[id] -> admin.finance.invoice.view', () => {
  const event = {
    id: EVENT_ID,
    event_type: 'invoice.paid',
    processing_status: 'processed',
    payload: { data: { object: { id: 'in_1326', customer: 'cus_1326', subscription: 'sub_1326', amount_paid: 98000 } } },
    received_at: '2026-10-01T00:00:00Z',
  };

  it('返すときに 1 行だけ記録し、対象は請求先のユーザーにする (イベント ID は details)', async () => {
    userScopedClient = makeClient({
      stripe_webhook_events: [{ data: event, error: null }],
      personal_subscriptions: [{ data: { user_id: USER_A, plan_key: 'pro' }, error: null }],
      admin_audit_logs: [INSERT_OK],
    });

    const res = await invoiceRoute.GET((await nextGet(`http://localhost/api/admin/finance/invoices/${EVENT_ID}`)) as never, {
      params: { id: EVENT_ID },
    });

    expect(res.status).toBe(200);
    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: ACTOR_ID,
      action_type: 'admin.finance.invoice.view',
      target_id: USER_A,
      target_type: 'user',
      ip_address: CLIENT_IP,
      details: { stripe_event_id: EVENT_ID },
    });
    expectNoValuesIn(rows[0].details, 'cus_1326', '98000');
  });

  it('請求先のユーザーが引けないときは対象なし (stripe_event) で記録する', async () => {
    userScopedClient = makeClient({
      stripe_webhook_events: [{ data: { ...event, payload: { data: { object: { id: 'in_1326' } } } }, error: null }],
      admin_audit_logs: [INSERT_OK],
    });

    await invoiceRoute.GET((await nextGet(`http://localhost/api/admin/finance/invoices/${EVENT_ID}`)) as never, {
      params: { id: EVENT_ID },
    });

    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_id: null, target_type: 'stripe_event', details: { stripe_event_id: EVENT_ID } });
  });

  it('404 のときは記録しない', async () => {
    // maybeSingle は行が無いと data: null・error: null を返す (#1917。DB の失敗は 404 ではなく 500)
    userScopedClient = makeClient({ stripe_webhook_events: [{ data: null, error: null }], admin_audit_logs: [INSERT_OK] });

    const res = await invoiceRoute.GET((await nextGet(`http://localhost/api/admin/finance/invoices/${EVENT_ID}`)) as never, {
      params: { id: EVENT_ID },
    });

    expect(res.status).toBe(404);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });
});

describe('GET /api/admin/sales/leads と [id] -> admin.sales.lead.list / admin.sales.lead.view', () => {
  const lead = { id: LEAD_ID, company_name: '株式会社テスト', contact_email: SECRET_CONTACT, stage: 'approach' };

  it('一覧は 1 回の取得を 1 行だけ記録する', async () => {
    userScopedClient = makeClient({ sales_leads: [{ data: [lead], error: null, count: 1 }], admin_audit_logs: [INSERT_OK] });

    const res = await leadsRoute.GET((await nextGet('http://localhost/api/admin/sales/leads?stage=approach')) as never);

    expect(res.status).toBe(200);
    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action_type: 'admin.sales.lead.list',
      target_id: null,
      target_type: 'sales_lead',
      details: { filters: { stage: 'approach', page: 1, per_page: 50 }, returned_count: 1, total: 1 },
    });
    expectNoValuesIn(rows[0].details, LEAD_ID, SECRET_CONTACT);
  });

  it('一覧が 0 件のときは記録しない', async () => {
    userScopedClient = makeClient({ sales_leads: [{ data: [], error: null, count: 0 }], admin_audit_logs: [INSERT_OK] });

    await leadsRoute.GET((await nextGet('http://localhost/api/admin/sales/leads')) as never);

    expect(userScopedClient.auditRows()).toHaveLength(0);
  });

  it('詳細は対象のリード ID で 1 行だけ記録する (項目名と活動履歴の件数だけ)', async () => {
    userScopedClient = makeClient({
      sales_leads: [{ data: lead, error: null }],
      sales_lead_activities: [{ data: [{ id: 'a1' }, { id: 'a2' }], error: null }],
      admin_audit_logs: [INSERT_OK],
    });

    const res = await leadRoute.GET((await nextGet(`http://localhost/api/admin/sales/leads/${LEAD_ID}`)) as never, {
      params: { id: LEAD_ID },
    });

    expect(res.status).toBe(200);
    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: ACTOR_ID,
      action_type: 'admin.sales.lead.view',
      target_id: LEAD_ID,
      target_type: 'sales_lead',
      ip_address: CLIENT_IP,
      details: { activity_count: 2 },
    });
    expect((rows[0].details as { viewed_fields: string[] }).viewed_fields).toContain('contact_email');
    expectNoValuesIn(rows[0].details, SECRET_CONTACT);
  });

  it('詳細が 404 (リードの行が無い) のときは記録しない', async () => {
    userScopedClient = makeClient({ sales_leads: [{ data: null, error: null }], admin_audit_logs: [INSERT_OK] });

    const res = await leadRoute.GET((await nextGet(`http://localhost/api/admin/sales/leads/${LEAD_ID}`)) as never, {
      params: { id: LEAD_ID },
    });

    expect(res.status).toBe(404);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });

  it('リードの読み込みが DB の失敗なら 500 (404 にしない) で、記録しない (#1917)', async () => {
    userScopedClient = makeClient({ sales_leads: [{ data: null, error: { message: 'timeout', code: '57014' } }], admin_audit_logs: [INSERT_OK] });

    const res = await leadRoute.GET((await nextGet(`http://localhost/api/admin/sales/leads/${LEAD_ID}`)) as never, {
      params: { id: LEAD_ID },
    });

    expect(res.status).toBe(500);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });
});

describe('GET /api/super-admin/coupons/[id]/redemptions -> super_admin.coupon.view_redemptions', () => {
  it('1 回の取得を 1 行だけ、対象をクーポンにして記録する', async () => {
    userScopedClient = makeClient({
      coupons: [{ data: { id: COUPON_ID, code: 'WELCOME' }, error: null }],
      coupon_redemptions: [{ data: [{ id: 'r1', user_id: USER_A }], error: null, count: 1 }],
      admin_audit_logs: [INSERT_OK],
    });

    const res = await redemptionsRoute.GET(
      (await nextGet(`http://localhost/api/super-admin/coupons/${COUPON_ID}/redemptions`)) as never,
      { params: { id: COUPON_ID } },
    );

    expect(res.status).toBe(200);
    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: ACTOR_ID,
      action_type: 'super_admin.coupon.view_redemptions',
      target_id: COUPON_ID,
      target_type: 'coupon',
      ip_address: CLIENT_IP,
      details: { returned_count: 1, total: 1 },
    });
    expectNoValuesIn(rows[0].details, USER_A);
  });

  it('0 件のときは記録しない', async () => {
    userScopedClient = makeClient({
      coupons: [{ data: { id: COUPON_ID, code: 'WELCOME' }, error: null }],
      coupon_redemptions: [{ data: [], error: null, count: 0 }],
      admin_audit_logs: [INSERT_OK],
    });

    await redemptionsRoute.GET(
      (await nextGet(`http://localhost/api/super-admin/coupons/${COUPON_ID}/redemptions`)) as never,
      { params: { id: COUPON_ID } },
    );

    expect(userScopedClient.auditRows()).toHaveLength(0);
  });
});

describe('変更系も recordAdminAudit で記録する (例: POST /api/admin/support/tickets)', () => {
  it('ip_address は x-forwarded-for の先頭の 1 つだけ、User-Agent も残す', async () => {
    // チケットと最初のメッセージは service_role で書く (運営の直接の書き込みを塞いだ。#1917 の続き)。監査ログは本人のセッション
    serviceRoleClient = makeClient({
      support_tickets: [{ data: { id: TICKET_ID }, error: null }],
      support_ticket_messages: [{ data: null, error: null }],
    });
    userScopedClient = makeClient({ admin_audit_logs: [INSERT_OK] });
    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/admin/support/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `${CLIENT_IP}, 70.41.3.18`, 'user-agent': 'vitest' },
      body: JSON.stringify({ user_id: USER_A, subject: 'subject', category: 'other', priority: 'low', body: 'body' }),
    });

    const res = await ticketsRoute.POST(req);

    expect(res.status).toBe(201);
    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action_type: 'admin.support.ticket.create',
      target_id: TICKET_ID,
      ip_address: CLIENT_IP,
      user_agent: 'vitest',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) 直接の INSERT と x-forwarded-for の直読みが無いこと (コメントは数えない)
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const SCANNED_DIRS = ['src/app/api/admin', 'src/app/api/super-admin'];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 文字列リテラル (テンプレートの固定部分を含む) の値。式を含むテンプレートは null */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * ソースを AST で読み、違反を列挙する (コメントは AST に出てこないので数えない)。
 *  - raw-insert: `<x>.from('admin_audit_logs')` の結果に対する `.insert(...)` / `.upsert(...)` (改行・空白を挟んでも同じ)
 *  - forwarded-for: 'x-forwarded-for' という文字列リテラル (大文字小文字は区別しない)
 */
function findViolations(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      if (
        (method === 'insert' || method === 'upsert') &&
        ts.isCallExpression(receiver) &&
        ts.isPropertyAccessExpression(receiver.expression) &&
        receiver.expression.name.text === 'from' &&
        receiver.arguments.length > 0 &&
        literalText(receiver.arguments[0]) === 'admin_audit_logs'
      ) {
        found.push(`raw-insert@${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
    }
    const text = literalText(node);
    if (text !== null && text.toLowerCase().includes('x-forwarded-for')) {
      found.push(`forwarded-for@${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('(b) admin / super-admin の route は監査ログを recordAdminAudit だけで書く', () => {
  it('検出器: 直接の INSERT と x-forwarded-for の直読みを見つけ、コメントの中は数えない', () => {
    const bad = [
      "await supabase.from('admin_audit_logs').insert({ actor_id: a });",
      'await supabase\n  .from("admin_audit_logs")\n  .insert({ actor_id: a });',
      'await db.from(`admin_audit_logs`).upsert({});',
      "const ip = request.headers.get('X-Forwarded-For');",
    ];
    for (const snippet of bad) expect(findViolations('bad.ts', snippet)).not.toHaveLength(0);

    const good = [
      "// await supabase.from('admin_audit_logs').insert({}) と request.headers.get('x-forwarded-for') は使わない",
      "/* supabase.from('admin_audit_logs').insert() */ const x = 1;",
      "await supabase.from('admin_audit_logs').select('*');",
      "await recordAdminAudit({ supabase, actorId: a, actionType: 'admin.user.view', request });",
    ];
    for (const snippet of good) expect(findViolations('good.ts', snippet)).toEqual([]);
  });

  it('src/app/api/admin と src/app/api/super-admin に違反が 0 件', () => {
    const files = SCANNED_DIRS.flatMap((dir) => listSourceFiles(path.join(ROOT, dir)));
    // 走査が空振りしていないこと (ディレクトリの移動などで 0 ファイルを検査して緑になるのを防ぐ)
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith(path.join('admin', 'users', 'route.ts')))).toBe(true);

    const violations = files.flatMap((file) =>
      findViolations(file, fs.readFileSync(file, 'utf8')).map((v) => `${path.relative(ROOT, file)} ${v}`),
    );
    expect(violations).toEqual([]);
  });
});
