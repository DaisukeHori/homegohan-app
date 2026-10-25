/**
 * #1571 記録の無かった運営の変更系の API が、監査ログ (admin_audit_logs) を 1 行残すこと
 *
 *   - POST /api/admin/sales/leads/[id]/activities          -> admin.sales.lead.activity_add
 *   - PUT  /api/super-admin/settings                       -> super_admin.setting.change
 *   - POST /api/super-admin/embeddings/regenerate          -> super_admin.embeddings.regenerate
 *   - POST /api/admin/support/tickets/[id]/messages        -> admin.support.ticket.message_add
 *   - POST /api/operator/membership/org/[id]/dissolve      -> super_admin.organization.dissolve
 *   - POST /api/operator/membership/org/[id]/transfer      -> super_admin.organization.transfer_admin
 *   - POST /api/operator/membership/family/[id]/dissolve   -> super_admin.family.dissolve
 *   - POST /api/operator/membership/family/[id]/transfer   -> super_admin.family.transfer_representative
 *
 * どれも、状態を変えられたときに本人の権限の client で 1 行だけ記録し、ip_address には利用者の IP (x-forwarded-for の先頭)、
 * user_agent も残す。入力の誤り・見つからない・失敗のときは記録しない。本文やメモの中身は details に入れない。
 * 記録に失敗しても、操作の応答は変えない (fail-open。失敗は db-logger に残る)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEAD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TICKET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TICKET_OWNER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FAMILY_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const NEW_OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OLD_OWNER_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_IP = '203.0.113.71';
const PROXY_IP = '10.0.0.1';
const USER_AGENT = 'vitest-admin-browser';
/** 監査ログに入ってはいけない本文 (活動のメモ・チケットの返信) の目印 */
const PRIVATE_TEXT = 'private-note-1571-do-not-log';

// ─────────────────────────────────────────────────────────────────────────────
// モック
// ─────────────────────────────────────────────────────────────────────────────

const mockRequireRole = vi.fn();
const mockRequireSuperAdmin = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock('@/lib/auth/operator-permissions', () => ({
  requireSuperAdmin: (...args: unknown[]) => mockRequireSuperAdmin(...args),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
    withUser: vi.fn().mockReturnThis(),
  }),
  generateRequestId: () => 'req_test',
}));

vi.mock('@/lib/admin/send-ticket-reply-email', () => ({
  sendTicketReplyEmail: vi.fn(async () => ({ status: 'sent' })),
}));

vi.mock('@/lib/membership/resolve-auth-emails', () => ({
  resolveAuthEmails: vi.fn(async () => new Map<string, string>()),
}));

vi.mock('@/lib/emails/send', () => ({
  sendEmail: vi.fn(async () => ({ ok: true })),
}));

type Result = { data?: unknown; error?: unknown; count?: number | null };
type Inserted = { table: string; row: Record<string, unknown> };

/**
 * テーブルごとに、await / single / maybeSingle で返す結果を順に持つ簡易 Supabase モック。
 * 結果を使い切ったテーブルは { data: null, error: null } を返す。insert / upsert の引数を記録する。
 */
function makeClient(
  tableResults: Record<string, Result[]>,
  rpcResults: Record<string, Result> = {},
  options: { auditInsertError?: { message: string; code?: string } } = {},
) {
  const inserted: Inserted[] = [];
  const queues = new Map(Object.entries(tableResults).map(([table, results]) => [table, [...results]]));
  const next = (table: string): Result => queues.get(table)?.shift() ?? { data: null, error: null };

  const from = (table: string) => {
    let isAuditInsert = false;
    const settle = (): Result =>
      isAuditInsert ? { data: null, error: options.auditInsertError ?? null } : next(table);
    const builder: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
              Promise.resolve(settle()).then(onFulfilled, onRejected);
          }
          if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(settle());
          if (prop === 'insert' || prop === 'upsert') {
            return (row: Record<string, unknown>) => {
              inserted.push({ table, row });
              if (table === 'admin_audit_logs') isAuditInsert = true;
              return builder;
            };
          }
          return () => builder;
        },
      },
    );
    return builder;
  };

  return {
    from: vi.fn(from),
    rpc: vi.fn(async (name: string) => rpcResults[name] ?? { data: null, error: { message: 'unexpected rpc' } }),
    auditRows: () => inserted.filter((i) => i.table === 'admin_audit_logs').map((i) => i.row),
    inserted,
  };
}

