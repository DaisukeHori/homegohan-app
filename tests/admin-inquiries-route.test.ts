/**
 * #1121 GET /api/admin/inquiries, GET/PATCH/PUT /api/admin/inquiries/[id] のテスト
 *
 * 検証すること:
 *  - 認可: admin / super_admin / support だけが通る。未ログインは 401、それ以外のロールと凍結中は 403。
 *    認可に落ちた要求は inquiries に一切触れない (更新も起きない)
 *  - 応答: Web / モバイルが読む { inquiries } / { inquiry } の形 (camelCase)。
 *    一覧は概要だけ (問い合わせ本文と管理者メモは詳細でだけ返す)。余計な列を読まない・返さない
 *  - 一覧: 新しい順、status の絞り込み、limit / page の丸め、範囲外のページ、DB エラーは 500 (空配列にしない)
 *  - 詳細・更新: 400 (id / ボディ) / 404 / 500、PATCH と PUT が同じ結果、resolved_at の決め方、
 *    書き込む列の限定、変更が無いときは書き込まない
 *  - 監査ログ (#1200 の方針。src/lib/admin/audit.ts の recordAdminAudit): 詳細の閲覧と更新を admin_audit_logs に記録する。
 *    対象は情報を見られた本人 (ゲストは問い合わせ自体)、details は項目名と id だけで、本文・メールアドレス・メモの中身は入れない。
 *    情報を返さなかったとき (400 / 404 / 500 / 401 / 403) は記録しない。記録に失敗しても応答は返す (fail-open)
 *  - service_role: ニックネームの解決にだけ使い、inquiries / admin_audit_logs には使わない
 *
 * 認可は本物の requireRole、監査ログの記録は本物の recordAdminAudit を通す。外との境界である Supabase だけを、
 * 関係する RLS (supabase/baseline/prod_schema.sql) を真似たメモリ上の偽物に置き換える。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type ClientKind = 'session' | 'admin';

// ─────────────────────────────────────────────────────────────────────────────
// Supabase の偽物 (PostgREST と、関係する RLS のポリシーを真似る)
// ─────────────────────────────────────────────────────────────────────────────

const OPERATOR_ROLES = ['admin', 'super_admin', 'support'];

interface Call {
  client: ClientKind;
  table: string;
  kind: 'select' | 'update' | 'insert';
  columns: string;
  filters: Array<[string, string, unknown]>;
  orders: Array<{ column: string; ascending: boolean }>;
  range: [number, number] | null;
  payload: Row | null;
}

interface World {
  /** ログイン中のユーザー。null は未ログイン */
  actor: { id: string; roles: string[]; frozen_at?: string | null } | null;
  tables: { inquiries: Row[]; user_profiles: Row[]; admin_audit_logs: Row[] };
  /** `${table}.${select|update|insert}` (または `${session|admin}:${table}.${...}`) ごとに、強制的に返すエラー */
  failures: Record<string, { code?: string; message: string; status?: number }>;
  calls: Call[];
}

const world: World = { actor: null, tables: { inquiries: [], user_profiles: [], admin_audit_logs: [] }, failures: {}, calls: [] };

const FAKE_TRIGGER_UPDATED_AT = '2026-10-08T03:00:00.000Z';

function isOperator(): boolean {
  return !!world.actor && world.actor.roles.some((role) => OPERATOR_ROLES.includes(role));
}

/** RLS: service_role は素通し。通常のセッションは次のポリシーで絞る */
function rlsAllows(client: ClientKind, table: string, kind: Call['kind'], row: Row): boolean {
  if (client === 'admin') return true;
  const actor = world.actor;
  if (!actor) return false;
  if (table === 'user_profiles') return kind === 'select' && row.id === actor.id; // "Users can view own profile"
  if (table === 'inquiries') {
    if (kind === 'select') return isOperator() || row.user_id === actor.id; // "Admins can view all inquiries"
    if (kind === 'update') return isOperator(); // "Admins can update inquiries"
    return false;
  }
  if (table === 'admin_audit_logs') {
    return kind === 'insert' && isOperator() && row.actor_id === actor.id; // "audit_logs_insert_admins"
  }
  return false;
}

