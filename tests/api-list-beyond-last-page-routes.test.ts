/**
 * #1917 一覧の API の「件数より後ろのページ」と「DB の失敗」の route テスト
 *
 * 以前は、`.range()` を使う一覧の route のうち、組織・問い合わせ・お気に入りの一覧だけが 416 (PGRST103) を扱っていた。
 * ほかの一覧 (運営の利用者・問い合わせのチケット・営業リード・会計・監査ログ・プラン・クーポン・実験・機能パッケージ・
 * インフラの警告・メンバーシップの監査・クーポンの適用履歴) は 500 になり、レシピの一覧は DB の失敗を 200 の空 (total 0) で返した。
 *
 * 直したあとの不変条件 (route ごとに確かめる):
 *  - 件数より後ろのページ (HTTP 416 / PGRST103) は 200 で、空のページと本当の件数を返す。件数は一覧と同じ絞り込みで、
 *    行を取らずに (head) 数え直す
 *  - 件数の数え直しも失敗したら 500
 *  - それ以外の DB の失敗は 500 (200 の空の一覧にしない)。DB の生の文面は本文に出さない
 *
 * PostgREST の呼び出しは、ここで作る小さな偽物が受ける。偽物は route が組み立てたクエリ (テーブル・head・範囲・絞り込み) を記録し、
 * テストが決めた応答を返す。
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RecordedQuery {
  table: string;
  head: boolean;
  range: [number, number] | null;
  /** 絞り込み (select / order / range / limit 以外の呼び出し) を、呼んだ順に */
  filters: string[];
  single: boolean;
}

interface QueryResult {
  data: unknown;
  error: { code?: string; message: string } | null;
  count: number | null;
  status: number;
}

const ACTOR_ID = '00000000-0000-4000-8000-000000000001';
const COUPON_ID = '00000000-0000-4000-8000-0000000000c1';
/** 数え直したときの本当の件数 */
const TOTAL = 42;
/** DB の生のエラー文 (本文に出てはいけない) */
const RAW_DB_MESSAGE = 'connection reset by peer';

let queries: RecordedQuery[] = [];
/** 範囲つきの読み出し (一覧) への応答 */
let listResult: QueryResult;
/** 件数だけの読み出し (head) への応答 */
let countResult: QueryResult;

const ok = (data: unknown, count: number | null): QueryResult => ({ data, error: null, count, status: 200 });
const fail = (status: number, error: { code?: string; message: string }): QueryResult => ({ data: null, error, count: null, status });
const RANGE_NOT_SATISFIABLE = fail(416, { code: 'PGRST103', message: 'Requested range not satisfiable' });
/** ローカルの Supabase では 416 の本文が途中で切れて code が取れないことがある */
const RANGE_NOT_SATISFIABLE_TRUNCATED = fail(416, { message: '{"' });
const DB_FAILURE = fail(503, { code: '08006', message: RAW_DB_MESSAGE });

function respond(rec: RecordedQuery): QueryResult {
  if (rec.range) return listResult;
  if (rec.head) return countResult;
  if (rec.single && rec.table === 'coupons') return ok({ id: COUPON_ID, code: 'WELCOME' }, null);
  return ok([], 0);
}

function fakeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    from(table: string) {
      const rec: RecordedQuery = { table, head: false, range: null, filters: [], single: false };
      const run = () => {
        queries.push(rec);
        return Promise.resolve(respond(rec));
      };
      const builder: Record<string, unknown> = {
        select(_columns: string, options?: { head?: boolean }) {
          rec.head = options?.head === true;
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        range(from: number, to: number) {
          rec.range = [from, to];
          return builder;
        },
        maybeSingle() {
          rec.single = true;
          return run();
        },
        single() {
          rec.single = true;
          return run();
        },
        then<T1, T2>(onFulfilled?: (value: QueryResult) => T1 | PromiseLike<T1>, onRejected?: (reason: unknown) => T2 | PromiseLike<T2>) {
          return run().then(onFulfilled, onRejected);
        },
      };
      for (const method of ['eq', 'neq', 'in', 'gte', 'lte', 'lt', 'gt', 'ilike', 'is', 'not', 'or', 'contains']) {
        builder[method] = (...args: unknown[]) => {
          rec.filters.push(`${method}(${JSON.stringify(args)})`);
          return builder;
        };
      }
      return builder;
    },
  };
}

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: vi.fn(async () => ({ id: ACTOR_ID, roles: ['super_admin', 'admin', 'support', 'sales', 'finance'] })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => fakeClient(),
  getSupabaseAdmin: () => fakeClient(),
}));