let userScopedClient: ReturnType<typeof makeClient>;
let serviceClient: ReturnType<typeof makeClient>;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(userScopedClient),
  getSupabaseAdmin: () => serviceClient,
}));

const activitiesRoute = await import('@/app/api/admin/sales/leads/[id]/activities/route');
const settingsRoute = await import('@/app/api/super-admin/settings/route');
const embeddingsRoute = await import('@/app/api/super-admin/embeddings/regenerate/route');
const messagesRoute = await import('@/app/api/admin/support/tickets/[id]/messages/route');
const orgDissolveRoute = await import('@/app/api/operator/membership/org/[id]/dissolve/route');
const orgTransferRoute = await import('@/app/api/operator/membership/org/[id]/transfer/route');
const familyDissolveRoute = await import('@/app/api/operator/membership/family/[id]/dissolve/route');
const familyTransferRoute = await import('@/app/api/operator/membership/family/[id]/transfer/route');

function jsonRequest(url: string, method: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `${CLIENT_IP}, ${PROXY_IP}`,
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify(body),
  });
}

const paramsOf = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({ id: ACTOR_ID, email: 'op@example.com', roles: ['super_admin'], organization_id: null });
  mockRequireSuperAdmin.mockResolvedValue({ userId: ACTOR_ID });
  userScopedClient = makeClient({});
  serviceClient = makeClient({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** 1 行だけ記録され、利用者の IP と User-Agent が入っていること */
function expectSingleAuditRow(expected: Record<string, unknown>): Record<string, unknown> {
  const rows = userScopedClient.auditRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor_id: ACTOR_ID, ip_address: CLIENT_IP, user_agent: USER_AGENT, ...expected });
  return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/admin/sales/leads/[id]/activities -> admin.sales.lead.activity_add', () => {
  const body = { activity_type: 'call', details: { memo: PRIVATE_TEXT } };

  it('追加できたら、対象をリードにして 1 行記録する (活動の本文は入れない)', async () => {
    userScopedClient = makeClient({ sales_leads: [{ data: { id: LEAD_ID }, error: null }] });
    // 活動の追加とリードの updated_at の更新は service_role で書く (運営の直接の書き込みを塞いだ。#1917 の続き)
    serviceClient = makeClient({
      sales_lead_activities: [{ data: { id: 'act-1571', lead_id: LEAD_ID, activity_type: 'call' }, error: null }],
      sales_leads: [{ data: null, error: null }],
    });

    const res = await activitiesRoute.POST(jsonRequest(`/api/admin/sales/leads/${LEAD_ID}/activities`, 'POST', body), paramsOf(LEAD_ID));

    expect(res.status).toBe(201);
    expect(serviceClient.inserted.map((i) => i.table)).toEqual(['sales_lead_activities']);
    expect(userScopedClient.inserted.map((i) => i.table)).toEqual(['admin_audit_logs']);
    const row = expectSingleAuditRow({
      action_type: 'admin.sales.lead.activity_add',
      target_id: LEAD_ID,
      target_type: 'sales_lead',
      details: { activity_id: 'act-1571', activity_type: 'call' },
    });
    expect(JSON.stringify(row)).not.toContain(PRIVATE_TEXT);
  });

  it('リードが無いとき (404) は記録しない', async () => {
    userScopedClient = makeClient({ sales_leads: [{ data: null, error: null }] });

    const res = await activitiesRoute.POST(jsonRequest(`/api/admin/sales/leads/${LEAD_ID}/activities`, 'POST', body), paramsOf(LEAD_ID));

    expect(res.status).toBe(404);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });

  it('リードの読み込みが DB の失敗なら 500 (404 にしない) で、記録しない (#1917)', async () => {
    userScopedClient = makeClient({ sales_leads: [{ data: null, error: { message: 'timeout', code: '57014' } }] });

    const res = await activitiesRoute.POST(jsonRequest(`/api/admin/sales/leads/${LEAD_ID}/activities`, 'POST', body), paramsOf(LEAD_ID));

    expect(res.status).toBe(500);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });

  it('記録に失敗しても追加は 201 のまま (失敗は db-logger に残る)', async () => {
    userScopedClient = makeClient({ sales_leads: [{ data: { id: LEAD_ID }, error: null }] }, {}, { auditInsertError: { message: 'rls', code: '42501' } });
    serviceClient = makeClient({ sales_lead_activities: [{ data: { id: 'act-1571' }, error: null }] });

    const res = await activitiesRoute.POST(jsonRequest(`/api/admin/sales/leads/${LEAD_ID}/activities`, 'POST', body), paramsOf(LEAD_ID));

    expect(res.status).toBe(201);
    expect(mockLoggerError).toHaveBeenCalled();
  });
});

