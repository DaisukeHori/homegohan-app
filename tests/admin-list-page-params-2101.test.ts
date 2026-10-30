// @vitest-environment node
/**
 * #2101 X6 (triage-1030b) のテスト: 運営の一覧の API の page / per_page の読み方
 *
 * 以前:
 *  - A/B テストの一覧 (GET /api/super-admin/experiments) は `Math.max(1, parseInt(page))` で読んでいた。
 *    Math.max(1, NaN) は NaN なので、?page=abc は NaN のまま `.range(NaN, NaN)` に渡り (PostgREST では 500)、
 *    応答の meta.page は null (JSON の NaN) になっていた
 *  - 整合チェック (GET /api/admin/finance/reconciliation) は `parseInt(page)` だけで、NaN も 0・負の数も通していた
 *    (?page=0 で負の offset)。per_page に上限も無かった
 *  - 同じ会計の一覧の請求書 (invoices)・売上 (revenue) は Zod の `.parse` が投げる例外を外側の catch で 500 にしていた
 *
 * 直したあと (どの route も同じ):
 *  - page / per_page が 1 以上の整数でない (数でない・0・負・小数)・per_page が上限より大きいときは、DB に触れずに 400 を返し、
 *    本文の message は日本語の文 (項目の名前を括弧で添える)。500 にしない・NaN を DB に渡さない
 *  - 上限は今までの値: A/B テストは 100、会計の 3 本は 200 (請求書・売上の InvoiceQuerySchema / RevenueQuerySchema と同じ)
 *  - 正しい page / per_page は今までどおり、その範囲の行を読む。省略したときは 1 ページ目・50 件
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// route を丸ごと読み込むので、負荷の高い機械で既定の時間切れを超えうる (#1605 の同じ型)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

interface RecordedQuery {
  table: string;
  range: [number, number] | null;
}

const ACTOR_ID = '00000000-0000-4000-8000-000000000001';

let queries: RecordedQuery[] = [];

function fakeClient() {
  return {
    from(table: string) {
      const rec: RecordedQuery = { table, range: null };
      const run = () => {
        queries.push(rec);
        return Promise.resolve({ data: [], error: null, count: 0, status: 200 });
      };
      const builder: Record<string, unknown> = {
        range(from: number, to: number) {
          rec.range = [from, to];
          return builder;
        },
        then<T1, T2>(onFulfilled?: (value: unknown) => T1 | PromiseLike<T1>, onRejected?: (reason: unknown) => T2 | PromiseLike<T2>) {
          return run().then(onFulfilled, onRejected);
        },
      };
      for (const method of ['select', 'order', 'limit', 'eq', 'in', 'gte', 'lte']) {
        builder[method] = () => builder;
      }
      return builder;
    },
  };
}

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: vi.fn(async () => ({ id: ACTOR_ID, roles: ['super_admin', 'admin', 'finance'] })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => fakeClient(),
  getSupabaseAdmin: () => fakeClient(),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createLogger: vi.fn(() => ({ ...logger, withUser: vi.fn(() => logger) })),
    generateRequestId: vi.fn(() => 'req_test'),
  };
});

/** 日本語の文 (ひらがな・カタカナ・漢字を 1 文字でも含む) */
const JAPANESE_TEXT = /[぀-ヿ㐀-鿿]/;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
/** 省略したときの 1 ページの件数 (どの route も 50) */
const DEFAULT_PER_PAGE = 50;

interface RouteCase {
  name: string;
  /** 一覧のテーブル */
  table: string;
  /** 400 の本文の error.code */
  invalidCode: string;
  /** per_page の上限 (今までの値) */
  perPageMax: number;
  call: (query: string) => Promise<Response>;
}

const get = (path: string, query: string) => new NextRequest(`http://localhost${path}${query ? `?${query}` : ''}`);

