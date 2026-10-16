/**
 * #1178 / #1702 段 C: GET /api/admin/data-requests, GET / PATCH /api/admin/data-requests/[id] のテスト
 * (設計 docs/design/cross/15-data-subject-requests.md §7.4・§11・§13・§15)
 *
 * 確かめること:
 *  - 認可: admin / super_admin だけが通る (DSR_OPERATOR_ROLES)。support・content_moderator は 403、未ログインは 401。
 *    認可に落ちた要求は data_subject_requests にも admin_audit_logs にも触れない
 *  - 一覧: 本人のセッションの client で DSR_ADMIN_LIST_COLUMNS を読む (service_role で表を読まない)。
 *    status / request_type / overdue の絞り込み・並び (due_at 昇順・NULL は最後 → created_at 降順 → id 降順)・416 は空のページ。
 *    0 件は監査なし、1 件以上で admin.dsr.list を 1 行 (details は条件と件数だけ)
 *  - 詳細: service_role の client で DSR_ADMIN_COLUMNS を読み、admin_notes と請求者 (メールアドレス) を返す。
 *    200 で admin.dsr.view を 1 行 (viewed_fields だけ)、404 は監査なし、退会済みは requester null・target_type data_subject_request
 *  - PATCH: 読み直しも UPDATE も service_role。428 / 412 / 409 CONFLICT_STALE_DATA / 409 DSR_INVALID_TRANSITION / 422。
 *    状態を変えない更新 (応答・内部メモだけ) は受付済み・対応中でだけ通る。変更が無ければ書き込まない。
 *    対応済み / 対応できずで dsr_resolved を送る (退会済みは送らない)。監査は 200 のときだけ (status_from / status_to)
 *  - 監査の行の ip_address は x-forwarded-for の先頭、user_agent が入る (recordAdminAudit に request を渡している)。
 *    記録に失敗しても応答は変わらない。admin_audit_logs へは recordAdminAudit (本人のセッション) からだけ書く
 *
 * 認可は本物の requireRole、監査ログの記録は本物の recordAdminAudit、DB の読み書きは本物の service.ts を通す。
 * 外との境界である Supabase (RLS と列の GRANT を真似たメモリ上の偽物) と、メールの送信 (sendEmail) だけを差し替える。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DsrAdminDetailDto, DsrAdminSummaryDto } from '@/lib/data-subject-requests/core';

type Row = Record<string, unknown>;
type ClientKind = 'session' | 'admin';
type TableName = 'data_subject_requests' | 'user_profiles' | 'admin_audit_logs';

// ─────────────────────────────────────────────────────────────────────────────
// Supabase の偽物 (PostgREST と、関係する RLS・列の GRANT を真似る)
// ─────────────────────────────────────────────────────────────────────────────

/** data_subject_requests_select_operator が全行を見せるロール (migration と同じ) */
const DSR_RLS_OPERATOR_ROLES = ['admin', 'super_admin'];
/** audit_logs_insert_admins が INSERT を許すロール */
const AUDIT_INSERT_ROLES = ['admin', 'super_admin', 'support'];
/** authenticated に GRANT していない列 (migration の列の GRANT の外) */
const UNGRANTED_COLUMNS = ['admin_notes', 'verification_token_hash'];

interface Call {
  client: ClientKind;
  table: TableName;
  kind: 'select' | 'update' | 'insert';
  columns: string;
  filters: Array<[string, string, unknown]>;
  orders: Array<{ column: string; ascending: boolean; nullsFirst: boolean }>;
  range: [number, number] | null;
  payload: Row | null;
}

interface World {
  actor: { id: string; roles: string[] } | null;
  tables: Record<TableName, Row[]>;
  /** auth.users の登録アドレス (rpc admin_user_emails と auth.admin.getUserById が読む) */
  authEmails: Record<string, string>;
  /** `${client}:${table}.${kind}` または `${table}.${kind}` ごとに強制的に返すエラー */
  failures: Record<string, { code?: string; message: string; status?: number }>;
  /** UPDATE を実行する直前に呼ぶ (読み直しと UPDATE の間に別の更新が入った状況を作る) */
  beforeUpdate: (() => void) | null;
  calls: Call[];
}

const world: World = {
  actor: null,
  tables: { data_subject_requests: [], user_profiles: [], admin_audit_logs: [] },
  authEmails: {},
  failures: {},
  beforeUpdate: null,
  calls: [],
};

/** UPDATE のたびにトリガーが入れる updated_at (呼ぶたびに進める) */
let triggerClock = 0;
function nextTriggerUpdatedAt(): string {
  triggerClock += 1;
  return new Date(Date.UTC(2026, 9, 16, 1, 0, triggerClock)).toISOString();
}

function hasRole(roles: string[]): boolean {
  return !!world.actor && world.actor.roles.some((role) => roles.includes(role));
}

function rlsAllows(client: ClientKind, table: TableName, kind: Call['kind'], row: Row): boolean {
  if (client === 'admin') return true;
  const actor = world.actor;
  if (!actor) return false;
  if (table === 'user_profiles') return kind === 'select' && row.id === actor.id;
  if (table === 'data_subject_requests') {
    // select_self と select_operator の OR。書き込みのポリシーは無い
    return kind === 'select' && (row.user_id === actor.id || hasRole(DSR_RLS_OPERATOR_ROLES));
  }
  if (table === 'admin_audit_logs') return kind === 'insert' && hasRole(AUDIT_INSERT_ROLES) && row.actor_id === actor.id;
  return false;
}

function parseColumns(columns: string): string[] {
  return columns
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean);
}

function project(row: Row, columns: string): Row {
  if (columns === '' || columns === '*') return { ...row };
  const out: Row = {};
  for (const column of parseColumns(columns)) out[column] = row[column];
  return out;
}

function compareValues(a: unknown, b: unknown, ascending: boolean, nullsFirst: boolean): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return nullsFirst ? -1 : 1;
  if (bNull) return nullsFirst ? 1 : -1;
  if (a === b) return 0;
  return (String(a) < String(b) ? -1 : 1) * (ascending ? 1 : -1);
}