describe('PUT /api/super-admin/settings -> super_admin.setting.change', () => {
  it('保存できたら key と値を 1 行記録する', async () => {
    // 設定の保存は service_role で書く (運営の直接の書き込みを塞いだ。#1917 の続き)
    serviceClient = makeClient({ system_settings: [{ data: null, error: null }] });

    const res = await settingsRoute.PUT(jsonRequest('/api/super-admin/settings', 'PUT', { key: ' support_email ', value: 'help@example.com' }));

    expect(res.status).toBe(200);
    expect(serviceClient.inserted.map((i) => i.table)).toEqual(['system_settings']);
    expect(userScopedClient.inserted.map((i) => i.table)).toEqual(['admin_audit_logs']);
    expectSingleAuditRow({
      action_type: 'super_admin.setting.change',
      target_id: null,
      target_type: 'system_setting',
      severity: 'warn',
      details: { key: 'support_email', value: 'help@example.com', description_changed: false },
    });
  });

  it('説明を送ったら description_changed: true', async () => {
    serviceClient = makeClient({ system_settings: [{ data: null, error: null }] });

    await settingsRoute.PUT(jsonRequest('/api/super-admin/settings', 'PUT', { key: 'support_email', value: 'x', description: 'メモ' }));

    expect(userScopedClient.auditRows()[0].details).toMatchObject({ description_changed: true });
  });

  it('使われていない key (409) と保存の失敗 (500) は記録しない', async () => {
    const readOnly = await settingsRoute.PUT(jsonRequest('/api/super-admin/settings', 'PUT', { key: 'feature_flags', value: {} }));
    expect(readOnly.status).toBe(409);
    expect(userScopedClient.auditRows()).toHaveLength(0);

    serviceClient = makeClient({ system_settings: [{ data: null, error: { message: 'db down' } }] });
    const failed = await settingsRoute.PUT(jsonRequest('/api/super-admin/settings', 'PUT', { key: 'support_email', value: 'x' }));
    expect(failed.status).toBe(500);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });
});