const CASES: RouteCase[] = [
  {
    name: 'GET /api/super-admin/experiments',
    table: 'experiments',
    invalidCode: 'OP_INVALID_QUERY',
    perPageMax: 100,
    call: async (query) => (await import('@/app/api/super-admin/experiments/route')).GET(get('/api/super-admin/experiments', query)),
  },
  {
    name: 'GET /api/admin/finance/reconciliation',
    table: 'admin_audit_logs',
    invalidCode: 'VALIDATION_ERROR',
    perPageMax: 200,
    call: async (query) => (await import('@/app/api/admin/finance/reconciliation/route')).GET(get('/api/admin/finance/reconciliation', query)),
  },
  {
    name: 'GET /api/admin/finance/invoices',
    table: 'stripe_webhook_events',
    invalidCode: 'VALIDATION_ERROR',
    perPageMax: 200,
    call: async (query) => (await import('@/app/api/admin/finance/invoices/route')).GET(get('/api/admin/finance/invoices', query)),
  },
  {
    name: 'GET /api/admin/finance/revenue',
    table: 'revenue_snapshots',
    invalidCode: 'VALIDATION_ERROR',
    perPageMax: 200,
    call: async (query) => (await import('@/app/api/admin/finance/revenue/route')).GET(get('/api/admin/finance/revenue', query)),
  },
];

/** 1 以上の整数でない値 (数でない・後ろに文字・0・負・小数・空) */
const INVALID_NUMBERS: Array<[string, string]> = [
  ['数でない', 'abc'],
  ['数の後ろに文字', '2abc'],
  ['0', '0'],
  ['負の数', '-1'],
  ['小数', '1.5'],
  ['空', ''],
];

beforeEach(() => {
  queries = [];
});

function listQueries(table: string): RecordedQuery[] {
  return queries.filter((q) => q.table === table && q.range !== null);
}

describe.each(CASES)('#2101 X6 $name', ({ table, invalidCode, perPageMax, call }) => {
  it.each(INVALID_NUMBERS)('page が%s (%s) なら、DB に触れずに日本語の文の 400 を返す (500 にしない・NaN を渡さない)', async (_label, value) => {
    const res = await call(`page=${encodeURIComponent(value)}`);
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(invalidCode);
    expect(body.error.message).toMatch(JAPANESE_TEXT);
    expect(body.error.message).toContain('page');
    expect(listQueries(table)).toEqual([]);
  });

  it.each(INVALID_NUMBERS)('per_page が%s (%s) なら、DB に触れずに日本語の文の 400 を返す', async (_label, value) => {
    const res = await call(`per_page=${encodeURIComponent(value)}`);
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(invalidCode);
    expect(body.error.message).toMatch(JAPANESE_TEXT);
    expect(body.error.message).toContain('per_page');
    expect(listQueries(table)).toEqual([]);
  });

  it('per_page が上限より大きければ 400、上限ちょうどは読む', async () => {
    const over = await call(`per_page=${perPageMax + 1}`);
    expect(over.status).toBe(HTTP_BAD_REQUEST);
    expect(listQueries(table)).toEqual([]);

    const atMax = await call(`per_page=${perPageMax}`);
    expect(atMax.status).toBe(HTTP_OK);
    expect(listQueries(table).map((q) => q.range)).toEqual([[0, perPageMax - 1]]);
  });

  it('正しい page / per_page は、その範囲の行を読み、meta に数で返す', async () => {
    const res = await call('page=3&per_page=10');
    expect(res.status).toBe(HTTP_OK);
    expect(listQueries(table).map((q) => q.range)).toEqual([[20, 29]]);
    const body = (await res.json()) as { meta: { page: unknown; per_page: unknown } };
    expect(body.meta.page).toBe(3);
    expect(body.meta.per_page).toBe(10);
  });

  it('page / per_page を省略したときは 1 ページ目・50 件を読む', async () => {
    const res = await call('');
    expect(res.status).toBe(HTTP_OK);
    expect(listQueries(table).map((q) => q.range)).toEqual([[0, DEFAULT_PER_PAGE - 1]]);
    const body = (await res.json()) as { meta: { page: unknown; per_page: unknown } };
    expect(body.meta.page).toBe(1);
    expect(body.meta.per_page).toBe(DEFAULT_PER_PAGE);
  });
});