vi.mock('@/lib/admin/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/audit')>()),
  recordAdminAudit: vi.fn(async () => undefined),
}));

vi.mock('@/lib/admin/user-emails', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/user-emails')>()),
  fetchUserEmails: vi.fn(async () => new Map<string, string>()),
  findUserIdsByEmail: vi.fn(async () => []),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createLogger: vi.fn(() => ({ ...logger, withUser: vi.fn(() => logger) })),
    generateRequestId: vi.fn(() => 'req_test'),
  };
});

interface ListRouteCase {
  name: string;
  /** 一覧のテーブル */
  table: string;
  /** 範囲外のページを指す要求を送る (ページ番号は大きい値・絞り込みを 1 つ付ける) */
  call: () => Promise<Response>;
  /** 本文から一覧の配列と件数を取り出す */
  pick: (body: Record<string, any>) => { rows: unknown; total: unknown };
}

const nextGet = (url: string) => new NextRequest(url);
const standardPick = (body: Record<string, any>) => ({ rows: body.data, total: body.meta?.total });

const CASES: ListRouteCase[] = [
  {
    name: 'GET /api/admin/support/tickets',
    table: 'support_tickets',
    call: async () => (await import('@/app/api/admin/support/tickets/route')).GET(nextGet('http://localhost/api/admin/support/tickets?page=9&status=open')),
    pick: standardPick,
  },
  {
    name: 'GET /api/admin/sales/leads',
    table: 'sales_leads',
    call: async () => (await import('@/app/api/admin/sales/leads/route')).GET(nextGet('http://localhost/api/admin/sales/leads?page=9&stage=meeting')),
    pick: standardPick,
  },
  {
    name: 'GET /api/admin/users',
    table: 'user_profiles',
    call: async () => (await import('@/app/api/admin/users/route')).GET(new Request('http://localhost/api/admin/users?page=9&status=active')),
    pick: standardPick,
  },
  {
    name: 'GET /api/admin/finance/invoices',
    table: 'stripe_webhook_events',
    call: async () => (await import('@/app/api/admin/finance/invoices/route')).GET(nextGet('http://localhost/api/admin/finance/invoices?page=9&status=completed')),
    pick: standardPick,
  },
  {
    name: 'GET /api/admin/finance/revenue',
    table: 'revenue_snapshots',
    call: async () => (await import('@/app/api/admin/finance/revenue/route')).GET(nextGet('http://localhost/api/admin/finance/revenue?page=9&from=2026-01-01')),
    pick: standardPick,
  },
  {
    name: 'GET /api/admin/finance/reconciliation',
    table: 'admin_audit_logs',
    call: async () => (await import('@/app/api/admin/finance/reconciliation/route')).GET(nextGet('http://localhost/api/admin/finance/reconciliation?page=9&from=2026-01-01')),
    pick: (body) => ({ rows: body.data?.discrepancies, total: body.meta?.total }),
  },
  {
    name: 'GET /api/super-admin/audit-logs',
    table: 'admin_audit_logs',
    call: async () => (await import('@/app/api/super-admin/audit-logs/route')).GET(nextGet(`http://localhost/api/super-admin/audit-logs?page=9&actor_id=${ACTOR_ID}`)),
    pick: standardPick,
  },
  {
    name: 'GET /api/super-admin/coupons',
    table: 'coupons',
    call: async () => (await import('@/app/api/super-admin/coupons/route')).GET(nextGet('http://localhost/api/super-admin/coupons?page=9&status=active')),
    pick: standardPick,
  },
  {
    name: 'GET /api/super-admin/coupons/[id]/redemptions',
    table: 'coupon_redemptions',
    call: async () =>
      (await import('@/app/api/super-admin/coupons/[id]/redemptions/route')).GET(
        nextGet(`http://localhost/api/super-admin/coupons/${COUPON_ID}/redemptions?page=9`),
        { params: Promise.resolve({ id: COUPON_ID }) },
      ),
    pick: standardPick,
  },
  {
    name: 'GET /api/super-admin/experiments',
    table: 'experiments',
    call: async () => (await import('@/app/api/super-admin/experiments/route')).GET(nextGet('http://localhost/api/super-admin/experiments?page=9&status=running')),
    pick: standardPick,
  },
  {
    name: 'GET /api/super-admin/feature-packages',
    table: 'feature_packages',
    call: async () => (await import('@/app/api/super-admin/feature-packages/route')).GET(nextGet('http://localhost/api/super-admin/feature-packages?page=9&status=active')),
    pick: standardPick,
  },
  {
    name: 'GET /api/super-admin/infra/alerts',
    table: 'infra_alerts',
    call: async () => (await import('@/app/api/super-admin/infra/alerts/route')).GET(nextGet('http://localhost/api/super-admin/infra/alerts?page=9&resolved=false')),
    pick: standardPick,
  },
  {
    name: 'GET /api/super-admin/plans',
    table: 'subscription_plans',
    call: async () => (await import('@/app/api/super-admin/plans/route')).GET(nextGet('http://localhost/api/super-admin/plans?page=9&status=public')),
    pick: standardPick,
  },
  {
    name: 'GET /api/operator/membership/audit',
    table: 'membership_audit',
    call: async () => (await import('@/app/api/operator/membership/audit/route')).GET(nextGet('http://localhost/api/operator/membership/audit?page=9&scope=family')),
    pick: standardPick,
  },
  {
    name: 'GET /api/recipes',
    table: 'recipes',
    call: async () => (await import('@/app/api/recipes/route')).GET(new Request('http://localhost/api/recipes?page=9&category=main')),
    pick: (body) => ({ rows: body.recipes, total: body.pagination?.total }),
  },
];

