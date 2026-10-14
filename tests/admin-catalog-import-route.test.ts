/**
 * #1172 POST /api/admin/catalog/import: Edge Function の成功の応答に入る商品ごとの失敗の文 (DB の生のエラー文) を本文に返さない
 *
 * 以前は Edge Function (import-runner.ts) の応答を `result: edgeData` でそのまま返していた。
 * 成功 (200) の応答でも stats.productErrors[].error には、商品の upsert が失敗したときの PostgREST の生のエラー文が入る。
 * 本文には件数 (productErrorCount) だけを返す。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireRole = vi.fn();
vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const mockAuditInsert = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: () => ({ insert: mockAuditInsert }) }),
}));

const { POST } = await import('@/app/api/admin/catalog/import/route');

/** 商品の upsert の失敗の文 (PostgREST の生のエラー文) の目印。本文に出てはいけない */
const RAW_DB_ERROR = 'duplicate key value violates unique constraint "catalog_products_sentinel_1172_key"';

const ORIGINAL_ENV = { ...process.env };

function postRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/admin/catalog/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function stubEdgeResponse(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve('') }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({ id: 'admin-1', roles: ['admin'] });
  mockAuditInsert.mockResolvedValue({ error: null });
  process.env = {
    ...ORIGINAL_ENV,
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('POST /api/admin/catalog/import (#1172)', () => {
  it('商品ごとの失敗の文は本文に入れず、件数と集計だけを返す', async () => {
    stubEdgeResponse({
      success: true,
      dryRun: false,
      importRunId: 'run-1',
      sourceCode: 'seven_eleven_jp',
      categoryCode: 'onigiri',
      stats: {
        pagesTotal: 2,
        productsSeen: 5,
        productsInserted: 1,
        productsUpdated: 1,
        productsUnchanged: 1,
        productsDiscontinued: 0,
        productErrors: [
          { categoryCode: 'onigiri', url: 'https://example.com/a', error: RAW_DB_ERROR },
          { categoryCode: 'onigiri', url: 'https://example.com/b', error: RAW_DB_ERROR },
        ],
      },
    });

    const res = await POST(postRequest({ sourceCode: 'seven_eleven_jp' }));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain('sentinel_1172');
    expect(text).not.toContain('productErrors');
    expect(JSON.parse(text)).toEqual({
      ok: true,
      sourceCode: 'seven_eleven_jp',
      result: {
        importRunId: 'run-1',
        dryRun: false,
        categoryCode: 'onigiri',
        stats: {
          pagesTotal: 2,
          productsSeen: 5,
          productsInserted: 1,
          productsUpdated: 1,
          productsUnchanged: 1,
          productsDiscontinued: 0,
          productErrorCount: 2,
        },
      },
    });
    expect(mockAuditInsert).toHaveBeenCalledTimes(1);
  });

  it('想定外の形の応答 (本文が読めない・型が違う) でも、中身を返さずに既定の集計を返す', async () => {
    stubEdgeResponse({ error: RAW_DB_ERROR, stats: 'broken' });

    const res = await POST(postRequest({ sourceCode: 'lawson_jp' }));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain('sentinel_1172');
    expect(JSON.parse(text).result).toEqual({
      importRunId: null,
      dryRun: false,
      categoryCode: null,
      stats: { productErrorCount: 0 },
    });
  });
});
