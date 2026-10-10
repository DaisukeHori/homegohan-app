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

// 構造化ログ (app_logs への書き込み) は、呼ばれた中身だけ確かめる
const mockLogError = vi.fn();
const mockWithUser = vi.fn((_userId: string) => ({ error: mockLogError }));
vi.mock('@/lib/db-logger', () => ({
  generateRequestId: () => 'req-test',
  createLogger: () => ({ withUser: mockWithUser, error: mockLogError }),
}));

const { POST } = await import('@/app/api/super-admin/embeddings/regenerate/route');

/** Edge Function が包んで返す PostgREST の生のエラー文の目印。本文に出てはいけない */
const EDGE_RAW_ERROR = 'Fetch error: column dataset_ingredients.name_embedding_sentinel_1172 does not exist';

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

  it.each([
    { label: 'HTTP 500', ok: false, status: 500 },
    { label: 'HTTP 200 だが error を返した', ok: true, status: 200 },
  ])(
    '#1172: Edge Function が生のエラー文を返しても ($label)、502 の本文は固定の文 + HTTP ステータスだけ。元の文は構造化ログにだけ残す',
    async ({ ok, status }) => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok, status, json: () => Promise.resolve({ error: EDGE_RAW_ERROR }) }),
      );

      const res = await POST(postRequest({ table: 'dataset_ingredients' }));
      const raw = await res.text();

      expect(res.status).toBe(502);
      expect(raw).not.toContain(EDGE_RAW_ERROR);
      expect(raw).not.toContain('sentinel_1172');
      expect(JSON.parse(raw)).toEqual({
        error: { code: 'OP_EMBEDDING_JOB_FAILED', message: `埋め込み再生成ジョブが失敗しました (HTTP ${status})` },
      });
      expect(mockWithUser).toHaveBeenCalledWith('sa-1');
      expect(mockLogError).toHaveBeenCalledTimes(1);
      const [, loggedError, metadata] = mockLogError.mock.calls[0] as [string, Error, Record<string, unknown>];
      expect(loggedError.message).toBe(EDGE_RAW_ERROR);
      expect(metadata).toMatchObject({ table: 'dataset_ingredients', edge_status: status });
    },
  );

  it('#1172: Edge Function を呼び出せない (fetch が例外) ときも、502 の本文は固定の文。例外は構造化ログにだけ残す', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED sentinel-fetch-1172')));

    const res = await POST(postRequest({ table: 'dataset_ingredients' }));
    const raw = await res.text();

    expect(res.status).toBe(502);
    expect(raw).not.toContain('sentinel-fetch-1172');
    expect(JSON.parse(raw)).toEqual({
      error: { code: 'OP_EMBEDDING_JOB_FAILED', message: '埋め込み再生成ジョブの呼び出しに失敗しました' },
    });
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect((mockLogError.mock.calls[0] as unknown[])[1]).toMatchObject({ message: 'connect ECONNREFUSED sentinel-fetch-1172' });
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