function createBuilder(client: ClientKind, table: TableName) {
  const q = {
    kind: 'select' as Call['kind'],
    columns: '',
    countExact: false,
    filters: [] as Array<(row: Row) => boolean>,
    filterLog: [] as Array<[string, string, unknown]>,
    orders: [] as Call['orders'],
    range: null as [number, number] | null,
    payload: null as Row | null,
  };

  const execute = async (mode: 'many' | 'maybe' | 'one') => {
    world.calls.push({
      client,
      table,
      kind: q.kind,
      columns: q.columns,
      filters: q.filterLog,
      orders: q.orders,
      range: q.range,
      payload: q.payload,
    });

    const forced = world.failures[`${client}:${table}.${q.kind}`] ?? world.failures[`${table}.${q.kind}`];
    if (forced) {
      const { status, ...error } = forced;
      return { data: null, error, count: null, status: status ?? 400 };
    }

    // 列の GRANT: authenticated は admin_notes / hash / * を読めない (42501)
    if (client === 'session' && table === 'data_subject_requests') {
      const requested = q.columns === '' || q.columns === '*' ? ['*'] : parseColumns(q.columns);
      if (requested.includes('*') || requested.some((column) => UNGRANTED_COLUMNS.includes(column))) {
        return { data: null, error: { code: '42501', message: 'permission denied' }, count: null, status: 401 };
      }
      if (q.kind !== 'select') {
        return { data: null, error: { code: '42501', message: 'permission denied' }, count: null, status: 401 };
      }
    }

    if (q.kind === 'insert') {
      const row = { ...q.payload };
      if (!rlsAllows(client, table, 'insert', row)) {
        return { data: null, error: { code: '42501', message: 'new row violates row-level security policy' }, count: null };
      }
      world.tables[table].push(row);
      return { data: null, error: null, count: null };
    }

    if (q.kind === 'update') world.beforeUpdate?.();

    let rows = world.tables[table].filter((row) => rlsAllows(client, table, q.kind, row) && q.filters.every((f) => f(row)));

    if (q.kind === 'update') {
      for (const row of rows) Object.assign(row, q.payload, { updated_at: nextTriggerUpdatedAt() });
    } else {
      for (const { column, ascending, nullsFirst } of [...q.orders].reverse()) {
        rows = [...rows].sort((a, b) => compareValues(a[column], b[column], ascending, nullsFirst));
      }
    }

    const total = rows.length;
    if (q.range) {
      const [from, to] = q.range;
      if (q.countExact && from > total) {
        // 実物 (ローカルの Supabase) は 416 の本文が途中で切れ、code が空になる
        return { data: null, error: { code: '', message: '{"', details: '', hint: '' }, count: null, status: 416 };
      }
      rows = rows.slice(from, to + 1);
    }

    const data = rows.map((row) => project(row, q.columns));
    if (mode === 'many') return { data, error: null, count: q.countExact ? total : null, status: 200 };
    if (data.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows returned' }, count: null };
    if (mode === 'one' && data.length === 0) {
      return { data: null, error: { code: 'PGRST116', message: 'no rows returned' }, count: null };
    }
    return { data: data[0] ?? null, error: null, count: null };
  };

  const builder: Record<string, unknown> = {
    select: (columns: string, options?: { count?: string }) => {
      q.columns = columns;
      if (options?.count === 'exact') q.countExact = true;
      return builder;
    },
    eq: (column: string, value: unknown) => {
      q.filters.push((row) => row[column] === value);
      q.filterLog.push([column, 'eq', value]);
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      q.filters.push((row) => values.includes(row[column]));
      q.filterLog.push([column, 'in', values]);
      return builder;
    },
    lt: (column: string, value: unknown) => {
      q.filters.push((row) => row[column] !== null && row[column] !== undefined && String(row[column]) < String(value));
      q.filterLog.push([column, 'lt', value]);
      return builder;
    },
    order: (column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) => {
      const ascending = options?.ascending !== false;
      // PostgreSQL の既定: 昇順は NULL が最後、降順は NULL が先
      q.orders.push({ column, ascending, nullsFirst: options?.nullsFirst ?? !ascending });
      return builder;
    },
    range: (from: number, to: number) => {
      q.range = [from, to];
      return builder;
    },
    update: (payload: Row) => {
      q.kind = 'update';
      q.payload = payload;
      return builder;
    },
    insert: (payload: Row) => {
      q.kind = 'insert';
      q.payload = payload;
      return builder;
    },
    single: () => execute('one'),
    maybeSingle: () => execute('maybe'),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      execute('many').then(resolve, reject),
  };
  return builder;
}

function createClientFake(client: ClientKind) {
  return {
    auth: {
      getUser: async () =>
        client === 'session' && world.actor
          ? { data: { user: { id: world.actor.id, email: `${world.actor.id}@example.com` } }, error: null }
          : { data: { user: null }, error: { message: 'Auth session missing!' } },
      admin: {
        getUserById: async (id: string) => {
          if (client !== 'admin') throw new Error('fake: auth.admin は service_role だけ');
          const email = world.authEmails[id];
          return email ? { data: { user: { id, email } }, error: null } : { data: { user: null }, error: { message: 'not found' } };
        },
      },
    },
    rpc: async (name: string, args: { p_ids: string[] }) => {
      if (client !== 'admin' || name !== 'admin_user_emails') throw new Error(`fake: 想定していない rpc ${client}:${name}`);
      return {
        data: args.p_ids.filter((id) => world.authEmails[id]).map((id) => ({ user_id: id, email: world.authEmails[id] })),
        error: null,
      };
    },
    from: (table: string) => {
      if (!(table in world.tables)) throw new Error(`fake: 想定していないテーブル ${table}`);
      return createBuilder(client, table as TableName);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// モック (外との境界だけ)
// ─────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => createClientFake('session'),
  getSupabaseAdmin: () => createClientFake('admin'),
}));

vi.mock('@/lib/emails/send', () => ({
  sendEmail: (...args: unknown[]) => mocks.sendEmail(...args),
}));

vi.mock('@/lib/db-logger', () => {
  const make = (): Record<string, unknown> => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.logError,
    withUser: () => make(),
  });
  return { createLogger: () => make(), generateRequestId: () => 'req_test' };
});