describe('POST /api/super-admin/embeddings/regenerate -> super_admin.embeddings.regenerate', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-1571');
  });

  it('Edge Function が成功を返したら、対象のテーブルと処理件数を 1 行記録する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: true, processed: 7, offset: 0, nextOffset: 7, hasMore: true }), { status: 200 })),
    );

    const res = await embeddingsRoute.POST(
      jsonRequest('/api/super-admin/embeddings/regenerate', 'POST', { table: 'dataset_recipes', onlyMissing: true }),
    );

    expect(res.status).toBe(200);
    expectSingleAuditRow({
      action_type: 'super_admin.embeddings.regenerate',
      target_type: 'embedding_table',
      details: { table: 'dataset_recipes', only_missing: true, offset: 0, processed: 7, has_more: true },
    });
  });

  it('Edge Function が失敗 (502)・入力の誤り (400) のときは記録しない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })));
    const failed = await embeddingsRoute.POST(jsonRequest('/api/super-admin/embeddings/regenerate', 'POST', { table: 'dataset_recipes' }));
    expect(failed.status).toBe(502);

    const invalid = await embeddingsRoute.POST(jsonRequest('/api/super-admin/embeddings/regenerate', 'POST', { table: 'meals' }));
    expect(invalid.status).toBe(400);

    expect(userScopedClient.auditRows()).toHaveLength(0);
  });
});

describe('POST /api/admin/support/tickets/[id]/messages -> admin.support.ticket.message_add', () => {
  it('保存できたら、対象をチケットを作ったユーザーにして 1 行記録する (本文は入れない)', async () => {
    userScopedClient = makeClient({
      support_tickets: [{ data: { id: TICKET_ID, status: 'open', user_id: TICKET_OWNER_ID, subject: 's' }, error: null }],
    });
    // メッセージの保存は service_role で書く (運営の直接の書き込みを塞いだ。#1917 の続き)
    serviceClient = makeClient({ support_ticket_messages: [{ data: { id: 'msg-1571' }, error: null }] });

    const res = await messagesRoute.POST(
      jsonRequest(`/api/admin/support/tickets/${TICKET_ID}/messages`, 'POST', { body: PRIVATE_TEXT, is_internal: false }),
      paramsOf(TICKET_ID),
    );

    expect(res.status).toBe(201);
    expect(serviceClient.inserted.map((i) => i.table)).toEqual(['support_ticket_messages']);
    expect(userScopedClient.inserted.map((i) => i.table)).toEqual(['admin_audit_logs']);
    const row = expectSingleAuditRow({
      action_type: 'admin.support.ticket.message_add',
      target_id: TICKET_OWNER_ID,
      target_type: 'user',
      details: { ticket_id: TICKET_ID, message_id: 'msg-1571', is_internal: false },
    });
    expect(JSON.stringify(row)).not.toContain(PRIVATE_TEXT);
  });

  it('ユーザーの分からないチケットは、チケットを対象にする (内部メモも記録する)', async () => {
    userScopedClient = makeClient({
      support_tickets: [{ data: { id: TICKET_ID, status: 'open', user_id: null, subject: 's' }, error: null }],
    });
    serviceClient = makeClient({ support_ticket_messages: [{ data: { id: 'msg-1572' }, error: null }] });

    await messagesRoute.POST(
      jsonRequest(`/api/admin/support/tickets/${TICKET_ID}/messages`, 'POST', { body: 'memo', is_internal: true }),
      paramsOf(TICKET_ID),
    );

    expectSingleAuditRow({
      target_id: TICKET_ID,
      target_type: 'support_ticket',
      details: { ticket_id: TICKET_ID, message_id: 'msg-1572', is_internal: true },
    });
  });

  it('チケットが無いとき (404) は記録しない', async () => {
    // maybeSingle は行が無いと data: null・error: null を返す (#1917。DB の失敗は 404 ではなく 500)
    userScopedClient = makeClient({ support_tickets: [{ data: null, error: null }] });

    const res = await messagesRoute.POST(
      jsonRequest(`/api/admin/support/tickets/${TICKET_ID}/messages`, 'POST', { body: 'x' }),
      paramsOf(TICKET_ID),
    );

    expect(res.status).toBe(404);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });
});