function createBuilder(client: ClientKind, table: keyof World['tables']) {
  const q = {
    kind: 'select' as Call['kind'],
    columns: '',
    countExact: false,
    filters: [] as Array<(row: Row) => boolean>,
    filterLog: [] as Array<[string, string, unknown]>,
    orders: [] as Array<{ column: string; ascending: boolean }>,
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

    if (q.kind === 'insert') {
      const row = { ...q.payload };
      if (!rlsAllows(client, table, 'insert', row)) {
        return { data: null, error: { code: '42501', message: 'new row violates row-level security policy' }, count: null };
      }
      world.tables[table].push(row);
      return { data: null, error: null, count: null };
    }

    let rows = world.tables[table].filter((row) => rlsAllows(client, table, q.kind, row) && q.filters.every((f) => f(row)));

    if (q.kind === 'update') {
      for (const row of rows) Object.assign(row, q.payload, { updated_at: FAKE_TRIGGER_UPDATED_AT }); // updated_at はトリガーで入る
    } else {
      for (const { column, ascending } of [...q.orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = a[column] as string | null;
          const bv = b[column] as string | null;
          if (av === bv) return 0;
          return ((av ?? '') < (bv ?? '') ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
    }

    const total = rows.length;
    if (q.range) {
      const [from, to] = q.range;
      // PostgREST は件数より後ろのオフセットを 416 (PGRST103) で返す
      if (q.countExact && from > total) {
        // 実物 (ローカルの Supabase) は 416 の本文が途中で切れ、supabase-js の error は code が空で message が '{"' だけになる
        return { data: null, error: { code: '', message: '{"', details: '', hint: '' }, count: null, status: 416 };
      }
      rows = rows.slice(from, to + 1);
    }

    const data = rows.map((row) => ({ ...row }));
    if (mode === 'many') return { data, error: null, count: q.countExact ? total : null };
    if (data.length > 1) {
      return { data: null, error: { code: 'PGRST116', message: 'multiple rows returned' }, count: null };
    }
    if (mode === 'one' && data.length === 0) {
      return { data: null, error: { code: 'PGRST116', message: 'no rows returned' }, count: null };
    }
    return { data: data[0] ?? null, error: null, count: null };
  };

  const builder: Record<string, unknown> = {
    select: (columns: string, options?: { count?: string }) => {
      q.columns = columns;
      q.countExact = options?.count === 'exact';
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
    order: (column: string, options?: { ascending?: boolean }) => {
      q.orders.push({ column, ascending: options?.ascending !== false });
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
    // await builder で配列を受け取れるようにする (PostgrestFilterBuilder と同じ)
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
    },
    from: (table: string) => {
      if (!(table in world.tables)) throw new Error(`fake: 想定していないテーブル ${table}`);
      return createBuilder(client, table as keyof World['tables']);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// モック (外との境界だけ)。requireRole は本物を使う
// ─────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => createClientFake('session'),
  getSupabaseAdmin: () => createClientFake('admin'),
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

import { GET as listGET } from '@/app/api/admin/inquiries/route';
import { GET as detailGET, PATCH, PUT } from '@/app/api/admin/inquiries/[id]/route';
import {
  ADMIN_NOTES_MAX_LENGTH,
  inquiryAuditTarget,
  inquiryUpdateBodySchema,
  nextResolvedAt,
  normalizeAdminNotes,
} from '@/lib/admin/inquiries';

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ
// ─────────────────────────────────────────────────────────────────────────────

const SUPPORT_ID = 'c0000000-0000-4000-8000-000000000001';
const ADMIN_ID = 'c0000000-0000-4000-8000-000000000002';
const SUPER_ADMIN_ID = 'c0000000-0000-4000-8000-000000000003';
const GENERAL_ID = 'c0000000-0000-4000-8000-000000000004';
const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000005';

// 作成日時の新しい順: I1 (guest, pending) > I2 (customer, in_progress) > I3 (guest, resolved) > I4 (guest, closed) > I5 (guest, pending)
const I1 = 'a0000000-0000-4000-8000-000000000001';
const I2 = 'a0000000-0000-4000-8000-000000000002';
const I3 = 'a0000000-0000-4000-8000-000000000003';
const I4 = 'a0000000-0000-4000-8000-000000000004';
const I5 = 'a0000000-0000-4000-8000-000000000005';
const MISSING_ID = 'a0000000-0000-4000-8000-0000000000ff';

const NOW = new Date('2026-10-08T03:00:00.000Z');
const NOW_ISO = NOW.toISOString();

const SECRET_NOTE = '電話番号は 090-0000-0000 とのこと';
const USER_AGENT = 'Mozilla/5.0 (inquiries-test)';

/** 一覧が返す項目 (概要)。本文と管理者メモは含まない */
const SUMMARY_KEYS = ['createdAt', 'email', 'id', 'inquiryType', 'resolvedAt', 'status', 'subject', 'updatedAt', 'userId', 'userName'];
/** 詳細・更新が返す項目 */
const DETAIL_KEYS = [...SUMMARY_KEYS, 'adminNotes', 'message'].sort();

function inquiryRow(overrides: Row): Row {
  return {
    id: I1,
    user_id: null,
    inquiry_type: 'general',
    email: 'guest@example.com',
    subject: '件名',
    message: '本文です',
    status: 'pending',
    admin_notes: null,
    created_at: '2026-10-05T00:00:00.000Z',
    updated_at: '2026-10-05T00:00:00.000Z',
    resolved_at: null,
    ...overrides,
  };
}

function seed() {
  world.tables.inquiries = [
    inquiryRow({ id: I1, created_at: '2026-10-05T00:00:00.000Z', subject: '一番新しい', email: 'new@example.com' }),
    inquiryRow({
      id: I2,
      user_id: CUSTOMER_ID,
      inquiry_type: 'bug',
      email: 'customer@example.com',
      subject: '会員からの不具合報告',
      message: '画面が真っ白になります',
      status: 'in_progress',
      admin_notes: '調査中',
      created_at: '2026-10-04T00:00:00.000Z',
    }),
    inquiryRow({
      id: I3,
      status: 'resolved',
      resolved_at: '2026-10-03T12:00:00.000Z',
      admin_notes: '回答済み',
      created_at: '2026-10-03T00:00:00.000Z',
    }),
    inquiryRow({
      id: I4,
      status: 'closed',
      resolved_at: '2026-10-02T12:00:00.000Z',
      created_at: '2026-10-02T00:00:00.000Z',
    }),
    inquiryRow({ id: I5, created_at: '2026-10-01T00:00:00.000Z' }),
  ];
  world.tables.user_profiles = [
    { id: SUPPORT_ID, nickname: 'サポート担当', roles: ['support'], organization_id: null, frozen_at: null, unban_at: null },
    { id: ADMIN_ID, nickname: '管理者', roles: ['admin'], organization_id: null, frozen_at: null, unban_at: null },
    { id: SUPER_ADMIN_ID, nickname: 'スーパー管理者', roles: ['super_admin'], organization_id: null, frozen_at: null, unban_at: null },
    { id: GENERAL_ID, nickname: '一般', roles: ['user'], organization_id: null, frozen_at: null, unban_at: null },
    { id: CUSTOMER_ID, nickname: 'たろう', roles: ['user'], organization_id: null, frozen_at: null, unban_at: null },
  ];
  world.tables.admin_audit_logs = [];
  world.failures = {};
  world.calls = [];
}

/** ログイン中のユーザーを切り替える。ロール・凍結は user_profiles に反映する (requireRole が読む) */
function loginAs(id: string, roles: string[], frozenAt: string | null = null) {
  world.actor = { id, roles };
  const profile = world.tables.user_profiles.find((p) => p.id === id);
  if (profile) {
    profile.roles = roles;
    profile.frozen_at = frozenAt;
  } else {
    world.tables.user_profiles.push({ id, nickname: 'x', roles, organization_id: null, frozen_at: frozenAt, unban_at: null });
  }
}

const loginAsSupport = () => loginAs(SUPPORT_ID, ['support']);

function listRequest(query = '', headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/admin/inquiries${query}`, { headers });
}

function detailRequest(id: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/admin/inquiries/${id}`, { headers });
}

function updateRequest(id: string, method: 'PATCH' | 'PUT', body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/admin/inquiries/${id}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: { id } });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<Json> => (await res.json()) as Json;

const inquiryCalls = () => world.calls.filter((c) => c.table === 'inquiries');
const stored = (id: string) => world.tables.inquiries.find((r) => r.id === id)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.logError.mockClear();
  seed();
  loginAsSupport();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// 認可 (本物の requireRole)
// ─────────────────────────────────────────────────────────────────────────────

const HANDLERS: Array<{ name: string; call: () => Promise<Response> }> = [
  { name: 'GET /api/admin/inquiries', call: () => listGET(listRequest()) },
  { name: 'GET /api/admin/inquiries/[id]', call: () => detailGET(detailRequest(I1), ctx(I1)) },
  {
    name: 'PATCH /api/admin/inquiries/[id]',
    call: () => PATCH(updateRequest(I1, 'PATCH', { status: 'resolved', adminNotes: 'x' }), ctx(I1)),
  },
  {
    name: 'PUT /api/admin/inquiries/[id]',
    call: () => PUT(updateRequest(I1, 'PUT', { status: 'resolved', adminNotes: 'x' }), ctx(I1)),
  },
];

describe.each(HANDLERS)('認可: $name', ({ call }) => {
  it('未ログインは 401 で、inquiries には触れない', async () => {
    world.actor = null;
    const res = await call();
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe('AUTH_UNAUTHENTICATED');
    expect(inquiryCalls()).toEqual([]);
    expect(world.tables.admin_audit_logs).toEqual([]);
    expect(stored(I1).status).toBe('pending');
  });

  it.each([
    ['一般ユーザー', ['user']],
    ['sales', ['sales']],
    ['finance', ['finance']],
    ['content_moderator', ['content_moderator']],
    ['org_admin', ['org_admin']],
    ['org_manager', ['org_manager']],
    ['org_member', ['org_member']],
    ['ロールなし', []],
  ])('%s は 403 で、inquiries には触れない', async (_label, roles) => {
    loginAs(GENERAL_ID, roles);
    const res = await call();
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe('OP_PERMISSION_DENIED');
    expect(inquiryCalls()).toEqual([]);
    expect(world.tables.admin_audit_logs).toEqual([]);
    expect(stored(I1).status).toBe('pending');
    expect(stored(I1).admin_notes).toBeNull();
  });

  it('凍結中の support は 403', async () => {
    loginAs(SUPPORT_ID, ['support'], '2026-10-01T00:00:00.000Z');
    const res = await call();
    expect(res.status).toBe(403);
    expect(inquiryCalls()).toEqual([]);
  });

  it.each([
    ['support', SUPPORT_ID, ['support']],
    ['admin', ADMIN_ID, ['admin']],
    ['super_admin', SUPER_ADMIN_ID, ['super_admin']],
    ['複数ロールのうち 1 つが support', SUPPORT_ID, ['user', 'support']],
  ])('%s は通る', async (_label, id, roles) => {
    loginAs(id, roles);
    const res = await call();
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 一覧
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/inquiries (一覧)', () => {
  it('新しい順に { inquiries, total, page, limit } を返す', async () => {
    const res = await listGET(listRequest());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.inquiries.map((i: Json) => i.id)).toEqual([I1, I2, I3, I4, I5]);
    expect(body.total).toBe(5);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(50);
  });

  it('概要を camelCase で返し、問い合わせ本文と管理者メモは含めない (モバイルの一覧画面と同じ項目)', async () => {
    const body = await json(await listGET(listRequest()));
    expect(body.inquiries[0]).toEqual({
      id: I1,
      userId: null,
      userName: null,
      inquiryType: 'general',
      email: 'new@example.com',
      subject: '一番新しい',
      status: 'pending',
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
      resolvedAt: null,
    });
    for (const item of body.inquiries) {
      expect(Object.keys(item).sort()).toEqual(SUMMARY_KEYS);
      expect(item).not.toHaveProperty('message');
      expect(item).not.toHaveProperty('adminNotes');
    }
    // 本文・メモの中身そのものも応答に出ない
    expect(JSON.stringify(body)).not.toContain('画面が真っ白');
    expect(JSON.stringify(body)).not.toContain('調査中');
  });

  it('読む列は概要の 9 列だけ (select(*) にせず、message / admin_notes を読まない)', async () => {
    await listGET(listRequest());
    const call = inquiryCalls()[0];
    expect(call.columns).not.toContain('*');
    expect(call.columns.split(',').map((c) => c.trim()).sort()).toEqual(
      ['created_at', 'email', 'id', 'inquiry_type', 'resolved_at', 'status', 'subject', 'updated_at', 'user_id'],
    );
  });

  it('一覧は本文を返さないので、監査ログには残さない (本文を返す詳細の閲覧を記録する)', async () => {
    await listGET(listRequest());
    expect(world.tables.admin_audit_logs).toEqual([]);
  });

  it('会員の問い合わせにはニックネームを userName に入れる (service_role で user_profiles を引く)', async () => {
    const body = await json(await listGET(listRequest()));
    const member = body.inquiries.find((i: Json) => i.id === I2);
    expect(member.userId).toBe(CUSTOMER_ID);
    expect(member.userName).toBe('たろう');
    expect(member.email).toBe('customer@example.com');

    const profileCalls = world.calls.filter((c) => c.table === 'user_profiles' && c.client === 'admin');
    expect(profileCalls).toHaveLength(1);
    expect(profileCalls[0].columns).toBe('id, nickname');
    expect(profileCalls[0].filters).toEqual([['id', 'in', [CUSTOMER_ID]]]);
  });

  it('service_role は user_profiles にしか使わない (inquiries / admin_audit_logs は本人のセッション)', async () => {
    await listGET(listRequest());
    await detailGET(detailRequest(I2), ctx(I2));
    await PATCH(updateRequest(I2, 'PATCH', { status: 'resolved' }), ctx(I2));
    const adminTables = new Set(world.calls.filter((c) => c.client === 'admin').map((c) => c.table));
    expect([...adminTables]).toEqual(['user_profiles']);
  });

  it('ニックネームを引けなくても一覧は返す (メールアドレス表示に切り替え、ログに残す)', async () => {
    // 認可 (requireRole) が読む user_profiles は壊さず、service_role でのニックネーム取得だけを失敗させる
    world.failures['admin:user_profiles.select'] = { code: '57014', message: 'timeout' };
    const res = await listGET(listRequest());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.inquiries).toHaveLength(5);
    expect(body.inquiries.find((i: Json) => i.id === I2).userName).toBeNull();
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining('ニックネーム'), expect.anything());
  });

  it.each([
    ['pending', [I1, I5]],
    ['in_progress', [I2]],
    ['resolved', [I3]],
    ['closed', [I4]],
  ])('status=%s で絞り込める', async (status, ids) => {
    const body = await json(await listGET(listRequest(`?status=${status}`)));
    expect(body.inquiries.map((i: Json) => i.id)).toEqual(ids);
    expect(body.total).toBe(ids.length);
  });

  it('status が空 (?status=) なら絞り込まない', async () => {
    const body = await json(await listGET(listRequest('?status=')));
    expect(body.inquiries).toHaveLength(5);
  });

  it('status が不正なら 400 で、inquiries を読まない', async () => {
    const res = await listGET(listRequest('?status=done'));
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
    expect(inquiryCalls()).toEqual([]);
  });

  it('limit と page でページを切り、範囲は clampIntParam で丸める', async () => {
    const page1 = await json(await listGET(listRequest('?limit=2&page=1')));
    expect(page1.inquiries.map((i: Json) => i.id)).toEqual([I1, I2]);
    expect(page1.total).toBe(5);
    expect(page1.limit).toBe(2);

    const page3 = await json(await listGET(listRequest('?limit=2&page=3')));
    expect(page3.inquiries.map((i: Json) => i.id)).toEqual([I5]);
    expect(page3.page).toBe(3);
  });

  it.each([
    ['limit=1000', 100, 1],
    ['limit=0', 1, 1],
    ['limit=-5', 1, 1],
    ['limit=abc', 50, 1],
    ['limit=2.9', 2, 1],
    ['page=0', 50, 1],
    ['page=-3', 50, 1],
    ['page=abc', 50, 1],
    ['page=99999999', 50, 10000],
  ])('?%s は limit=%i / page=%i に丸める (例外にならない)', async (query, limit, page) => {
    const res = await listGET(listRequest(`?${query}`));
    // page=99999999 は件数より後ろ。それ以外は先頭ページ
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.limit).toBe(limit);
    expect(body.page).toBe(page);
    const range = inquiryCalls()[0].range!;
    expect(range).toEqual([(page - 1) * limit, (page - 1) * limit + limit - 1]);
  });

  it('件数より後ろのページは 500 ではなく空のページを返す', async () => {
    const res = await listGET(listRequest('?limit=2&page=50'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.inquiries).toEqual([]);
    expect(body.total).toBeNull();
    expect(body.page).toBe(50);
  });

  it('code が PGRST103 のエラーも、HTTP ステータスに関わらず空のページとして扱う (500 にしない)', async () => {
    // 上のテストは「HTTP 416 だが code が空」(ローカルの Supabase の実際の応答)。こちらは「code だけ分かる」場合
    world.failures['inquiries.select'] = { code: 'PGRST103', message: 'Requested range not satisfiable' };
    const res = await listGET(listRequest('?page=2'));
    expect(res.status).toBe(200);
    expect((await json(res)).inquiries).toEqual([]);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('DB エラーは空配列ではなく 500 を返し、ログに残す (以前の画面は握りつぶして「該当なし」と出していた)', async () => {
    world.failures['inquiries.select'] = { code: '42P01', message: 'relation does not exist' };
    const res = await listGET(listRequest());
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.inquiries).toBeUndefined();
    expect(mocks.logError).toHaveBeenCalled();
  });

  it('個人情報を含むので共有キャッシュに残さない', async () => {
    const res = await listGET(listRequest());
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 詳細
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/inquiries/[id] (詳細)', () => {
  it('{ inquiry } を camelCase で返す (本文と管理者メモを含む)', async () => {
    const res = await detailGET(detailRequest(I2), ctx(I2));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await json(res);
    expect(body.inquiry).toEqual({
      id: I2,
      userId: CUSTOMER_ID,
      userName: 'たろう',
      inquiryType: 'bug',
      email: 'customer@example.com',
      subject: '会員からの不具合報告',
      message: '画面が真っ白になります',
      status: 'in_progress',
      adminNotes: '調査中',
      createdAt: '2026-10-04T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
      resolvedAt: null,
    });
    expect(Object.keys(body.inquiry).sort()).toEqual(DETAIL_KEYS);
  });

  it('ゲストの問い合わせは userName が null', async () => {
    const body = await json(await detailGET(detailRequest(I1), ctx(I1)));
    expect(body.inquiry.userId).toBeNull();
    expect(body.inquiry.userName).toBeNull();
    // ゲスト (user_id なし) では user_profiles を引かない
    expect(world.calls.filter((c) => c.table === 'user_profiles' && c.client === 'admin')).toEqual([]);
  });

  it.each(['abc', '123', 'not-a-uuid', '../../etc/passwd', 'a0000000-0000-4000-8000-00000000000z'])(
    'id が UUID でなければ 400 で、閲覧の記録も残さない (%s)',
    async (id) => {
      const res = await detailGET(detailRequest(id), ctx(id));
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('VALIDATION_ERROR');
      expect(inquiryCalls()).toEqual([]);
      expect(world.tables.admin_audit_logs).toEqual([]);
    },
  );

  it('存在しない id は 404 で、何も返していないので閲覧の記録も残さない', async () => {
    const res = await detailGET(detailRequest(MISSING_ID), ctx(MISSING_ID));
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('NOT_FOUND');
    expect(world.tables.admin_audit_logs).toEqual([]);
  });

  it('DB エラーは 404 ではなく 500 (行が無いときだけ 404)。閲覧の記録も残さない', async () => {
    world.failures['inquiries.select'] = { code: '57014', message: 'timeout' };
    const res = await detailGET(detailRequest(I1), ctx(I1));
    expect(res.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalled();
    expect(world.tables.admin_audit_logs).toEqual([]);
  });

  it('会員の問い合わせの閲覧は、閲覧された本人 (会員) を対象に admin.inquiry.view として記録する (#1200)', async () => {
    loginAs(ADMIN_ID, ['admin']);
    await detailGET(
      detailRequest(I2, { 'x-forwarded-for': '2001:db8::1', 'user-agent': USER_AGENT }),
      ctx(I2),
    );
    expect(world.tables.admin_audit_logs).toHaveLength(1);
    const log = world.tables.admin_audit_logs[0];
    expect(log).toMatchObject({
      actor_id: ADMIN_ID,
      action_type: 'admin.inquiry.view',
      target_id: CUSTOMER_ID, // 情報を見られた本人
      target_type: 'user',
      severity: 'info',
      ip_address: '2001:db8::1',
      user_agent: USER_AGENT,
    });
    // details は問い合わせの id と、返した項目名だけ
    const details = log.details as { inquiry_id: string; viewed_fields: string[] };
    expect(Object.keys(details).sort()).toEqual(['inquiry_id', 'viewed_fields']);
    expect(details.inquiry_id).toBe(I2);
    expect([...details.viewed_fields].sort()).toEqual(DETAIL_KEYS);
  });

  it('ゲストの問い合わせには本人の id が無いので、問い合わせそのものを対象に記録する', async () => {
    await detailGET(detailRequest(I1), ctx(I1));
    expect(world.tables.admin_audit_logs).toHaveLength(1);
    expect(world.tables.admin_audit_logs[0]).toMatchObject({
      actor_id: SUPPORT_ID,
      action_type: 'admin.inquiry.view',
      target_id: I1,
      target_type: 'inquiry',
    });
    expect((world.tables.admin_audit_logs[0].details as { inquiry_id: string }).inquiry_id).toBe(I1);
  });

  it('監査ログには値 (メールアドレス・件名・本文・メモ・ニックネーム) を入れない', async () => {
    await detailGET(detailRequest(I2), ctx(I2));
    const serialized = JSON.stringify(world.tables.admin_audit_logs);
    for (const value of ['customer@example.com', '会員からの不具合報告', '画面が真っ白', '調査中', 'たろう']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('x-forwarded-for が複数 IP でも先頭の 1 つで記録でき、IP として読めない値なら null で記録は残る', async () => {
    await detailGET(detailRequest(I1, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }), ctx(I1));
    await detailGET(detailRequest(I1, { 'x-forwarded-for': 'unknown' }), ctx(I1));
    expect(world.tables.admin_audit_logs.map((l) => l.ip_address)).toEqual(['203.0.113.9', null]);
  });

  it('監査ログに書けなくても詳細は返し (fail-open)、失敗はログに残す', async () => {
    world.failures['admin_audit_logs.insert'] = { code: '42501', message: 'rls' };
    const res = await detailGET(detailRequest(I2), ctx(I2));
    expect(res.status).toBe(200);
    expect((await json(res)).inquiry.id).toBe(I2);
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining('監査ログ'),
      expect.any(Error),
      expect.objectContaining({ action_type: 'admin.inquiry.view', actor_id: SUPPORT_ID, target_id: CUSTOMER_ID }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 更新 (Web は PUT、モバイルは PATCH。同じ処理)
// ─────────────────────────────────────────────────────────────────────────────

describe.each([
  ['PATCH', PATCH],
  ['PUT', PUT],
] as const)('%s /api/admin/inquiries/[id] (更新)', (method, handler) => {
  const send = (id: string, body: unknown, headers: Record<string, string> = {}) =>
    handler(updateRequest(id, method, body, headers), ctx(id));

  it('ステータスと管理者メモを更新し、更新後の { inquiry } を返す', async () => {
    const res = await send(I1, { status: 'in_progress', adminNotes: '折り返し予定' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.inquiry.id).toBe(I1);
    expect(body.inquiry.status).toBe('in_progress');
    expect(body.inquiry.adminNotes).toBe('折り返し予定');
    expect(body.inquiry.resolvedAt).toBeNull();
    expect(body.inquiry.updatedAt).toBe(FAKE_TRIGGER_UPDATED_AT);
    expect(Object.keys(body.inquiry).sort()).toEqual(DETAIL_KEYS);
    expect(stored(I1)).toMatchObject({ status: 'in_progress', admin_notes: '折り返し予定', resolved_at: null });
  });

  it('解決済みにすると resolved_at に現在時刻を入れる', async () => {
    const body = await json(await send(I1, { status: 'resolved' }));
    expect(body.inquiry.resolvedAt).toBe(NOW_ISO);
    expect(stored(I1).resolved_at).toBe(NOW_ISO);
  });

  it('完了 (closed) にしても resolved_at を入れる', async () => {
    const body = await json(await send(I1, { status: 'closed' }));
    expect(body.inquiry.resolvedAt).toBe(NOW_ISO);
  });

  it('解決済み → 完了では、最初に解決した時刻を保つ', async () => {
    const body = await json(await send(I3, { status: 'closed' }));
    expect(body.inquiry.status).toBe('closed');
    expect(body.inquiry.resolvedAt).toBe('2026-10-03T12:00:00.000Z');
  });

  it('解決済みを再オープン (pending / in_progress) すると resolved_at を null に戻す', async () => {
    const reopened = await json(await send(I3, { status: 'in_progress' }));
    expect(reopened.inquiry.resolvedAt).toBeNull();
    expect(stored(I3).resolved_at).toBeNull();

    const closedAgain = await json(await send(I4, { status: 'pending' }));
    expect(closedAgain.inquiry.resolvedAt).toBeNull();
  });

  it('管理者メモだけの更新では、ステータスと resolved_at に触れない', async () => {
    const body = await json(await send(I3, { adminNotes: '追記しました' }));
    expect(body.inquiry.adminNotes).toBe('追記しました');
    expect(body.inquiry.status).toBe('resolved');
    expect(body.inquiry.resolvedAt).toBe('2026-10-03T12:00:00.000Z');
    const update = world.calls.find((c) => c.table === 'inquiries' && c.kind === 'update')!;
    expect(update.payload).toEqual({ admin_notes: '追記しました' });
  });

  it('ステータスだけの更新では、管理者メモを消さない', async () => {
    await send(I2, { status: 'resolved' });
    expect(stored(I2).admin_notes).toBe('調査中');
  });

  it.each([
    ['空文字', ''],
    ['空白だけ', '  \n '],
    ['null', null],
  ])('管理者メモが %s ならメモを消す (null で保存)', async (_label, notes) => {
    const body = await json(await send(I2, { adminNotes: notes }));
    expect(body.inquiry.adminNotes).toBeNull();
    expect(stored(I2).admin_notes).toBeNull();
  });

  it('書き込む列は status / admin_notes / resolved_at だけ (本文・メールアドレス・問い合わせ者などは書き換えない)', async () => {
    const before = { ...stored(I2) };
    const res = await send(I2, {
      status: 'resolved',
      adminNotes: '対応済み',
      // 以下は無視されなければならない
      resolved_at: '2000-01-01T00:00:00.000Z',
      resolvedAt: '2000-01-01T00:00:00.000Z',
      id: I1,
      user_id: GENERAL_ID,
      userId: GENERAL_ID,
      email: 'attacker@example.com',
      subject: '書き換え',
      message: '書き換え',
      inquiry_type: 'feature',
      created_at: '2000-01-01T00:00:00.000Z',
    });
    expect(res.status).toBe(200);

    const update = world.calls.find((c) => c.table === 'inquiries' && c.kind === 'update')!;
    expect(update.payload).toEqual({ status: 'resolved', resolved_at: NOW_ISO, admin_notes: '対応済み' });
    expect(update.filters).toEqual([['id', 'eq', I2]]);
    expect(stored(I2)).toMatchObject({
      id: I2,
      user_id: before.user_id,
      email: before.email,
      subject: before.subject,
      message: before.message,
      inquiry_type: before.inquiry_type,
      created_at: before.created_at,
      resolved_at: NOW_ISO,
    });
    // 他の問い合わせには触れない
    expect(stored(I1).status).toBe('pending');
  });

  it('変更が無いときは書き込まない (updated_at を動かさない)。ただし本文を返すので、更新の記録は残す', async () => {
    const res = await send(I2, { status: 'in_progress', adminNotes: '調査中' });
    expect(res.status).toBe(200);
    expect((await json(res)).inquiry.updatedAt).toBe('2026-10-05T00:00:00.000Z'); // FAKE_TRIGGER_UPDATED_AT ではない
    expect(world.calls.some((c) => c.table === 'inquiries' && c.kind === 'update')).toBe(false);

    // 変更が無い更新を「記録なしの読み取り」に使えないようにする
    expect(world.tables.admin_audit_logs).toHaveLength(1);
    expect(world.tables.admin_audit_logs[0]).toMatchObject({ action_type: 'admin.inquiry.update', target_id: CUSTOMER_ID });
    expect(world.tables.admin_audit_logs[0].details).toEqual({
      inquiry_id: I2,
      status_from: 'in_progress',
      status_to: 'in_progress',
      admin_notes_changed: false,
      changed: false,
    });
  });

  it('更新を admin.inquiry.update として記録する (変更前後のステータスとメモ変更の有無だけ。メモの中身は入れない)', async () => {
    await send(
      I1,
      { status: 'resolved', adminNotes: SECRET_NOTE },
      { 'x-forwarded-for': '198.51.100.7', 'user-agent': USER_AGENT },
    );
    expect(world.tables.admin_audit_logs).toHaveLength(1);
    const log = world.tables.admin_audit_logs[0];
    expect(log).toEqual({
      actor_id: SUPPORT_ID,
      action_type: 'admin.inquiry.update',
      target_id: I1, // ゲストの問い合わせなので、問い合わせそのもの
      target_type: 'inquiry',
      details: {
        inquiry_id: I1,
        status_from: 'pending',
        status_to: 'resolved',
        admin_notes_changed: true,
        changed: true,
      },
      severity: 'info',
      ip_address: '198.51.100.7',
      user_agent: USER_AGENT,
    });
    expect(JSON.stringify(log)).not.toContain(SECRET_NOTE);
    expect(JSON.stringify(log)).not.toContain('@example.com');
  });

  it('会員の問い合わせの更新は、会員を対象に記録する', async () => {
    await send(I2, { status: 'resolved' });
    expect(world.tables.admin_audit_logs[0]).toMatchObject({
      action_type: 'admin.inquiry.update',
      target_id: CUSTOMER_ID,
      target_type: 'user',
    });
    expect((world.tables.admin_audit_logs[0].details as { inquiry_id: string }).inquiry_id).toBe(I2);
  });

  it('メモを変えないときは admin_notes_changed が false', async () => {
    await send(I1, { status: 'in_progress' });
    expect(world.tables.admin_audit_logs[0].details).toMatchObject({
      status_from: 'pending',
      status_to: 'in_progress',
      admin_notes_changed: false,
      changed: true,
    });
  });

  it('監査ログに書けなくても更新は成功として返し、失敗はログに残す', async () => {
    world.failures['admin_audit_logs.insert'] = { code: '42501', message: 'rls' };
    const res = await send(I1, { status: 'resolved' });
    expect(res.status).toBe(200);
    expect(stored(I1).status).toBe('resolved');
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining('監査ログ'),
      expect.any(Error),
      expect.objectContaining({ action_type: 'admin.inquiry.update', actor_id: SUPPORT_ID, target_id: I1 }),
    );
  });

  it('更新に失敗したら 500 を返し、監査ログは残さない', async () => {
    world.failures['inquiries.update'] = { code: '40001', message: 'serialization failure' };
    const res = await send(I1, { status: 'resolved' });
    expect(res.status).toBe(500);
    expect((await json(res)).error.code).toBe('INTERNAL_ERROR');
    expect(world.tables.admin_audit_logs).toEqual([]);
    expect(mocks.logError).toHaveBeenCalled();
  });

  it('存在しない id は 404 で、何も書き込まず記録も残さない', async () => {
    const res = await send(MISSING_ID, { status: 'resolved' });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('NOT_FOUND');
    expect(world.calls.some((c) => c.kind === 'update')).toBe(false);
    expect(world.tables.admin_audit_logs).toEqual([]);
  });

  it('id が UUID でなければ 400', async () => {
    const res = await send('abc', { status: 'resolved' });
    expect(res.status).toBe(400);
    expect(inquiryCalls()).toEqual([]);
  });

  it.each([
    ['status が許可された値でない', { status: 'done' }],
    ['status が文字列でない', { status: 1 }],
    ['status も adminNotes も無い', {}],
    ['関係のないキーだけ', { subject: 'x' }],
    ['adminNotes が上限を超える', { adminNotes: 'あ'.repeat(ADMIN_NOTES_MAX_LENGTH + 1) }],
    ['adminNotes が文字列でない', { adminNotes: 123 }],
    ['ボディが配列', [{ status: 'resolved' }]],
    ['ボディが null', null],
    ['ボディが JSON でない', '{not json'],
  ])('ボディが不正 (%s) なら 400 で、何も書き込まない', async (_label, body) => {
    const res = await send(I1, body);
    expect(res.status).toBe(400);
    expect(['VALIDATION_ERROR', 'INVALID_JSON']).toContain((await json(res)).error.code);
    expect(inquiryCalls()).toEqual([]);
    expect(world.tables.admin_audit_logs).toEqual([]);
    expect(stored(I1).status).toBe('pending');
  });

  it('adminNotes はちょうど上限の長さまで受け付ける', async () => {
    const res = await send(I1, { adminNotes: 'あ'.repeat(ADMIN_NOTES_MAX_LENGTH) });
    expect(res.status).toBe(200);
    expect((stored(I1).admin_notes as string).length).toBe(ADMIN_NOTES_MAX_LENGTH);
  });
});

describe('PATCH と PUT は同じ結果になる (Web は PUT、モバイルは PATCH)', () => {
  it('同じボディで同じ応答・同じ保存内容になる', async () => {
    const body = { status: 'resolved', adminNotes: 'メモ' };
    const viaPatch = await json(await PATCH(updateRequest(I1, 'PATCH', body), ctx(I1)));
    seed();
    loginAsSupport();
    const viaPut = await json(await PUT(updateRequest(I1, 'PUT', body), ctx(I1)));
    expect(viaPut).toEqual(viaPatch);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 共有部品
// ─────────────────────────────────────────────────────────────────────────────

describe('nextResolvedAt', () => {
  const open = { status: 'pending', resolved_at: null };
  const resolved = { status: 'resolved', resolved_at: '2026-10-03T12:00:00.000Z' };

  it('未解決から resolved / closed にするときは現在時刻', () => {
    expect(nextResolvedAt('resolved', open, NOW_ISO)).toBe(NOW_ISO);
    expect(nextResolvedAt('closed', { status: 'in_progress', resolved_at: null }, NOW_ISO)).toBe(NOW_ISO);
  });

  it('解決済みのまま resolved / closed にするときは元の解決時刻を保つ', () => {
    expect(nextResolvedAt('closed', resolved, NOW_ISO)).toBe('2026-10-03T12:00:00.000Z');
    expect(nextResolvedAt('resolved', { status: 'closed', resolved_at: '2026-10-02T00:00:00.000Z' }, NOW_ISO)).toBe(
      '2026-10-02T00:00:00.000Z',
    );
  });

  it('解決済みでも resolved_at が空なら現在時刻を入れる', () => {
    expect(nextResolvedAt('closed', { status: 'resolved', resolved_at: null }, NOW_ISO)).toBe(NOW_ISO);
  });

  it('pending / in_progress に戻すときは null', () => {
    expect(nextResolvedAt('pending', resolved, NOW_ISO)).toBeNull();
    expect(nextResolvedAt('in_progress', resolved, NOW_ISO)).toBeNull();
    expect(nextResolvedAt('pending', open, NOW_ISO)).toBeNull();
  });
});

describe('normalizeAdminNotes', () => {
  it('空・空白だけ・null は null、それ以外はそのまま (前後の空白も変えない)', () => {
    expect(normalizeAdminNotes(null)).toBeNull();
    expect(normalizeAdminNotes('')).toBeNull();
    expect(normalizeAdminNotes(' \n\t')).toBeNull();
    expect(normalizeAdminNotes('メモ')).toBe('メモ');
    expect(normalizeAdminNotes(' メモ ')).toBe(' メモ ');
  });
});

describe('inquiryAuditTarget (#1200: 閲覧された本人を対象にする)', () => {
  it('会員の問い合わせは会員 (user) を対象にする', () => {
    expect(inquiryAuditTarget({ id: I2, user_id: CUSTOMER_ID })).toEqual({ targetId: CUSTOMER_ID, targetType: 'user' });
  });

  it('ゲスト (user_id なし。会員が退会して user_id が外れた問い合わせも同じ) は問い合わせそのものを対象にする', () => {
    expect(inquiryAuditTarget({ id: I1, user_id: null })).toEqual({ targetId: I1, targetType: 'inquiry' });
  });
});

describe('inquiryUpdateBodySchema', () => {
  it('status / adminNotes のどちらか一方だけでもよい', () => {
    expect(inquiryUpdateBodySchema.safeParse({ status: 'resolved' }).success).toBe(true);
    expect(inquiryUpdateBodySchema.safeParse({ adminNotes: '' }).success).toBe(true);
    expect(inquiryUpdateBodySchema.safeParse({ adminNotes: null }).success).toBe(true);
  });

  it('未知のキーは捨てる', () => {
    const parsed = inquiryUpdateBodySchema.parse({ status: 'closed', resolved_at: 'x', message: 'y' });
    expect(parsed).toEqual({ status: 'closed' });
  });

  it('空のボディや不正な status は通さない', () => {
    expect(inquiryUpdateBodySchema.safeParse({}).success).toBe(false);
    expect(inquiryUpdateBodySchema.safeParse({ status: 'open' }).success).toBe(false);
    expect(inquiryUpdateBodySchema.safeParse({ status: undefined, adminNotes: undefined }).success).toBe(false);
  });
});
