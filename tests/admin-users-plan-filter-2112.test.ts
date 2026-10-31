/**
 * GET /api/admin/users の plan の絞り込み (#2112 Z5)
 *
 * 以前は plan を受け取って監査 (admin.user.list) の検索条件に残すだけで一覧を絞らず、全プランの利用者を返していた
 * (監査には plan で絞ったように残った)。
 * - plan を受けたら plan_key_cached で絞る。応答の plan_key は plan_key_cached が空 (NULL) なら 'free' なので、
 *   plan=free は plan_key_cached が NULL か 'free' の行
 * - 件数より後ろのページの件数の数え直し (src/lib/api/list-range.ts) にも同じ絞り込みが効く
 * - 監査の検索条件の plan は、一覧の絞り込みに使った値 (前後の空白を除いた値。空なら残さない)
 *
 * 実際の DB で plan=pro が pro の行だけを返すことは tests/integration/operator/admin-users.test.ts で確かめる
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FREE_PLAN_KEY } from '@/lib/billing/core';

type Call = { method: string; args: unknown[] };
type BuilderResult = { data: unknown[] | null; error: unknown; count: number | null; status?: number };

/** PostgREST が「件数より後ろのページ」で返す HTTP ステータスと error.code (src/lib/api/list-range.ts と同じ) */
const RANGE_NOT_SATISFIABLE_STATUS = 416;
const RANGE_NOT_SATISFIABLE_CODE = 'PGRST103';
/** 数え直しで返す本当の件数 (テストの値) */
const RECOUNTED_TOTAL = 3;

const CHAIN_METHODS = ['select', 'or', 'not', 'is', 'eq', 'contains', 'gte', 'lt', 'lte', 'order', 'range'] as const;

/** from('user_profiles') ごとに作る builder の呼び出しの記録 (1 本目 = 一覧、2 本目 = 件数の数え直し) */
let builders: Call[][] = [];
/** from() の n 本目が返す結果 */
let results: BuilderResult[] = [];

function createTrackingBuilder(result: BuilderResult) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  CHAIN_METHODS.forEach((method) => {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  });
  // PostgrestFilterBuilder はそれ自体が thenable (await できる)
  builder.then = (resolve: (value: BuilderResult) => unknown) => resolve(result);
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

vi.mock('@/lib/admin/user-emails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/user-emails')>();
  return {
    ...actual,
    fetchUserEmails: vi.fn(async () => new Map<string, string>()),
    findUserIdsByEmail: vi.fn(async () => []),
  };
});

const mockRecordAdminAudit = vi.fn(async (_args: { details: Record<string, unknown> }) => undefined);
vi.mock('@/lib/admin/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/audit')>();
  return {
    ...actual,
    recordAdminAudit: (args: { details: Record<string, unknown> }) => mockRecordAdminAudit(args),
  };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({}),
  getSupabaseAdmin: () => ({
    from: (_table: string) => {
      const result = results[builders.length] ?? { data: [], error: null, count: 0 };
      const { builder, calls } = createTrackingBuilder(result);
      builders.push(calls);
      return builder;
    },
  }),
}));

const { GET } = await import('@/app/api/admin/users/route');

/** 一覧の 1 行 (user_profiles の select の形) */
function profileRow(id: string, planKeyCached: string | null) {
  return {
    id,
    nickname: `user-${id}`,
    roles: ['user'],
    organization_id: null,
    plan_key_cached: planKeyCached,
    last_login_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    frozen_at: null,
    frozen_reason: null,
    frozen_by: null,
    unban_at: null,
  };
}

/** plan_key_cached に当たる絞り込み (eq と or) だけを抜き出す */
function planFilterCalls(calls: Call[]): Call[] {
  return calls.filter(
    (c) =>
      (c.method === 'eq' && c.args[0] === 'plan_key_cached') ||
      (c.method === 'or' && String(c.args[0]).includes('plan_key_cached')),
  );
}