beforeEach(() => {
  queries = [];
  listResult = ok([], 0);
  countResult = ok(null, TOTAL);
});

/** 一覧のテーブルへの、範囲つきの読み出しと件数だけの読み出し */
function listAndCountQueries(table: string) {
  const onTable = queries.filter((q) => q.table === table && !q.single);
  return { list: onTable.filter((q) => q.range), counts: onTable.filter((q) => q.head) };
}

describe.each(CASES)('$name', ({ table, call, pick }) => {
  it('件数より後ろのページ (416 / PGRST103) は 200 で、空のページと、同じ絞り込みで数え直した件数を返す', async () => {
    listResult = RANGE_NOT_SATISFIABLE;
    const res = await call();
    expect(res.status).toBe(200);
    const { rows, total } = pick((await res.json()) as Record<string, any>);
    expect(rows).toEqual([]);
    expect(total).toBe(TOTAL);
    const { list, counts } = listAndCountQueries(table);
    expect(list).toHaveLength(1);
    expect(counts).toHaveLength(1);
    // 数え直しは行を取らず (head)、一覧と同じ絞り込み
    expect(counts[0].range).toBeNull();
    expect(counts[0].filters).toEqual(list[0].filters);
    expect(list[0].filters.length).toBeGreaterThan(0);
  });

  it('416 の本文が切れて code が取れなくても、HTTP 416 で範囲外のページと分かる', async () => {
    listResult = RANGE_NOT_SATISFIABLE_TRUNCATED;
    const res = await call();
    expect(res.status).toBe(200);
    expect(pick((await res.json()) as Record<string, any>)).toEqual({ rows: [], total: TOTAL });
  });

  it('件数の数え直しも失敗したら 500 (0 件にしない)', async () => {
    listResult = RANGE_NOT_SATISFIABLE;
    countResult = DB_FAILURE;
    const res = await call();
    expect(res.status).toBe(500);
  });

  it('ほかの DB の失敗は 500 (200 の空の一覧にしない)。数え直さず、DB の生の文面は本文に出さない', async () => {
    listResult = DB_FAILURE;
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(RAW_DB_MESSAGE);
    expect(listAndCountQueries(table).counts).toHaveLength(0);
  });

  it('範囲内のページは、読んだ行と件数をそのまま返し、数え直さない', async () => {
    listResult = ok([], 3);
    const res = await call();
    expect(res.status).toBe(200);
    expect(pick((await res.json()) as Record<string, any>).total).toBe(3);
    expect(listAndCountQueries(table).counts).toHaveLength(0);
  });
});