describe('POST /api/operator/membership/* (運営の強制解散・譲渡)', () => {
  const cases = [
    {
      name: '組織の強制解散 -> super_admin.organization.dissolve',
      route: () => orgDissolveRoute.POST,
      id: ORG_ID,
      url: `/api/operator/membership/org/${ORG_ID}/dissolve`,
      body: { reason: '規約違反' },
      rpc: 'operator_force_dissolve_org',
      service: { user_profiles: [{ data: [], error: null }], organizations: [{ data: { name: 'org' }, error: null }] },
      expected: {
        action_type: 'super_admin.organization.dissolve',
        target_id: ORG_ID,
        target_type: 'organization',
        severity: 'critical',
        details: { reason: '規約違反' },
      },
    },
    {
      name: '組織のオーナーの譲渡 -> super_admin.organization.transfer_admin',
      route: () => orgTransferRoute.POST,
      id: ORG_ID,
      url: `/api/operator/membership/org/${ORG_ID}/transfer`,
      body: { to_user_id: NEW_OWNER_ID, reason: '退職' },
      rpc: 'operator_force_owner_transfer',
      service: { organizations: [{ data: { name: 'org', owner_id: OLD_OWNER_ID }, error: null }], user_profiles: [{ data: [], error: null }] },
      expected: {
        action_type: 'super_admin.organization.transfer_admin',
        target_id: ORG_ID,
        target_type: 'organization',
        severity: 'warn',
        details: { reason: '退職', to_user_id: NEW_OWNER_ID, from_user_id: OLD_OWNER_ID },
      },
    },
    {
      name: '家族の強制解散 -> super_admin.family.dissolve',
      route: () => familyDissolveRoute.POST,
      id: FAMILY_ID,
      url: `/api/operator/membership/family/${FAMILY_ID}/dissolve`,
      body: { reason: '本人の依頼' },
      rpc: 'operator_force_dissolve_family',
      service: { family_members: [{ data: [], error: null }], family_groups: [{ data: { name: 'fg' }, error: null }] },
      expected: {
        action_type: 'super_admin.family.dissolve',
        target_id: FAMILY_ID,
        target_type: 'family_group',
        severity: 'critical',
        details: { reason: '本人の依頼' },
      },
    },
    {
      name: '家族の代表者の譲渡 -> super_admin.family.transfer_representative',
      route: () => familyTransferRoute.POST,
      id: FAMILY_ID,
      url: `/api/operator/membership/family/${FAMILY_ID}/transfer`,
      body: { to_user_id: NEW_OWNER_ID, reason: '代表者の不在' },
      rpc: 'operator_force_representative_transfer',
      service: { family_groups: [{ data: { name: 'fg', representative_id: OLD_OWNER_ID }, error: null }], family_members: [{ data: [], error: null }] },
      expected: {
        action_type: 'super_admin.family.transfer_representative',
        target_id: FAMILY_ID,
        target_type: 'family_group',
        severity: 'warn',
        details: { reason: '代表者の不在', to_user_id: NEW_OWNER_ID, from_user_id: OLD_OWNER_ID },
      },
    },
  ];

  for (const c of cases) {
    it(`${c.name}: RPC が成功したら 1 行記録する`, async () => {
      serviceClient = makeClient(c.service);
      userScopedClient = makeClient({}, { [c.rpc]: { data: { id: c.id }, error: null } });

      const res = await c.route()(jsonRequest(c.url, 'POST', c.body), paramsOf(c.id));

      expect(res.status).toBe(200);
      expectSingleAuditRow(c.expected);
    });

    it(`${c.name}: RPC が失敗したら記録しない`, async () => {
      serviceClient = makeClient(c.service);
      userScopedClient = makeClient({}, { [c.rpc]: { data: null, error: { message: 'db error' } } });

      const res = await c.route()(jsonRequest(c.url, 'POST', c.body), paramsOf(c.id));

      expect(res.status).toBe(500);
      expect(userScopedClient.auditRows()).toHaveLength(0);
    });
  }
});