import { GET as listGET } from '@/app/api/admin/data-requests/route';
import { GET as detailGET, PATCH } from '@/app/api/admin/data-requests/[id]/route';
import {
  DSR_ADMIN_COLUMNS,
  DSR_ADMIN_LIST_COLUMNS,
  DSR_ADMIN_LIST_LIMITS,
} from '@/lib/data-subject-requests/core';

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_ID = 'c0000000-0000-4000-8000-000000000001';
const SUPER_ADMIN_ID = 'c0000000-0000-4000-8000-000000000002';
const SUPPORT_ID = 'c0000000-0000-4000-8000-000000000003';
const MODERATOR_ID = 'c0000000-0000-4000-8000-000000000004';
const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000005';
const CUSTOMER2_ID = 'c0000000-0000-4000-8000-000000000006';

const R_RECEIVED = 'a0000000-0000-4000-8000-000000000001';
const R_OVERDUE = 'a0000000-0000-4000-8000-000000000002';
const R_PENDING = 'a0000000-0000-4000-8000-000000000003';
const R_FULFILLED = 'a0000000-0000-4000-8000-000000000004';
const R_DELETED = 'a0000000-0000-4000-8000-000000000005';
const MISSING_ID = 'a0000000-0000-4000-8000-0000000000ff';

const NOW = new Date('2026-10-16T00:00:00.000Z');
const CUSTOMER_EMAIL = 'taro@example.com';
const SECRET_DETAILS = '電話番号 090-0000-0000 の記録を開示してください';
const SECRET_ADMIN_NOTE = '内部メモ: 前回も同じ請求あり';
const SECRET_HASH = 'f'.repeat(64);
const USER_AGENT = 'Mozilla/5.0 (dsr-admin-test)';
const RECEIVED_UPDATED_AT = '2026-10-01T00:00:00.000Z';

function dsrRow(overrides: Row): Row {
  return {
    id: R_RECEIVED,
    user_id: CUSTOMER_ID,
    request_type: 'disclosure',
    status: 'received',
    details: SECRET_DETAILS,
    verification_method: 'email_link',
    verification_token_hash: null,
    verification_sent_at: '2026-10-01T00:00:00.000Z',
    verification_expires_at: '2026-10-02T00:00:00.000Z',
    verification_send_count: 1,
    verified_at: '2026-10-01T00:00:00.000Z',
    due_at: '2026-10-31T00:00:00.000Z',
    response_note: null,
    admin_notes: SECRET_ADMIN_NOTE,
    resolved_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: RECEIVED_UPDATED_AT,
    ...overrides,
  };
}

function seed() {
  world.tables.data_subject_requests = [
    dsrRow({ id: R_RECEIVED }),
    dsrRow({
      id: R_OVERDUE,
      request_type: 'correction',
      status: 'in_progress',
      verified_at: '2026-09-01T00:00:00.000Z',
      due_at: '2026-10-01T00:00:00.000Z',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-02T00:00:00.000Z',
    }),
    dsrRow({
      id: R_PENDING,
      request_type: 'erasure',
      status: 'pending_verification',
      verification_token_hash: SECRET_HASH,
      verification_sent_at: '2026-10-15T00:00:00.000Z',
      verification_expires_at: '2026-10-16T00:00:00.000Z',
      verified_at: null,
      due_at: null,
      admin_notes: null,
      created_at: '2026-10-15T00:00:00.000Z',
      updated_at: '2026-10-15T00:00:00.000Z',
    }),
    dsrRow({
      id: R_FULFILLED,
      user_id: CUSTOMER2_ID,
      request_type: 'suspension',
      status: 'fulfilled',
      due_at: '2026-10-20T00:00:00.000Z',
      response_note: '通知の設定を止めました',
      resolved_at: '2026-10-05T00:00:00.000Z',
      created_at: '2026-09-20T00:00:00.000Z',
      updated_at: '2026-10-05T00:00:00.000Z',
    }),
    dsrRow({
      id: R_DELETED,
      user_id: null,
      request_type: 'erasure',
      status: 'received',
      due_at: '2026-11-01T00:00:00.000Z',
      created_at: '2026-10-02T00:00:00.000Z',
      updated_at: '2026-10-02T00:00:00.000Z',
    }),
  ];
  world.tables.user_profiles = [
    { id: ADMIN_ID, nickname: '管理者', roles: ['admin'], organization_id: null, frozen_at: null, unban_at: null },
    { id: SUPER_ADMIN_ID, nickname: 'スーパー', roles: ['super_admin'], organization_id: null, frozen_at: null, unban_at: null },
    { id: SUPPORT_ID, nickname: 'サポート', roles: ['support'], organization_id: null, frozen_at: null, unban_at: null },
    { id: MODERATOR_ID, nickname: 'モデレーター', roles: ['content_moderator'], organization_id: null, frozen_at: null, unban_at: null },
    { id: CUSTOMER_ID, nickname: 'たろう', roles: ['user'], organization_id: null, frozen_at: null, unban_at: null },
    { id: CUSTOMER2_ID, nickname: 'はなこ', roles: ['user'], organization_id: null, frozen_at: null, unban_at: null },
  ];
  world.tables.admin_audit_logs = [];
  world.authEmails = { [CUSTOMER_ID]: CUSTOMER_EMAIL, [CUSTOMER2_ID]: 'hanako@example.com' };
  world.failures = {};
  world.beforeUpdate = null;
  world.calls = [];
}

function loginAs(id: string, roles: string[]) {
  world.actor = { id, roles };
  const profile = world.tables.user_profiles.find((p) => p.id === id);
  if (profile) profile.roles = roles;
}

