/**
 * GET /api/admin/users の status フィルタ (banned/active) 意味論テスト
 * #1030 round-2 Warning: is_banned (レスポンス側, isAccountFrozen ベース) と
 * status フィルタ (クエリ側) の意味論を揃える。
 *
 * 一時 BAN が unban_at 経過で自動解除された場合:
 * - status=banned で検索したユーザー一覧から除外されるべき (もう凍結されていない)
 * - status=active で検索したユーザー一覧に含まれるべき
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Supabase admin client モック (呼び出しチェーンを記録する)
// ─────────────────────────────────────────────────────────────────────────────

type Call = { method: string; args: unknown[] };

function createTrackingBuilder(result: { data: unknown[]; error: unknown; count: number }) {
  const calls: Call[] = [];
  const chainMethods = [
    'select',
    'or',
    'not',
    'is',
    'contains',
    'gte',
    'lte',
    'order',
    'range',
  ] as const;

  const builder: Record<string, unknown> = {};
  chainMethods.forEach((method) => {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  });
  // PostgrestFilterBuilder はそれ自体が thenable (await できる)
  builder.then = (resolve: (value: typeof result) => unknown) => resolve(result);

  return { builder, calls };
}

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: vi.fn().mockResolvedValue({
    id: 'admin-id',
    email: 'admin@example.com',
    roles: ['admin'],
    organization_id: null,
  }),
}));

let latestCalls: Call[] = [];

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: (_table: string) => {
      const { builder, calls } = createTrackingBuilder({ data: [], error: null, count: 0 });
      latestCalls = calls;
      return builder;
    },
  }),
}));

import { GET } from '../src/app/api/admin/users/route';

function findOrArg(calls: Call[]): string | undefined {
  const orCall = calls.find((c) => c.method === 'or');
  return orCall?.args[0] as string | undefined;
}

describe('GET /api/admin/users — status フィルタの意味論', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    latestCalls = [];
  });

  it('status=banned は frozen_at IS NOT NULL かつ (unban_at IS NULL または未来) で絞り込む', async () => {
    const req = new Request('http://localhost/api/admin/users?status=banned');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const notCall = latestCalls.find((c) => c.method === 'not');
    expect(notCall?.args).toEqual(['frozen_at', 'is', null]);

    const orArg = findOrArg(latestCalls);
    expect(orArg).toBeDefined();
    expect(orArg).toMatch(/^unban_at\.is\.null,unban_at\.gt\.\d{4}-\d{2}-\d{2}T/);
  });

  it('status=active は未凍結、または一時 BAN 期限切れ (unban_at が過去) を含める', async () => {
    const req = new Request('http://localhost/api/admin/users?status=active');
    const res = await GET(req);
    expect(res.status).toBe(200);

    // 'active' では frozen_at IS NULL の単純フィルタ (.is) は使わず、
    // 期限切れ一時 BAN も含める .or() 表現に統一されている
    const isCall = latestCalls.find((c) => c.method === 'is');
    expect(isCall).toBeUndefined();

    const orArg = findOrArg(latestCalls);
    expect(orArg).toBeDefined();
    expect(orArg).toContain('frozen_at.is.null');
    expect(orArg).toMatch(
      /^frozen_at\.is\.null,and\(frozen_at\.not\.is\.null,unban_at\.not\.is\.null,unban_at\.lte\.\d{4}-\d{2}-\d{2}T[\d:.TZ-]+\)$/,
    );
  });

  it('status 未指定の場合は frozen 系フィルタを一切適用しない', async () => {
    const req = new Request('http://localhost/api/admin/users');
    const res = await GET(req);
    expect(res.status).toBe(200);

    expect(latestCalls.some((c) => c.method === 'not')).toBe(false);
    expect(latestCalls.some((c) => c.method === 'is')).toBe(false);
    expect(latestCalls.some((c) => c.method === 'or')).toBe(false);
  });
});
