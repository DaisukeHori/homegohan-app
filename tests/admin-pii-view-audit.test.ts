/**
 * #1200 管理者・サポートによるユーザー PII 閲覧の監査ログ記録 (route 単位の単体テスト)
 *
 * 対象 route (どれも「他ユーザーの情報を返す GET」):
 *  - GET /api/admin/users/[id]                      -> admin.user.view
 *  - GET /api/support/users/[id]                    -> admin.user.view_support
 *  - GET /api/support/users/[id]/notes              -> admin.user.view_notes
 *  - GET /api/admin/support/tickets/[id]            -> admin.support.ticket.view
 *  - GET /api/admin/support/tickets/[id]/messages   -> admin.support.ticket.view_messages
 *  - POST /api/support/users/[id]/notes (旧実装は存在しない列 admin_id に書いて黙って失敗していた)
 *
 * 各 route で共通して確認すること:
 *  - 情報を返したとき、admin_audit_logs に 1 行だけ INSERT する (actor / target / action)
 *  - 404・401・403 など情報を返さなかったときは記録しない
 *  - details は項目名だけで、閲覧した値 (ニックネームや本文) を含めない
 *  - INSERT が失敗しても閲覧のレスポンスは変わらず、失敗は db-logger に error で残る
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

// ─────────────────────────────────────────────────────────────────────────────
// モック
// ─────────────────────────────────────────────────────────────────────────────

const mockRequireRole = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: (...args: unknown[]) => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (...errorArgs: unknown[]) => mockLoggerError(...args, ...errorArgs),
    withUser: vi.fn(),
  }),
  generateRequestId: () => 'req_test',
}));

// ユーザー詳細のメールアドレス (#1145) は service_role の RPC で引く。このテストの対象外なので、
// 見てよいロールの判定 (canViewUserEmail) は本物のまま、取得結果だけを差し替える。
const mockFetchUserEmails = vi.fn();

vi.mock('@/lib/admin/user-emails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/user-emails')>();
  return {
    ...actual,
    fetchUserEmails: (...args: unknown[]) => mockFetchUserEmails(...args),
  };
});

type QueryResult = {
  data?: unknown;
  error?: unknown;
  count?: number | null;
  /** await されたときに reject する (例外を投げる DB 呼び出しの再現) */
  rejects?: Error;
};

type Insert = { table: string; row: Record<string, unknown> };

interface FakeClient {
  from: ReturnType<typeof vi.fn>;
  auth: { getUser: ReturnType<typeof vi.fn> };
  inserts: Insert[];
  auditRows: () => Array<Record<string, unknown>>;
}

/**
 * テーブルごとに「from() が呼ばれた順」で結果を返す簡易 Supabase モック。
 * select / eq / in / order など、チェーンのメソッドは何でも受け付けて自身を返し、
 * insert だけは引数を記録する。結果を使い切ったら最後の結果を使い回す。
 */
