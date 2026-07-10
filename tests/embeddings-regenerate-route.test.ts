/**
 * #1041 (F4-12) 回帰防止 contract テスト
 * POST /api/super-admin/embeddings/regenerate
 *
 * 従来は table のバリデーションを通過すると常に
 * `{ ok: true, message: '再生成ジョブをキューに追加しました' }` を返す偽成功だった。
 * 修正後は実際に Edge Function を呼び出し、失敗時は偽成功にせず 502/503 を返す。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const { POST } = await import('@/app/api/super-admin/embeddings/regenerate/route');

const ORIGINAL_ENV = { ...process.env };

function postRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/super-admin/embeddings/regenerate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({ id: 'sa-1', roles: ['super_admin'] });
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('POST /api/super-admin/embeddings/regenerate (#1041 F4-12)', () => {
  it('実スキーマに存在しない table (meals 等) は 400 で拒否する', async () => {
    const res = await POST(postRequest({ table: 'meals' }));
    expect(res.status).toBe(400);
  });

  it('Supabase 接続情報が未設定なら偽成功にせず 503 を返す', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const res = await POST(postRequest({ table: 'dataset_ingredients' }));
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_EMBEDDING_JOB_UNAVAILABLE');
  });

  it('Edge Function 呼び出し失敗時は偽成功にせず 502 を返す', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'internal edge error' }),
      }),
    );

    const res = await POST(postRequest({ table: 'dataset_ingredients' }));
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_EMBEDDING_JOB_FAILED');
  });

  it('Edge Function 成功時は実際の処理結果 (processed 等) を返す', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            success: true,
            processed: 42,
            offset: 0,
            nextOffset: 42,
            totalCount: 100,
            hasMore: true,
            message: 'Processed 42 rows',
          }),
      }),
    );

    const res = await POST(postRequest({ table: 'dataset_ingredients', onlyMissing: true }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; processed: number; hasMore: boolean };
    expect(json.ok).toBe(true);
    expect(json.processed).toBe(42);
    expect(json.hasMore).toBe(true);
  });
});