function listRequest(query = '', headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/admin/data-requests${query}`, { headers });
}
function detailRequest(id: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/admin/data-requests/${id}`, { headers });
}
function patchRequest(id: string, body: unknown, ifUnmodifiedSince: string | null, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/admin/data-requests/${id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(ifUnmodifiedSince === null ? {} : { 'If-Unmodified-Since': ifUnmodifiedSince }),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}
interface ListBody {
  data: DsrAdminSummaryDto[];
  meta: { total: number | null; page: number; per_page: number };
}
interface DetailBody {
  data: DsrAdminDetailDto;
}
const readJson = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const dsrCalls = () => world.calls.filter((c) => c.table === 'data_subject_requests');
const stored = (id: string) => world.tables.data_subject_requests.find((r) => r.id === id)!;
const audits = () => world.tables.admin_audit_logs;
const resolvedEmails = () =>
  mocks.sendEmail.mock.calls.filter(([envelope]) => (envelope as { template?: string }).template === 'dsr_resolved');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.logError.mockClear();
  mocks.sendEmail.mockReset();
  mocks.sendEmail.mockResolvedValue({ ok: true });
  triggerClock = 0;
  seed();
  loginAs(ADMIN_ID, ['admin']);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// 認可 (本物の requireRole)
// ─────────────────────────────────────────────────────────────────────────────

const HANDLERS: Array<{ name: string; call: () => Promise<Response> }> = [
  { name: 'GET /api/admin/data-requests', call: () => listGET(listRequest()) },
  { name: 'GET /api/admin/data-requests/[id]', call: () => detailGET(detailRequest(R_RECEIVED), ctx(R_RECEIVED)) },
  {
    name: 'PATCH /api/admin/data-requests/[id]',
    call: () =>
      PATCH(patchRequest(R_RECEIVED, { status: 'fulfilled', response_note: '応答' }, RECEIVED_UPDATED_AT), ctx(R_RECEIVED)),
  },
];

describe.each(HANDLERS)('認可: $name', ({ call }) => {
  it('未ログインは 401 AUTH_UNAUTHENTICATED で、請求の表にも監査ログにも触れない', async () => {
    world.actor = null;
    const res = await call();
    expect(res.status).toBe(401);
    expect((await readJson<ErrorBody>(res)).error.code).toBe('AUTH_UNAUTHENTICATED');
    expect(dsrCalls()).toEqual([]);
    expect(audits()).toEqual([]);
    expect(stored(R_RECEIVED).status).toBe('received');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['support (登録メールアドレスを見られないロール。§3.2)', SUPPORT_ID, ['support']],
    ['content_moderator', MODERATOR_ID, ['content_moderator']],
    ['一般ユーザー', CUSTOMER_ID, ['user']],
  ])('%s は 403 OP_PERMISSION_DENIED で、請求の表にも監査ログにも触れない', async (_label, id, roles) => {
    loginAs(id, roles);
    const res = await call();
    expect(res.status).toBe(403);
    expect((await readJson<ErrorBody>(res)).error.code).toBe('OP_PERMISSION_DENIED');
    expect(dsrCalls()).toEqual([]);
    expect(audits()).toEqual([]);
    expect(stored(R_RECEIVED).status).toBe('received');
  });

  it.each([
    ['admin', ADMIN_ID, ['admin']],
    ['super_admin', SUPER_ADMIN_ID, ['super_admin']],
  ])('%s は通る (200)', async (_label, id, roles) => {
    loginAs(id, roles);
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 一覧
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/data-requests (一覧)', () => {
  it('本人のセッションの client で DSR_ADMIN_LIST_COLUMNS を読む (service_role で表を読まない)', async () => {
    const res = await listGET(listRequest());
    expect(res.status).toBe(200);
    expect(dsrCalls()).toHaveLength(1);
    expect(dsrCalls()[0]).toMatchObject({ client: 'session', kind: 'select', columns: DSR_ADMIN_LIST_COLUMNS });
  });

  it('並びは due_at 昇順 (NULL は最後) → created_at 降順 → id 降順。meta に total / page / per_page', async () => {
    const body = await readJson<ListBody>(await listGET(listRequest()));
    expect(body.data.map((r) => r.id)).toEqual([R_OVERDUE, R_FULFILLED, R_RECEIVED, R_DELETED, R_PENDING]);
    expect(body.meta).toEqual({ total: 5, page: 1, per_page: DSR_ADMIN_LIST_LIMITS.default });
    expect(dsrCalls()[0].orders).toEqual([
      { column: 'due_at', ascending: true, nullsFirst: false },
      { column: 'created_at', ascending: false, nullsFirst: true },
      { column: 'id', ascending: false, nullsFirst: true },
    ]);
  });

  it('同じ due_at の行は created_at 降順 → id 降順で並ぶ', async () => {
    world.tables.data_subject_requests = [
      dsrRow({ id: R_RECEIVED, user_id: CUSTOMER_ID, due_at: '2026-10-31T00:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z' }),
      dsrRow({ id: R_OVERDUE, user_id: CUSTOMER2_ID, due_at: '2026-10-31T00:00:00.000Z', created_at: '2026-10-03T00:00:00.000Z' }),
      dsrRow({ id: R_FULFILLED, user_id: null, due_at: '2026-10-31T00:00:00.000Z', created_at: '2026-10-03T00:00:00.000Z' }),
    ];
    const body = await readJson<ListBody>(await listGET(listRequest()));
    expect(body.data.map((r) => r.id)).toEqual([R_FULFILLED, R_OVERDUE, R_RECEIVED]);
  });

  it('概要だけを返す (請求の内容・応答・内部メモ・hash を返さない)。請求者はニックネーム、退会済みは null', async () => {
    const res = await listGET(listRequest());
    const text = await res.clone().text();
    expect(text).not.toContain(SECRET_DETAILS);
    expect(text).not.toContain(SECRET_ADMIN_NOTE);
    expect(text).not.toContain(SECRET_HASH);
    const body = await readJson<ListBody>(res);
    expect(Object.keys(body.data[0]).sort()).toEqual(
      ['created_at', 'due_at', 'id', 'overdue', 'request_type', 'requester_nickname', 'resolved_at', 'status', 'updated_at', 'user_id', 'verified_at'].sort(),
    );
    const byId = new Map(body.data.map((r) => [r.id, r]));
    expect(byId.get(R_RECEIVED)?.requester_nickname).toBe('たろう');
    expect(byId.get(R_DELETED)).toMatchObject({ user_id: null, requester_nickname: null });
  });

  it('overdue は受付済み / 対応中で due_at が過ぎているときだけ true', async () => {
    const body = await readJson<ListBody>(await listGET(listRequest()));
    const overdue = body.data.filter((r) => r.overdue).map((r) => r.id);
    expect(overdue).toEqual([R_OVERDUE]);
  });

  it('status で絞る', async () => {
    const body = await readJson<ListBody>(await listGET(listRequest('?status=received')));
    expect(body.data.map((r) => r.id).sort()).toEqual([R_DELETED, R_RECEIVED].sort());
    expect(dsrCalls()[0].filters).toContainEqual(['status', 'eq', 'received']);
  });

  it('request_type で絞る', async () => {
    const body = await readJson<ListBody>(await listGET(listRequest('?request_type=erasure')));
    expect(body.data.map((r) => r.id).sort()).toEqual([R_DELETED, R_PENDING].sort());
  });

  it('overdue=1 は受付済み / 対応中かつ due_at < 今に絞る', async () => {
    const body = await readJson<ListBody>(await listGET(listRequest('?overdue=1')));
    expect(body.data.map((r) => r.id)).toEqual([R_OVERDUE]);
    expect(dsrCalls()[0].filters).toEqual([
      ['status', 'in', ['received', 'in_progress']],
      ['due_at', 'lt', NOW.toISOString()],
    ]);
  });

  it('status と overdue を同時に指定したら両方で絞る', async () => {
    const body = await readJson<ListBody>(await listGET(listRequest('?status=received&overdue=1')));
    expect(body.data).toEqual([]);
  });

  it('?status= のように空なら絞り込みなし', async () => {
    const body = await readJson<ListBody>(await listGET(listRequest('?status=&request_type=&overdue=')));
    expect(body.data).toHaveLength(5);
  });

  it.each([
    ['status が未知', '?status=open'],
    ['request_type が未知', '?request_type=delete'],
    ['overdue が 1 以外 (0)', '?overdue=0'],
    ['overdue が 1 以外 (true)', '?overdue=true'],
  ])('%s は 400 VALIDATION_ERROR (nested) で、表に触れない', async (_label, query) => {
    const res = await listGET(listRequest(query));
    expect(res.status).toBe(400);
    const body = await readJson<ErrorBody>(res);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('入力内容を確認してください');
    expect(body.error.details).toBeDefined();
    expect(dsrCalls()).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it('page / per_page を丸める (per_page の上限は DSR_ADMIN_LIST_LIMITS.max)', async () => {
    const body = await readJson<ListBody>(await listGET(listRequest('?page=1&per_page=100000')));
    expect(body.meta.per_page).toBe(DSR_ADMIN_LIST_LIMITS.max);
    expect(dsrCalls()[0].range).toEqual([0, DSR_ADMIN_LIST_LIMITS.max - 1]);
  });

  it('2 ページ目は per_page 件ずらして読む', async () => {
    const body = await readJson<ListBody>(await listGET(listRequest('?page=2&per_page=2')));
    expect(body.data.map((r) => r.id)).toEqual([R_RECEIVED, R_DELETED]);
    expect(body.meta).toEqual({ total: 5, page: 2, per_page: 2 });
  });

  it('件数より後ろのページ (416) は空のページ (total: null) で、監査は残さない', async () => {
    const res = await listGET(listRequest('?page=100&per_page=10'));
    expect(res.status).toBe(200);
    expect(await readJson<ListBody>(res)).toEqual({ data: [], meta: { total: null, page: 100, per_page: 10 } });
    expect(audits()).toEqual([]);
  });

  it('0 件のときは監査を残さない', async () => {
    const res = await listGET(listRequest('?status=rejected'));
    expect((await readJson<ListBody>(res)).data).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it('1 件以上返したら admin.dsr.list を 1 行 (条件と件数だけ。返した行の ID や値は入れない)', async () => {
    await listGET(
      listRequest('?status=received&request_type=disclosure&page=1&per_page=20', {
        'x-forwarded-for': '203.0.113.9, 10.0.0.1',
        'user-agent': USER_AGENT,
      }),
    );
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toEqual({
      actor_id: ADMIN_ID,
      action_type: 'admin.dsr.list',
      target_id: null,
      target_type: 'data_subject_request',
      details: {
        filters: { status: 'received', request_type: 'disclosure', page: 1, per_page: 20 },
        returned_count: 1,
        total: 1,
      },
      severity: 'info',
      ip_address: '203.0.113.9',
      user_agent: USER_AGENT,
    });
    expect(JSON.stringify(audits())).not.toContain(R_RECEIVED);
  });

  it('監査ログの記録に失敗しても一覧は返す', async () => {
    world.failures['admin_audit_logs.insert'] = { code: '42501', message: 'denied' };
    const res = await listGET(listRequest());
    expect(res.status).toBe(200);
    expect((await readJson<ListBody>(res)).data).toHaveLength(5);
  });

  it('DB の読み取りに失敗したら 500 INTERNAL_ERROR (nested。生のエラー文を出さない) で、監査は残さない', async () => {
    world.failures['data_subject_requests.select'] = { code: 'XX000', message: 'raw database failure text' };
    const res = await listGET(listRequest());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('raw database failure text');
    expect(JSON.parse(text).error.code).toBe('INTERNAL_ERROR');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(audits()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 詳細
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/data-requests/[id] (詳細)', () => {
  it('service_role の client で DSR_ADMIN_COLUMNS を読み、内部メモ・請求の内容・請求者 (メールアドレス) を返す', async () => {
    const res = await detailGET(detailRequest(R_RECEIVED), ctx(R_RECEIVED));
    expect(res.status).toBe(200);
    const { data } = await readJson<DetailBody>(res);
    expect(data).toMatchObject({
      id: R_RECEIVED,
      details: SECRET_DETAILS,
      admin_notes: SECRET_ADMIN_NOTE,
      requester_nickname: 'たろう',
      requester: { user_id: CUSTOMER_ID, nickname: 'たろう', email: CUSTOMER_EMAIL },
      overdue: false,
    });
    expect(data).not.toHaveProperty('verification_token_hash');
    const reads = dsrCalls();
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ client: 'admin', kind: 'select', columns: DSR_ADMIN_COLUMNS });
  });

  it('hash を持つ請求でも hash を返さない', async () => {
    const res = await detailGET(detailRequest(R_PENDING), ctx(R_PENDING));
    expect(await res.text()).not.toContain(SECRET_HASH);
  });

  it('200 で admin.dsr.view を 1 行 (対象は本人・viewed_fields だけ・値は入れない)。ip / user_agent も残る', async () => {
    await detailGET(
      detailRequest(R_RECEIVED, { 'x-forwarded-for': '2001:db8::1, 10.0.0.1', 'user-agent': USER_AGENT }),
      ctx(R_RECEIVED),
    );
    expect(audits()).toHaveLength(1);
    const audit = audits()[0];
    expect(audit).toMatchObject({
      actor_id: ADMIN_ID,
      action_type: 'admin.dsr.view',
      target_id: CUSTOMER_ID,
      target_type: 'user',
      severity: 'info',
      ip_address: '2001:db8::1',
      user_agent: USER_AGENT,
    });
    const details = audit.details as { request_id: string; viewed_fields: string[] };
    expect(details.request_id).toBe(R_RECEIVED);
    expect(details.viewed_fields).toContain('admin_notes');
    expect(details.viewed_fields).toContain('requester');
    const text = JSON.stringify(audit);
    expect(text).not.toContain(SECRET_DETAILS);
    expect(text).not.toContain(SECRET_ADMIN_NOTE);
    expect(text).not.toContain(CUSTOMER_EMAIL);
  });

  it('退会済み (user_id が NULL) は requester null・監査の target は請求そのもの', async () => {
    const res = await detailGET(detailRequest(R_DELETED), ctx(R_DELETED));
    expect(res.status).toBe(200);
    const { data } = await readJson<DetailBody>(res);
    expect(data.requester).toBeNull();
    expect(data.requester_nickname).toBeNull();
    expect(audits()[0]).toMatchObject({ target_id: R_DELETED, target_type: 'data_subject_request' });
  });

  it('無い id は 404 NOT_FOUND で、監査は残さない', async () => {
    const res = await detailGET(detailRequest(MISSING_ID), ctx(MISSING_ID));
    expect(res.status).toBe(404);
    expect(await readJson<ErrorBody>(res)).toEqual({ error: { code: 'NOT_FOUND', message: '請求が見つかりません' } });
    expect(audits()).toEqual([]);
  });

  it('id が UUID でなければ 400 VALIDATION_ERROR で、表に触れない', async () => {
    const res = await detailGET(detailRequest('not-a-uuid'), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
    expect((await readJson<ErrorBody>(res)).error.code).toBe('VALIDATION_ERROR');
    expect(dsrCalls()).toEqual([]);
  });

  it('DB の読み取りに失敗したら 500 (404 にしない) で、監査は残さない', async () => {
    world.failures['admin:data_subject_requests.select'] = { code: 'XX000', message: 'raw failure' };
    const res = await detailGET(detailRequest(R_RECEIVED), ctx(R_RECEIVED));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('raw failure');
    expect(audits()).toEqual([]);
  });

  it('監査ログの記録に失敗しても詳細は返す', async () => {
    world.failures['admin_audit_logs.insert'] = { code: '42501', message: 'denied' };
    const res = await detailGET(detailRequest(R_RECEIVED), ctx(R_RECEIVED));
    expect(res.status).toBe(200);
    expect((await readJson<DetailBody>(res)).data.id).toBe(R_RECEIVED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/data-requests/[id] (運営の対応)', () => {
  it('If-Unmodified-Since が無ければ 428 CONFLICT_PRECONDITION_REQUIRED で、書き込みも監査も無い', async () => {
    const res = await PATCH(patchRequest(R_RECEIVED, { status: 'in_progress' }, null), ctx(R_RECEIVED));
    expect(res.status).toBe(428);
    expect((await readJson<ErrorBody>(res)).error.code).toBe('CONFLICT_PRECONDITION_REQUIRED');
    expect(dsrCalls().filter((c) => c.kind === 'update')).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it('If-Unmodified-Since が今の updated_at と違えば 412 CONFLICT_OPTIMISTIC_LOCK', async () => {
    const res = await PATCH(patchRequest(R_RECEIVED, { status: 'in_progress' }, '2026-09-30T00:00:00.000Z'), ctx(R_RECEIVED));
    expect(res.status).toBe(412);
    expect(await readJson<ErrorBody>(res)).toEqual({
      error: { code: 'CONFLICT_OPTIMISTIC_LOCK', message: '別の更新が先に行われました。再読み込みしてください' },
    });
    expect(stored(R_RECEIVED).status).toBe('received');
    expect(audits()).toEqual([]);
  });

  it('読み直しと UPDATE の間に別の更新が入れば UPDATE が 0 行 → 409 CONFLICT_STALE_DATA (監査なし・メールなし)', async () => {
    world.beforeUpdate = () => {
      stored(R_RECEIVED).updated_at = '2026-10-15T23:59:59.000Z';
    };
    const res = await PATCH(
      patchRequest(R_RECEIVED, { status: 'fulfilled', response_note: '応答' }, RECEIVED_UPDATED_AT),
      ctx(R_RECEIVED),
    );
    expect(res.status).toBe(409);
    expect((await readJson<ErrorBody>(res)).error.code).toBe('CONFLICT_STALE_DATA');
    expect(stored(R_RECEIVED).status).toBe('received');
    expect(audits()).toEqual([]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('読み直しも UPDATE も service_role の client (DSR_ADMIN_COLUMNS)。UPDATE の条件に id と updated_at が付く', async () => {
    const res = await PATCH(patchRequest(R_RECEIVED, { status: 'in_progress' }, RECEIVED_UPDATED_AT), ctx(R_RECEIVED));
    expect(res.status).toBe(200);
    const calls = dsrCalls();
    expect(calls.map((c) => [c.client, c.kind, c.columns])).toEqual([
      ['admin', 'select', DSR_ADMIN_COLUMNS],
      ['admin', 'update', DSR_ADMIN_COLUMNS],
    ]);
    expect(calls[1].filters).toEqual([
      ['id', 'eq', R_RECEIVED],
      ['updated_at', 'eq', RECEIVED_UPDATED_AT],
    ]);
    expect(calls[1].payload).toEqual({ status: 'in_progress' });
  });

  it('受付済み → 対応中: 200 で状態が変わり、監査 admin.dsr.update (status_from / status_to) を 1 行、メールは送らない', async () => {
    const res = await PATCH(
      patchRequest(R_RECEIVED, { status: 'in_progress' }, RECEIVED_UPDATED_AT, {
        'x-forwarded-for': '198.51.100.7, 10.0.0.1',
        'user-agent': USER_AGENT,
      }),
      ctx(R_RECEIVED),
    );
    expect(res.status).toBe(200);
    const { data } = await readJson<DetailBody>(res);
    expect(data.status).toBe('in_progress');
    expect(data.requester).toEqual({ user_id: CUSTOMER_ID, nickname: 'たろう', email: CUSTOMER_EMAIL });
    expect(data.updated_at).not.toBe(RECEIVED_UPDATED_AT);
    expect(stored(R_RECEIVED).status).toBe('in_progress');
    expect(audits()).toEqual([
      {
        actor_id: ADMIN_ID,
        action_type: 'admin.dsr.update',
        target_id: CUSTOMER_ID,
        target_type: 'user',
        details: {
          request_id: R_RECEIVED,
          status_from: 'received',
          status_to: 'in_progress',
          response_note_changed: false,
          admin_notes_changed: false,
          changed: true,
        },
        severity: 'info',
        ip_address: '198.51.100.7',
        user_agent: USER_AGENT,
      },
    ]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('対応済みにして応答を書く: resolved_at が入り、dsr_resolved を本人へ 1 通、監査は warn で応答の中身を入れない', async () => {
    const note = 'ご登録の情報は次のとおりです';
    const res = await PATCH(
      patchRequest(R_RECEIVED, { status: 'fulfilled', response_note: note }, RECEIVED_UPDATED_AT),
      ctx(R_RECEIVED),
    );
    expect(res.status).toBe(200);
    const { data } = await readJson<DetailBody>(res);
    expect(data).toMatchObject({ status: 'fulfilled', response_note: note, resolved_at: NOW.toISOString() });
    expect(stored(R_RECEIVED)).toMatchObject({ status: 'fulfilled', response_note: note, resolved_at: NOW.toISOString() });
    expect(resolvedEmails()).toHaveLength(1);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      action_type: 'admin.dsr.update',
      severity: 'warn',
      details: {
        request_id: R_RECEIVED,
        status_from: 'received',
        status_to: 'fulfilled',
        response_note_changed: true,
        admin_notes_changed: false,
        changed: true,
      },
    });
    expect(JSON.stringify(audits())).not.toContain(note);
  });

  it('対応中 → 対応できず (応答あり): 200 で dsr_resolved を送る', async () => {
    const res = await PATCH(
      patchRequest(R_OVERDUE, { status: 'rejected', response_note: '理由' }, '2026-09-02T00:00:00.000Z'),
      ctx(R_OVERDUE),
    );
    expect(res.status).toBe(200);
    expect(stored(R_OVERDUE).status).toBe('rejected');
    expect(resolvedEmails()).toHaveLength(1);
  });

  it('対応できずで応答が (更新後も) 空なら 422 DSR_RESPONSE_NOTE_REQUIRED で、書き込みも監査もメールも無い', async () => {
    const res = await PATCH(patchRequest(R_RECEIVED, { status: 'rejected', response_note: '   ' }, RECEIVED_UPDATED_AT), ctx(R_RECEIVED));
    expect(res.status).toBe(422);
    expect(await readJson<ErrorBody>(res)).toEqual({
      error: { code: 'DSR_RESPONSE_NOTE_REQUIRED', message: '対応済み・対応できずにするときは本人への応答を書いてください' },
    });
    expect(dsrCalls().filter((c) => c.kind === 'update')).toEqual([]);
    expect(stored(R_RECEIVED).status).toBe('received');
    expect(audits()).toEqual([]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('本人確認待ち → 対応中は 409 DSR_INVALID_TRANSITION (本人確認の済んでいない請求に手を付けない)', async () => {
    const res = await PATCH(patchRequest(R_PENDING, { status: 'in_progress' }, '2026-10-15T00:00:00.000Z'), ctx(R_PENDING));
    expect(res.status).toBe(409);
    expect(await readJson<ErrorBody>(res)).toEqual({
      error: { code: 'DSR_INVALID_TRANSITION', message: '現在の状態ではその変更はできません' },
    });
    expect(stored(R_PENDING).status).toBe('pending_verification');
    expect(audits()).toEqual([]);
  });

  it('対応中 → 対応中 (同じ状態の指定) は 409 DSR_INVALID_TRANSITION', async () => {
    const res = await PATCH(patchRequest(R_OVERDUE, { status: 'in_progress' }, '2026-09-02T00:00:00.000Z'), ctx(R_OVERDUE));
    expect(res.status).toBe(409);
    expect((await readJson<ErrorBody>(res)).error.code).toBe('DSR_INVALID_TRANSITION');
    expect(dsrCalls().filter((c) => c.kind === 'update')).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it('status に received / withdrawn / pending_verification は指定できない (400 VALIDATION_ERROR)', async () => {
    for (const status of ['received', 'withdrawn', 'pending_verification']) {
      const res = await PATCH(patchRequest(R_RECEIVED, { status }, RECEIVED_UPDATED_AT), ctx(R_RECEIVED));
      expect(res.status, status).toBe(400);
      expect((await readJson<ErrorBody>(res)).error.code).toBe('VALIDATION_ERROR');
    }
    expect(dsrCalls()).toEqual([]);
  });

  it.each([
    ['受付済み', R_RECEIVED, 'received', RECEIVED_UPDATED_AT],
    ['対応中', R_OVERDUE, 'in_progress', '2026-09-02T00:00:00.000Z'],
  ])('status 無し (応答・内部メモだけ) の更新は %s で 200・状態は変わらない・監査を残す', async (_label, id, status, updatedAt) => {
    const res = await PATCH(patchRequest(id, { admin_notes: '電話で確認済み' }, updatedAt), ctx(id));
    expect(res.status).toBe(200);
    expect(stored(id)).toMatchObject({ status, admin_notes: '電話で確認済み' });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      severity: 'info',
      details: { status_from: status, status_to: status, admin_notes_changed: true, response_note_changed: false, changed: true },
    });
    expect(JSON.stringify(audits())).not.toContain('電話で確認済み');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['本人確認待ち', 'pending_verification'],
    ['対応済み', 'fulfilled'],
    ['対応できず', 'rejected'],
    ['取り下げ', 'withdrawn'],
  ])('status 無しの更新でも、%s の請求は 409 DSR_INVALID_TRANSITION (書き込みも監査も無い)', async (_label, status) => {
    const target = stored(R_RECEIVED);
    target.status = status;
    if (status === 'pending_verification') {
      target.verified_at = null;
      target.due_at = null;
    }
    if (status !== 'pending_verification') target.resolved_at = '2026-10-10T00:00:00.000Z';
    const res = await PATCH(patchRequest(R_RECEIVED, { response_note: '書き換え' }, RECEIVED_UPDATED_AT), ctx(R_RECEIVED));
    expect(res.status).toBe(409);
    expect((await readJson<ErrorBody>(res)).error.code).toBe('DSR_INVALID_TRANSITION');
    expect(dsrCalls().filter((c) => c.kind === 'update')).toEqual([]);
    expect(stored(R_RECEIVED).response_note).toBeNull();
    expect(audits()).toEqual([]);
  });

  it('変更が無ければ書き込まない (updated_at を動かさない) が、応答に本文を含むので監査は残す', async () => {
    const res = await PATCH(
      patchRequest(R_RECEIVED, { admin_notes: SECRET_ADMIN_NOTE }, RECEIVED_UPDATED_AT),
      ctx(R_RECEIVED),
    );
    expect(res.status).toBe(200);
    expect((await readJson<DetailBody>(res)).data.updated_at).toBe(RECEIVED_UPDATED_AT);
    expect(dsrCalls().filter((c) => c.kind === 'update')).toEqual([]);
    expect(stored(R_RECEIVED).updated_at).toBe(RECEIVED_UPDATED_AT);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      details: { status_from: 'received', status_to: 'received', changed: false, admin_notes_changed: false, response_note_changed: false },
    });
  });

  it('退会済み (user_id NULL) の受付済みを対応済みにできる。dsr_resolved は送らず、監査の target_type は data_subject_request', async () => {
    const res = await PATCH(
      patchRequest(R_DELETED, { status: 'fulfilled', response_note: '退会により消去済み' }, '2026-10-02T00:00:00.000Z'),
      ctx(R_DELETED),
    );
    expect(res.status).toBe(200);
    const { data } = await readJson<DetailBody>(res);
    expect(data).toMatchObject({ status: 'fulfilled', requester: null });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(audits()[0]).toMatchObject({ target_id: R_DELETED, target_type: 'data_subject_request', severity: 'warn' });
  });

  it('無い id は 404 NOT_FOUND で、監査は残さない', async () => {
    const res = await PATCH(patchRequest(MISSING_ID, { status: 'in_progress' }, RECEIVED_UPDATED_AT), ctx(MISSING_ID));
    expect(res.status).toBe(404);
    expect((await readJson<ErrorBody>(res)).error.code).toBe('NOT_FOUND');
    expect(audits()).toEqual([]);
  });

  it('id が UUID でなければ 400 VALIDATION_ERROR で、表に触れない', async () => {
    const res = await PATCH(patchRequest('nope', { status: 'in_progress' }, RECEIVED_UPDATED_AT), ctx('nope'));
    expect(res.status).toBe(400);
    expect((await readJson<ErrorBody>(res)).error.code).toBe('VALIDATION_ERROR');
    expect(dsrCalls()).toEqual([]);
  });

  it('本文が JSON でなければ 400 INVALID_JSON、どの項目も無ければ 400 VALIDATION_ERROR (表に触れない)', async () => {
    const broken = await PATCH(patchRequest(R_RECEIVED, '{', RECEIVED_UPDATED_AT), ctx(R_RECEIVED));
    expect(broken.status).toBe(400);
    expect((await readJson<ErrorBody>(broken)).error).toEqual({ code: 'INVALID_JSON', message: 'リクエストボディが不正です' });
    const empty = await PATCH(patchRequest(R_RECEIVED, {}, RECEIVED_UPDATED_AT), ctx(R_RECEIVED));
    expect(empty.status).toBe(400);
    expect((await readJson<ErrorBody>(empty)).error.code).toBe('VALIDATION_ERROR');
    expect(dsrCalls()).toEqual([]);
  });

  it('本文に NULL 文字があれば、未ログインでも認証より先に 400 INVALID_CHARACTER (表に触れない)', async () => {
    world.actor = null;
    const res = await PATCH(
      patchRequest(R_RECEIVED, JSON.stringify({ response_note: 'a\u0000b' }), RECEIVED_UPDATED_AT),
      ctx(R_RECEIVED),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('INVALID_CHARACTER');
    expect(world.calls).toEqual([]);
  });

  it('監査ログの記録に失敗しても更新の応答は変わらない', async () => {
    world.failures['admin_audit_logs.insert'] = { code: '42501', message: 'denied' };
    const res = await PATCH(patchRequest(R_RECEIVED, { status: 'in_progress' }, RECEIVED_UPDATED_AT), ctx(R_RECEIVED));
    expect(res.status).toBe(200);
    expect((await readJson<DetailBody>(res)).data.status).toBe('in_progress');
  });

  it('UPDATE が DB の失敗なら 500 (生のエラー文を出さない) で、監査もメールも無い', async () => {
    world.failures['admin:data_subject_requests.update'] = { code: 'XX000', message: 'raw update failure' };
    const res = await PATCH(
      patchRequest(R_RECEIVED, { status: 'fulfilled', response_note: '応答' }, RECEIVED_UPDATED_AT),
      ctx(R_RECEIVED),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('raw update failure');
    expect(audits()).toEqual([]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 監査ログの書き方
// ─────────────────────────────────────────────────────────────────────────────

describe('監査ログの書き方', () => {
  it('admin_audit_logs へは本人のセッションの client (recordAdminAudit) からだけ書く (service_role で直接 INSERT しない)', async () => {
    await listGET(listRequest());
    await detailGET(detailRequest(R_RECEIVED), ctx(R_RECEIVED));
    await PATCH(patchRequest(R_RECEIVED, { status: 'in_progress' }, RECEIVED_UPDATED_AT), ctx(R_RECEIVED));
    const auditWrites = world.calls.filter((c) => c.table === 'admin_audit_logs');
    expect(auditWrites).toHaveLength(3);
    expect(auditWrites.every((c) => c.client === 'session' && c.kind === 'insert')).toBe(true);
    expect(audits().map((a) => a.action_type)).toEqual(['admin.dsr.list', 'admin.dsr.view', 'admin.dsr.update']);
  });
});