function makeClient(
  tables: Record<string, QueryResult[]>,
  user: { id: string } | null = null,
): FakeClient {
  const queues = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, [...v]]));
  const inserts: Insert[] = [];

  const from = vi.fn((table: string) => {
    const queue = queues[table];
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected from("${table}")`);
    }
    const result = queue.length > 1 ? queue.shift()! : queue[0];
    const settle = () => (result.rejects ? Promise.reject(result.rejects) : Promise.resolve(result));
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
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) },
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

const adminUserRoute = await import('@/app/api/admin/users/[id]/route');
const supportUserRoute = await import('@/app/api/support/users/[id]/route');
const supportNotesRoute = await import('@/app/api/support/users/[id]/notes/route');
const ticketRoute = await import('@/app/api/admin/support/tickets/[id]/route');
const ticketMessagesRoute = await import('@/app/api/admin/support/tickets/[id]/messages/route');

// ─────────────────────────────────────────────────────────────────────────────
// 共通のテストデータ
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUPPORT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TARGET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TICKET_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOTE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

// 閲覧される側の値。監査ログの details に混ざってはいけない文字列。
const SECRET_NICKNAME = '秘密のニックネーム太郎';
const SECRET_SUBJECT = '病気のことで相談です';
const SECRET_BODY = '持病はこれこれで、薬は〇〇を飲んでいます';
const SECRET_NOTE = '本人から電話あり、住所変更を希望';
const SECRET_EMAIL = 'secret-target@example.com';

const adminActor = { id: ADMIN_ID, email: 'admin@example.com', roles: ['admin'], organization_id: null };
const supportActor = { id: SUPPORT_ID, email: 'support@example.com', roles: ['support'], organization_id: null };

const INSERT_FAILED = { data: null, error: { message: 'permission denied for table admin_audit_logs', code: '42501' } };
const INSERT_OK = { data: null, error: null };

function get(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { method: 'GET', headers });
}

function json(res: Response) {
  return res.json() as Promise<Record<string, any>>;
}

/** details に閲覧した値が入っていないことを確認する */
function expectNoValuesIn(details: unknown, ...secrets: string[]) {
  const serialized = JSON.stringify(details);
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(adminActor);
  mockFetchUserEmails.mockResolvedValue(new Map());
  userScopedClient = makeClient({});
  serviceRoleClient = makeClient({});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users/[id]
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/users/[id] -> admin.user.view', () => {
  const profile = {
    id: TARGET_ID,
    nickname: SECRET_NICKNAME,
    roles: ['user'],
    plan_key_cached: 'pro',
    organization_id: null,
    last_login_at: '2026-10-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    frozen_at: null,
    frozen_reason: null,
    frozen_by: null,
    unban_at: null,
  };

  function setup(auditInsert: QueryResult = INSERT_OK, profileResult: QueryResult = { data: profile, error: null }) {
    serviceRoleClient = makeClient({ user_profiles: [profileResult] });
    userScopedClient = makeClient({
      support_tickets: [{ data: null, error: null, count: 2 }],
      personal_subscriptions: [{ data: null, error: null }],
      // 1 回目は BAN 履歴の SELECT、2 回目が監査ログの INSERT
      admin_audit_logs: [{ data: [], error: null }, auditInsert],
    });
  }

  const call = (headers: Record<string, string> = {}) =>
    adminUserRoute.GET(get(`http://localhost/api/admin/users/${TARGET_ID}`, headers), {
      params: { id: TARGET_ID },
    });

  it('200: 閲覧を 1 行記録する (actor / target / action / IP / User-Agent)', async () => {
    setup();

    const res = await call({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18', 'user-agent': 'TestBrowser/1.0' });

    expect(res.status).toBe(200);
    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: ADMIN_ID,
      action_type: 'admin.user.view',
      target_id: TARGET_ID,
      target_type: 'user',
      severity: 'info',
      ip_address: '203.0.113.7',
      user_agent: 'TestBrowser/1.0',
    });
  });

  it('details は返した項目名だけ (ニックネームやメールアドレスなどの値は入れない)', async () => {
    mockFetchUserEmails.mockResolvedValue(new Map([[TARGET_ID, SECRET_EMAIL]]));
    setup();

    const res = await call();
    const body = await json(res);

    const [row] = userScopedClient.auditRows();
    expect(row.details).toEqual({ viewed_fields: Object.keys(body.data) });
    expect(body.data.nickname).toBe(SECRET_NICKNAME);
    expect(body.data.email).toBe(SECRET_EMAIL);
    expectNoValuesIn(row.details, SECRET_NICKNAME, SECRET_EMAIL);
  });

  it('support ロールが閲覧した場合も記録する (actor_id は閲覧した本人)', async () => {
    mockRequireRole.mockResolvedValue(supportActor);
    setup();

    const res = await call();

    expect(res.status).toBe(200);
    expect(userScopedClient.auditRows()).toHaveLength(1);
    expect(userScopedClient.auditRows()[0]).toMatchObject({
      actor_id: SUPPORT_ID,
      action_type: 'admin.user.view',
      target_id: TARGET_ID,
    });
  });

  it('404: 対象ユーザーがいないときは記録しない', async () => {
    setup(INSERT_OK, { data: null, error: null });

    const res = await call();

    expect(res.status).toBe(404);
    expect(userScopedClient.auditRows()).toHaveLength(0);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('INSERT が error を返しても 200 のまま返し、db-logger に error を残す', async () => {
    setup(INSERT_FAILED);

    const res = await call();

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.id).toBe(TARGET_ID);
    expect(body.data.nickname).toBe(SECRET_NICKNAME);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    const [routeName, message, error, metadata] = mockLoggerError.mock.calls[0];
    expect(routeName).toBe('api/admin/users/[id] GET');
    expect(message).toContain('監査ログ');
    expect((error as Error).message).toContain('permission denied');
    expect(metadata).toMatchObject({
      action_type: 'admin.user.view',
      actor_id: ADMIN_ID,
      target_id: TARGET_ID,
      error_code: '42501',
    });
  });

  it('INSERT が例外を投げても 200 のまま返し、db-logger に error を残す', async () => {
    setup({ rejects: new Error('connection reset') });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it('401: 未認証のときは何も記録しない', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));
    setup();

    const res = await call();

    expect(res.status).toBe(401);
    expect(userScopedClient.inserts).toHaveLength(0);
  });

  it('403: 権限が無いときは何も記録しない', async () => {
    mockRequireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED'));
    setup();

    const res = await call();

    expect(res.status).toBe(403);
    expect(userScopedClient.inserts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/support/users/[id]
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/support/users/[id] -> admin.user.view_support', () => {
  const targetUser = {
    id: TARGET_ID,
    nickname: SECRET_NICKNAME,
    age_group: '30s',
    gender: 'female',
    roles: ['user'],
    organization_id: null,
    is_banned: false,
    banned_at: null,
    banned_reason: null,
    last_login_at: '2026-10-01T00:00:00Z',
    login_count: 12,
    profile_completeness: 80,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  };

  function setup(opts: {
    actor?: { id: string } | null;
    actorRoles?: string[] | null;
    target?: QueryResult;
    auditInsert?: QueryResult;
  } = {}) {
    const actor = opts.actor === undefined ? { id: SUPPORT_ID } : opts.actor;
    userScopedClient = makeClient(
      {
        // 1 回目は閲覧者のロール確認、2 回目が閲覧対象
        user_profiles: [
          { data: opts.actorRoles === null ? null : { roles: opts.actorRoles ?? ['support'] }, error: null },
          opts.target ?? { data: targetUser, error: null },
        ],
        planned_meals: [{ data: null, error: null, count: 5 }],
        ai_consultation_sessions: [{ data: null, error: null, count: 3 }],
        inquiries: [{ data: [{ id: 'inq-1', inquiry_type: 'support', subject: SECRET_SUBJECT, status: 'pending', created_at: '2026-10-01T00:00:00Z' }], error: null }],
        admin_user_notes: [{ data: [{ id: NOTE_ID, note: SECRET_NOTE, created_at: '2026-10-01T00:00:00Z', admin_id: ADMIN_ID }], error: null }],
        admin_audit_logs: [opts.auditInsert ?? INSERT_OK],
      },
      actor,
    );
  }

  const call = (headers: Record<string, string> = {}) =>
    supportUserRoute.GET(get(`http://localhost/api/support/users/${TARGET_ID}`, headers), {
      params: { id: TARGET_ID },
    });

  it('200: 閲覧を 1 行記録する (actor / target / action / IP)', async () => {
    setup();

    const res = await call({ 'x-forwarded-for': '198.51.100.20', 'user-agent': 'SupportApp/2.0' });

    expect(res.status).toBe(200);
    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: SUPPORT_ID,
      action_type: 'admin.user.view_support',
      target_id: TARGET_ID,
      target_type: 'user',
      severity: 'info',
      ip_address: '198.51.100.20',
      user_agent: 'SupportApp/2.0',
    });
  });

  it('details は項目名だけ (ニックネーム・問い合わせ件名・ノート本文の値は入れない)', async () => {
    setup();

    const res = await call();
    const body = await json(res);

    const [row] = userScopedClient.auditRows();
    const fields = (row.details as { viewed_fields: string[] }).viewed_fields;
    expect(fields).toEqual(
      expect.arrayContaining(['user.nickname', 'user.ageGroup', 'user.gender', 'stats', 'inquiries', 'notes']),
    );
    expect(body.user.nickname).toBe(SECRET_NICKNAME);
    expect(body.notes[0].note).toBe(SECRET_NOTE);
    expectNoValuesIn(row.details, SECRET_NICKNAME, SECRET_SUBJECT, SECRET_NOTE);
  });

  it('admin ロールでも記録する', async () => {
    setup({ actor: { id: ADMIN_ID }, actorRoles: ['admin'] });

    const res = await call();

    expect(res.status).toBe(200);
    expect(userScopedClient.auditRows()[0]).toMatchObject({ actor_id: ADMIN_ID, action_type: 'admin.user.view_support' });
  });

  it('404: 対象ユーザーがいないときは記録しない', async () => {
    setup({ target: { data: null, error: null } });

    const res = await call();

    expect(res.status).toBe(404);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });

  it('500: 対象の取得に失敗したときも記録しない (情報を返していない)', async () => {
    setup({ target: { data: null, error: { message: 'db down' } } });

    const res = await call();

    expect(res.status).toBe(500);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });

  it('INSERT が失敗しても 200 のまま返し、db-logger に error を残す', async () => {
    setup({ auditInsert: INSERT_FAILED });

    const res = await call();

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.user.id).toBe(TARGET_ID);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe('api/support/users/[id] GET');
    expect(mockLoggerError.mock.calls[0][3]).toMatchObject({
      action_type: 'admin.user.view_support',
      target_id: TARGET_ID,
    });
  });

  it('401: 未認証のときは何も記録しない', async () => {
    setup({ actor: null });

    const res = await call();

    expect(res.status).toBe(401);
    expect(userScopedClient.inserts).toHaveLength(0);
  });

  it('403: 運営ロールが無いときは何も記録しない', async () => {
    setup({ actorRoles: ['user'] });

    const res = await call();

    expect(res.status).toBe(403);
    expect(userScopedClient.inserts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / POST /api/support/users/[id]/notes
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/support/users/[id]/notes -> admin.user.view_notes', () => {
  const noteRow = {
    id: NOTE_ID,
    note: SECRET_NOTE,
    created_at: '2026-10-01T00:00:00Z',
    admin_id: ADMIN_ID,
    user_profiles: { nickname: '担当者' },
  };

  function setup(opts: { notes?: unknown[]; auditInsert?: QueryResult; actorRoles?: string[] } = {}) {
    userScopedClient = makeClient(
      {
        user_profiles: [{ data: { roles: opts.actorRoles ?? ['support'] }, error: null }],
        admin_user_notes: [{ data: opts.notes ?? [noteRow], error: null }],
        admin_audit_logs: [opts.auditInsert ?? INSERT_OK],
      },
      { id: SUPPORT_ID },
    );
  }

  const call = (headers: Record<string, string> = {}) =>
    supportNotesRoute.GET(get(`http://localhost/api/support/users/${TARGET_ID}/notes`, headers), {
      params: { id: TARGET_ID },
    });

  it('200: ノートを返したとき閲覧を 1 行記録する (actor / target / action)', async () => {
    setup();

    const res = await call({ 'x-forwarded-for': '198.51.100.30' });

    expect(res.status).toBe(200);
    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: SUPPORT_ID,
      action_type: 'admin.user.view_notes',
      target_id: TARGET_ID,
      target_type: 'user',
      severity: 'info',
      ip_address: '198.51.100.30',
    });
  });

  it('details は項目名だけ (ノート本文は入れない)', async () => {
    setup();

    const res = await call();
    const body = await json(res);

    const [row] = userScopedClient.auditRows();
    expect(row.details).toEqual({ viewed_fields: Object.keys(body.notes[0]) });
    expect(body.notes[0].note).toBe(SECRET_NOTE);
    expectNoValuesIn(row.details, SECRET_NOTE);
  });

  it('ノートが 0 件のときは何も開示していないので記録しない', async () => {
    setup({ notes: [] });

    const res = await call();

    expect(res.status).toBe(200);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });

  it('INSERT が失敗しても 200 のまま返し、db-logger に error を残す', async () => {
    setup({ auditInsert: INSERT_FAILED });

    const res = await call();

    expect(res.status).toBe(200);
    expect((await json(res)).notes).toHaveLength(1);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it('403: 運営ロールが無いときは何も記録しない', async () => {
    setup({ actorRoles: ['user'] });

    const res = await call();

    expect(res.status).toBe(403);
    expect(userScopedClient.inserts).toHaveLength(0);
  });
});

describe('POST /api/support/users/[id]/notes -> admin.user.note_add', () => {
  function setup(auditInsert: QueryResult = INSERT_OK) {
    userScopedClient = makeClient(
      {
        // 1 回目は閲覧者のロール確認、2 回目が対象ユーザーの存在確認
        user_profiles: [
          { data: { roles: ['support'] }, error: null },
          { data: { id: TARGET_ID }, error: null },
        ],
        admin_user_notes: [{ data: { id: NOTE_ID, note: SECRET_NOTE, created_at: '2026-10-01T00:00:00Z' }, error: null }],
        admin_audit_logs: [auditInsert],
      },
      { id: SUPPORT_ID },
    );
  }

  const call = (body: unknown = { note: SECRET_NOTE }, headers: Record<string, string> = {}) =>
    supportNotesRoute.POST(
      new Request(`http://localhost/api/support/users/${TARGET_ID}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      { params: { id: TARGET_ID } },
    );

  it('ノート追加を actor_id で記録する (存在しない列 admin_id は使わない)', async () => {
    setup();

    const res = await call(undefined, { 'x-forwarded-for': '198.51.100.40, 10.0.0.1' });

    expect(res.status).toBe(200);
    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: SUPPORT_ID,
      action_type: 'admin.user.note_add',
      target_id: TARGET_ID,
      target_type: 'user',
      severity: 'info',
      details: { note_id: NOTE_ID },
      // 複数 IP のまま渡すと inet 列への INSERT が失敗する
      ip_address: '198.51.100.40',
    });
    expect(rows[0]).not.toHaveProperty('admin_id');
    expectNoValuesIn(rows[0].details, SECRET_NOTE);
  });

  it('監査ログの INSERT が失敗してもノート追加は成功のまま、失敗を db-logger に残す (以前は黙って失敗していた)', async () => {
    setup(INSERT_FAILED);

    const res = await call();

    expect(res.status).toBe(200);
    expect((await json(res)).success).toBe(true);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe('api/support/users/[id]/notes POST');
    expect(mockLoggerError.mock.calls[0][3]).toMatchObject({ action_type: 'admin.user.note_add', actor_id: SUPPORT_ID });
  });

  it('400: ノートが空のときは記録しない', async () => {
    setup();

    const res = await call({ note: '   ' });

    expect(res.status).toBe(400);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/support/tickets/[id]
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/support/tickets/[id] -> admin.support.ticket.view', () => {
  const ticket = {
    id: TICKET_ID,
    user_id: TARGET_ID,
    subject: SECRET_SUBJECT,
    category: 'account',
    priority: 'medium',
    status: 'open',
    assignee_id: null,
    first_response_at: null,
    resolved_at: null,
    closed_at: null,
    organization_id: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  };
  const messages = [
    { id: 'm1', ticket_id: TICKET_ID, sender_id: TARGET_ID, is_internal: false, body: SECRET_BODY, attachments: [], created_at: '2026-10-01T00:00:00Z' },
  ];

  function setup(opts: { ticketResult?: QueryResult; auditInsert?: QueryResult } = {}) {
    userScopedClient = makeClient({
      support_tickets: [opts.ticketResult ?? { data: ticket, error: null }],
      support_ticket_messages: [{ data: messages, error: null }],
      admin_audit_logs: [opts.auditInsert ?? INSERT_OK],
    });
  }

  const call = (headers: Record<string, string> = {}) =>
    ticketRoute.GET(get(`http://localhost/api/admin/support/tickets/${TICKET_ID}`, headers) as never, {
      params: { id: TICKET_ID },
    });

  it('200: 閲覧を 1 行記録する。対象は「情報を見られた本人 (チケットを作ったユーザー)」', async () => {
    mockRequireRole.mockResolvedValue(supportActor);
    setup();

    const res = await call({ 'x-forwarded-for': '192.0.2.10', 'user-agent': 'AdminConsole/1.0' });

    expect(res.status).toBe(200);
    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: SUPPORT_ID,
      action_type: 'admin.support.ticket.view',
      target_id: TARGET_ID,
      target_type: 'user',
      severity: 'info',
      ip_address: '192.0.2.10',
      user_agent: 'AdminConsole/1.0',
    });
  });

  it('details はチケット ID と項目名だけ (件名・本文の値は入れない)', async () => {
    setup();

    const res = await call();
    const body = await json(res);

    const [row] = userScopedClient.auditRows();
    expect(row.details).toEqual({ ticket_id: TICKET_ID, viewed_fields: Object.keys(body.data) });
    expect((row.details as { viewed_fields: string[] }).viewed_fields).toEqual(
      expect.arrayContaining(['subject', 'messages']),
    );
    expect(body.data.subject).toBe(SECRET_SUBJECT);
    expectNoValuesIn(row.details, SECRET_SUBJECT, SECRET_BODY);
  });

  it('404: チケットが無いときは記録しない', async () => {
    setup({ ticketResult: { data: null, error: { message: 'no rows' } } });

    const res = await call();

    expect(res.status).toBe(404);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });

  it('INSERT が失敗しても 200 のまま返し、db-logger に error を残す', async () => {
    setup({ auditInsert: INSERT_FAILED });

    const res = await call();

    expect(res.status).toBe(200);
    expect((await json(res)).data.id).toBe(TICKET_ID);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe('api/admin/support/tickets/[id] GET');
    expect(mockLoggerError.mock.calls[0][3]).toMatchObject({
      action_type: 'admin.support.ticket.view',
      target_id: TARGET_ID,
    });
  });

  it('401 / 403: 権限が無いときは何も記録しない', async () => {
    setup();

    mockRequireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    expect((await call()).status).toBe(401);

    mockRequireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED'));
    expect((await call()).status).toBe(403);

    expect(userScopedClient.inserts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/support/tickets/[id]/messages
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/support/tickets/[id]/messages -> admin.support.ticket.view_messages', () => {
  const messages = [
    { id: 'm1', ticket_id: TICKET_ID, sender_id: TARGET_ID, is_internal: false, body: SECRET_BODY, attachments: [], created_at: '2026-10-01T00:00:00Z' },
  ];

  function setup(opts: {
    messagesResult?: QueryResult;
    ownerResult?: QueryResult;
    auditInsert?: QueryResult;
  } = {}) {
    userScopedClient = makeClient({
      support_ticket_messages: [opts.messagesResult ?? { data: messages, error: null }],
      support_tickets: [opts.ownerResult ?? { data: { user_id: TARGET_ID }, error: null }],
      admin_audit_logs: [opts.auditInsert ?? INSERT_OK],
    });
  }

  const call = (headers: Record<string, string> = {}) =>
    ticketMessagesRoute.GET(get(`http://localhost/api/admin/support/tickets/${TICKET_ID}/messages`, headers) as never, {
      params: { id: TICKET_ID },
    });

  it('200: メッセージを返したとき閲覧を 1 行記録する。対象はチケットを作ったユーザー', async () => {
    mockRequireRole.mockResolvedValue(supportActor);
    setup();

    const res = await call({ 'x-forwarded-for': '192.0.2.11' });

    expect(res.status).toBe(200);
    const rows = userScopedClient.auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: SUPPORT_ID,
      action_type: 'admin.support.ticket.view_messages',
      target_id: TARGET_ID,
      target_type: 'user',
      severity: 'info',
      ip_address: '192.0.2.11',
    });
  });

  it('details はチケット ID と項目名だけ (メッセージ本文は入れない)', async () => {
    setup();

    const res = await call();
    const body = await json(res);

    const [row] = userScopedClient.auditRows();
    expect(row.details).toEqual({ ticket_id: TICKET_ID, viewed_fields: Object.keys(body.data[0]) });
    expect(body.data[0].body).toBe(SECRET_BODY);
    expectNoValuesIn(row.details, SECRET_BODY);
  });

  it('チケットの持ち主を引けなかったときは、チケット自体を対象にして記録を残す', async () => {
    setup({ ownerResult: { data: null, error: null } });

    const res = await call();

    expect(res.status).toBe(200);
    expect(userScopedClient.auditRows()[0]).toMatchObject({
      action_type: 'admin.support.ticket.view_messages',
      target_id: TICKET_ID,
      target_type: 'support_ticket',
    });
  });

  it('持ち主の取得が例外になっても閲覧は止めず、チケット自体を対象にして記録する', async () => {
    setup({ ownerResult: { rejects: new Error('connection reset') } });

    const res = await call();

    expect(res.status).toBe(200);
    expect(userScopedClient.auditRows()[0]).toMatchObject({
      target_id: TICKET_ID,
      target_type: 'support_ticket',
    });
  });

  it('メッセージが 0 件のときは何も開示していないので記録しない', async () => {
    setup({ messagesResult: { data: [], error: null } });

    const res = await call();

    expect(res.status).toBe(200);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });

  it('500: メッセージの取得に失敗したときは記録しない', async () => {
    setup({ messagesResult: { data: null, error: { message: 'db down' } } });

    const res = await call();

    expect(res.status).toBe(500);
    expect(userScopedClient.auditRows()).toHaveLength(0);
  });

  it('INSERT が失敗しても 200 のまま返し、db-logger に error を残す', async () => {
    setup({ auditInsert: INSERT_FAILED });

    const res = await call();

    expect(res.status).toBe(200);
    expect((await json(res)).data).toHaveLength(1);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][0]).toBe('api/admin/support/tickets/[id]/messages GET');
  });

  it('401 / 403: 権限が無いときは何も記録しない', async () => {
    setup();

    mockRequireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    expect((await call()).status).toBe(401);

    mockRequireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED'));
    expect((await call()).status).toBe(403);

    expect(userScopedClient.inserts).toHaveLength(0);
  });
});