describe('GET /api/admin/users — plan の絞り込み (#2112 Z5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    builders = [];
    results = [];
  });

  it('plan=pro は plan_key_cached = pro で絞り、監査の検索条件の plan も pro', async () => {
    results = [{ data: [profileRow('u-pro', 'pro')], error: null, count: 1 }];
    const res = await GET(new Request('http://localhost/api/admin/users?plan=pro'));
    expect(res.status).toBe(200);

    expect(planFilterCalls(builders[0])).toEqual([{ method: 'eq', args: ['plan_key_cached', 'pro'] }]);

    const body = (await res.json()) as { data: Array<{ id: string; plan_key: string }>; meta: { total: number } };
    expect(body.data).toEqual([expect.objectContaining({ id: 'u-pro', plan_key: 'pro' })]);
    expect(body.meta.total).toBe(1);

    expect(mockRecordAdminAudit).toHaveBeenCalledTimes(1);
    const details = mockRecordAdminAudit.mock.calls[0][0].details as { filters: Record<string, unknown> };
    expect(details.filters.plan).toBe('pro');
  });

  it(`plan=${FREE_PLAN_KEY} は plan_key_cached が NULL か '${FREE_PLAN_KEY}' の行 (応答の plan_key と同じ意味) で絞る`, async () => {
    results = [{ data: [profileRow('u-null', null), profileRow('u-free', FREE_PLAN_KEY)], error: null, count: 2 }];
    const res = await GET(new Request(`http://localhost/api/admin/users?plan=${FREE_PLAN_KEY}`));
    expect(res.status).toBe(200);

    expect(planFilterCalls(builders[0])).toEqual([
      { method: 'or', args: [`plan_key_cached.is.null,plan_key_cached.eq.${FREE_PLAN_KEY}`] },
    ]);

    const body = (await res.json()) as { data: Array<{ id: string; plan_key: string }> };
    expect(body.data.map((u) => u.plan_key)).toEqual([FREE_PLAN_KEY, FREE_PLAN_KEY]);
    const details = mockRecordAdminAudit.mock.calls[0][0].details as { filters: Record<string, unknown> };
    expect(details.filters.plan).toBe(FREE_PLAN_KEY);
  });

  it('plan の前後の空白は除いて絞り、監査にも除いた値を残す', async () => {
    results = [{ data: [profileRow('u-pro', 'pro')], error: null, count: 1 }];
    const res = await GET(new Request('http://localhost/api/admin/users?plan=%20pro%20'));
    expect(res.status).toBe(200);

    expect(planFilterCalls(builders[0])).toEqual([{ method: 'eq', args: ['plan_key_cached', 'pro'] }]);
    const details = mockRecordAdminAudit.mock.calls[0][0].details as { filters: Record<string, unknown> };
    expect(details.filters.plan).toBe('pro');
  });

  it.each([
    ['plan なし', 'http://localhost/api/admin/users'],
    ['plan が空', 'http://localhost/api/admin/users?plan='],
    ['plan が空白だけ', 'http://localhost/api/admin/users?plan=%20%20'],
  ])('%s は plan で絞らず、監査の検索条件に plan を残さない', async (_label, url) => {
    results = [{ data: [profileRow('u-pro', 'pro'), profileRow('u-null', null)], error: null, count: 2 }];
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);

    expect(planFilterCalls(builders[0])).toEqual([]);
    const details = mockRecordAdminAudit.mock.calls[0][0].details as { filters: Record<string, unknown> };
    expect(details.filters).not.toHaveProperty('plan');
  });

  it('件数より後ろのページの件数の数え直しにも同じ plan の絞り込みが効く', async () => {
    results = [
      {
        data: null,
        error: { code: RANGE_NOT_SATISFIABLE_CODE, message: 'Requested range not satisfiable' },
        count: null,
        status: RANGE_NOT_SATISFIABLE_STATUS,
      },
      { data: null, error: null, count: RECOUNTED_TOTAL },
    ];
    const res = await GET(new Request('http://localhost/api/admin/users?plan=pro&page=9'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { total: number } };
    expect(body).toMatchObject({ data: [], meta: { total: RECOUNTED_TOTAL } });

    expect(builders).toHaveLength(2);
    // 2 本目 (数え直し) は行を取らずに数える (head) select で、一覧と同じ plan の絞り込みを持つ
    expect(builders[1].find((c) => c.method === 'select')?.args[1]).toEqual({ count: 'exact', head: true });
    expect(planFilterCalls(builders[1])).toEqual([{ method: 'eq', args: ['plan_key_cached', 'pro'] }]);
  });

  it(`plan=${FREE_PLAN_KEY} の数え直しも NULL か '${FREE_PLAN_KEY}' で絞る`, async () => {
    results = [
      {
        data: null,
        error: { code: RANGE_NOT_SATISFIABLE_CODE, message: 'Requested range not satisfiable' },
        count: null,
        status: RANGE_NOT_SATISFIABLE_STATUS,
      },
      { data: null, error: null, count: RECOUNTED_TOTAL },
    ];
    const res = await GET(new Request(`http://localhost/api/admin/users?plan=${FREE_PLAN_KEY}&page=9`));
    expect(res.status).toBe(200);
    expect(builders).toHaveLength(2);
    expect(planFilterCalls(builders[1])).toEqual([
      { method: 'or', args: [`plan_key_cached.is.null,plan_key_cached.eq.${FREE_PLAN_KEY}`] },
    ]);
  });
});
