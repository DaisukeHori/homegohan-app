/**
 * GET /api/admin/users, GET /api/admin/users/[id] — メールアドレス (#1145)
 *
 * 修正前は email が常に null だった。修正後:
 *   - admin / super_admin: auth.users のメールを、一覧に出た id (詳細は 1 件) のぶんだけ引いて email に入れる。
 *     検索語 q はメールの部分一致 (RPC) も対象。
 *   - support: 一覧・詳細は見られるが、メールは引かない (RPC を呼ばない)。メールでの検索も効かせない。
 *   - 認可 (requireRole の許可ロール) は変えない。未認証 401 / 権限なし 403 では何も引かない。
 *   - auth.admin.listUsers() は使わない (先頭 50 件しか引けない。#1204)。
 *   - 取得に失敗しても一覧・詳細は 200 で返し (email は null)、失敗はログに残す。ログにメールアドレスは出さない。
 *
 * Supabase クライアントはモック。実 DB での検証は tests/integration/security/admin-users-email.test.ts と
 * tests/integration/rls/admin-user-email-rpc.test.ts。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthError, ForbiddenError } from '../src/lib/auth/errors';

// ─────────────────────────────────────────────────────────────────────────────
// モック
// ─────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  listUsers: vi.fn(),
  loggerError: vi.fn(),
  fromCalls: [] as string[],
  calls: [] as Array<{ key: string; method: string; args: unknown[] }>,
  results: {} as Record<string, unknown>,
}));

/** PostgrestFilterBuilder 相当: どのメソッドでも自分自身を返し、await すると results[key] で解決する */
function makeBuilder(key: string) {
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => unknown) =>
            resolve(mocks.results[key] ?? { data: null, error: null, count: 0 });
        }
        return (...args: unknown[]) => {
          mocks.calls.push({ key, method: String(prop), args });
          return builder;
        };
      },
    },
  );
  return builder;
}

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: mocks.requireRole,
}));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      mocks.fromCalls.push(table);
      return makeBuilder(table);
    },
    rpc: mocks.rpc,
    auth: { admin: { listUsers: mocks.listUsers } },
  }),
  // 詳細ルートがセッション付きクライアントで読むテーブル (support_tickets など)
  createClient: () => ({
    from: (table: string) => makeBuilder(`session:${table}`),
  }),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.loggerError,
    withUser: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.loggerError }),
  }),
  generateRequestId: () => 'req_test',
}));

import { GET as listGET } from '../src/app/api/admin/users/route';
import { GET as detailGET } from '../src/app/api/admin/users/[id]/route';

// ─────────────────────────────────────────────────────────────────────────────
// テストデータ
// ─────────────────────────────────────────────────────────────────────────────

const ID_1 = '11111111-1111-4111-8111-111111111111';
const ID_2 = '22222222-2222-4222-8222-222222222222';
const ID_3 = '33333333-3333-4333-8333-333333333333';
const EMAIL_1 = 'one@example.com';
const EMAIL_2 = 'two@example.com';

function profile(id: string, nickname: string) {
  return {
    id,
    nickname,
    roles: ['user'],
    organization_id: null,
    plan_key_cached: null,
    last_login_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    frozen_at: null,
    frozen_reason: null,
    frozen_by: null,
    unban_at: null,
  };
}

const ROWS = [profile(ID_1, 'one'), profile(ID_2, 'two'), profile(ID_3, 'three')];

/** 管理 API が引くメール (ID_3 はメールを持たないユーザー) */
const EMAIL_RESPONSE = {
  data: [
    { user_id: ID_1, email: EMAIL_1 },
    { user_id: ID_2, email: EMAIL_2 },
  ],
  error: null,
};

function actor(...roles: string[]) {
  return { id: 'actor-id', email: 'actor@example.com', roles, organization_id: null };
}

interface ListBody {
  data: Array<{ id: string; email: string | null; nickname: string | null }>;
  meta: { total: number };
}

function orArgs(): string[] {
  return mocks.calls.filter((c) => c.method === 'or').map((c) => c.args[0] as string);
}

function rpcNames(): string[] {
  return mocks.rpc.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fromCalls.length = 0;
  mocks.calls.length = 0;
  mocks.results = { user_profiles: { data: ROWS, error: null, count: ROWS.length } };
  mocks.requireRole.mockResolvedValue(actor('admin'));
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'admin_user_emails') return EMAIL_RESPONSE;
    if (name === 'admin_find_user_ids_by_email') return { data: [ID_1], error: null };
    return { data: null, error: { code: '42883', message: 'unexpected rpc' } };
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 一覧
// ═════════════════════════════════════════════════════════════════════════════

describe('GET /api/admin/users — メールアドレス', () => {
  it('admin: 一覧の各行に auth.users のメールが入る (メールを持たないユーザーは null)', async () => {
    const res = await listGET(new Request('http://localhost/api/admin/users'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.data.map((u) => [u.id, u.email])).toEqual([
      [ID_1, EMAIL_1],
      [ID_2, EMAIL_2],
      [ID_3, null],
    ]);
  });

  it('メールを引くのは「一覧に出た id」だけ (1 回の RPC。listUsers() は使わない)', async () => {
    await listGET(new Request('http://localhost/api/admin/users'));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('admin_user_emails', { p_ids: [ID_1, ID_2, ID_3] });
    expect(mocks.listUsers).not.toHaveBeenCalled();
  });

  it('super_admin も同様にメールが入る', async () => {
    mocks.requireRole.mockResolvedValue(actor('super_admin'));
    const res = await listGET(new Request('http://localhost/api/admin/users'));
    const body = (await res.json()) as ListBody;
    expect(body.data[0].email).toBe(EMAIL_1);
  });

  it('support を兼ねていても admin なら見える', async () => {
    mocks.requireRole.mockResolvedValue(actor('support', 'admin'));
    const res = await listGET(new Request('http://localhost/api/admin/users'));
    const body = (await res.json()) as ListBody;
    expect(body.data[0].email).toBe(EMAIL_1);
  });

  it('support: 一覧は 200 だが、メールは引かず全員 null (RPC を一度も呼ばない)', async () => {
    mocks.requireRole.mockResolvedValue(actor('support'));
    const res = await listGET(new Request('http://localhost/api/admin/users'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.data).toHaveLength(3);
    expect(body.data.every((u) => u.email === null)).toBe(true);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.listUsers).not.toHaveBeenCalled();
  });

  it('一覧が 0 件ならメールを引きに行かない', async () => {
    mocks.results = { user_profiles: { data: [], error: null, count: 0 } };
    const res = await listGET(new Request('http://localhost/api/admin/users'));
    expect(res.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('認可は従来どおり (admin / super_admin / support)。応答はキャッシュさせない', async () => {
    const res = await listGET(new Request('http://localhost/api/admin/users'));
    expect(mocks.requireRole).toHaveBeenCalledWith(['admin', 'super_admin', 'support']);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('未認証は 401、権限なしは 403。どちらも DB もメールも引かない', async () => {
    mocks.requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    const unauthenticated = await listGET(new Request('http://localhost/api/admin/users'));
    expect(unauthenticated.status).toBe(401);

    mocks.requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED'));
    const forbidden = await listGET(new Request('http://localhost/api/admin/users'));
    expect(forbidden.status).toBe(403);

    expect(mocks.fromCalls).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/users — メールアドレスでの検索', () => {
  it('admin: メールの部分一致で見つかった user_id を or フィルタに足す', async () => {
    await listGET(new Request('http://localhost/api/admin/users?q=one%40example.com'));
    expect(mocks.rpc).toHaveBeenCalledWith('admin_find_user_ids_by_email', {
      p_q: 'one@example.com',
      p_limit: 100,
    });
    expect(orArgs()).toEqual([`nickname.ilike."%one@example.com%",id.in.(${ID_1})`]);
  });

  it('support: メール検索の RPC を呼ばない (検索でメールの存在を推測させない)。ニックネームと ID だけ', async () => {
    mocks.requireRole.mockResolvedValue(actor('support'));
    await listGET(new Request('http://localhost/api/admin/users?q=one%40example.com'));
    expect(rpcNames()).not.toContain('admin_find_user_ids_by_email');
    expect(orArgs()).toEqual(['nickname.ilike."%one@example.com%"']);
  });

  it('メールが一致しなければ nickname の条件だけ', async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'admin_find_user_ids_by_email' ? { data: [], error: null } : EMAIL_RESPONSE,
    );
    await listGET(new Request('http://localhost/api/admin/users?q=tanaka'));
    expect(orArgs()).toEqual(['nickname.ilike."%tanaka%"']);
  });

  it('UUID の形の検索語は id の一致も足す', async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'admin_find_user_ids_by_email' ? { data: [], error: null } : EMAIL_RESPONSE,
    );
    await listGET(new Request(`http://localhost/api/admin/users?q=${ID_2.toUpperCase()}`));
    expect(orArgs()).toEqual([`nickname.ilike."%${ID_2.toUpperCase()}%",id.eq.${ID_2}`]);
  });

  it('検索語の "," ")" は引用符の中に収まり、or の構文を壊さない', async () => {
    await listGET(new Request(`http://localhost/api/admin/users?q=${encodeURIComponent('a,b)')}`));
    const filters = orArgs();
    expect(filters).toHaveLength(1);
    expect(filters[0].startsWith('nickname.ilike."%a,b)%"')).toBe(true);
  });

  it('空白だけの検索語は検索しない (or を付けず、メール検索も呼ばない)', async () => {
    await listGET(new Request('http://localhost/api/admin/users?q=%20%20'));
    expect(orArgs()).toEqual([]);
    expect(rpcNames()).not.toContain('admin_find_user_ids_by_email');
  });

  it('status フィルタと組み合わせると、検索の or と status の or は別々に付く (AND になる)', async () => {
    await listGET(new Request('http://localhost/api/admin/users?q=tanaka&status=banned'));
    const filters = orArgs();
    expect(filters).toHaveLength(2);
    expect(filters[0]).toContain('nickname.ilike.');
    expect(filters[1]).toMatch(/^unban_at\.is\.null,unban_at\.gt\./);
  });
});

describe('GET /api/admin/users — メールの取得に失敗したとき', () => {
  it('メール取得の RPC がエラーでも 200。email は null で、失敗はログに残る (メールアドレスは出さない)', async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'admin_user_emails'
        ? { data: null, error: { code: '42883', message: 'function public.admin_user_emails does not exist' } }
        : { data: [], error: null },
    );
    const res = await listGET(new Request('http://localhost/api/admin/users'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.data).toHaveLength(3);
    expect(body.data.every((u) => u.email === null)).toBe(true);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(mocks.loggerError.mock.calls);
    expect(logged).toContain('42883');
    expect(logged).not.toContain('example.com');
  });

  it('メール検索の RPC がエラーでも、ニックネームと ID の検索は続く (200。検索語はログに出さない)', async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'admin_find_user_ids_by_email'
        ? { data: null, error: { code: '42883', message: 'does not exist' } }
        : EMAIL_RESPONSE,
    );
    const res = await listGET(new Request('http://localhost/api/admin/users?q=secret-token%40example.com'));
    expect(res.status).toBe(200);
    expect(orArgs()).toEqual(['nickname.ilike."%secret-token@example.com%"']);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('secret-token');
    // メールの表示は引き続き動く
    const body = (await res.json()) as ListBody;
    expect(body.data[0].email).toBe(EMAIL_1);
  });

  it('RPC が例外を投げても 200 (email は null)', async () => {
    mocks.rpc.mockRejectedValue(new Error('network down'));
    const res = await listGET(new Request('http://localhost/api/admin/users?q=tanaka'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.data.every((u) => u.email === null)).toBe(true);
    expect(mocks.loggerError).toHaveBeenCalled();
  });

  it('メール検索が UUID でない値を返しても or に入れない', async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'admin_find_user_ids_by_email'
        ? { data: [`${ID_1}),id.eq.x`, ID_2], error: null }
        : EMAIL_RESPONSE,
    );
    await listGET(new Request('http://localhost/api/admin/users?q=foo'));
    expect(orArgs()).toEqual([`nickname.ilike."%foo%",id.in.(${ID_2})`]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 詳細
// ═════════════════════════════════════════════════════════════════════════════

interface DetailBody {
  data: { id: string; email: string | null; nickname: string | null };
}

function detailCtx(id: string) {
  return { params: { id } };
}

describe('GET /api/admin/users/[id] — メールアドレス', () => {
  beforeEach(() => {
    mocks.results = {
      user_profiles: { data: profile(ID_1, 'one'), error: null },
      'session:support_tickets': { count: 0, error: null },
      'session:personal_subscriptions': { data: null, error: null },
      'session:admin_audit_logs': { data: [], error: null },
    };
  });

  it('admin: 詳細の email に auth.users のメールが入る (引くのはその 1 件だけ)', async () => {
    const res = await detailGET(new Request(`http://localhost/api/admin/users/${ID_1}`), detailCtx(ID_1));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DetailBody;
    expect(body.data.id).toBe(ID_1);
    expect(body.data.email).toBe(EMAIL_1);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('admin_user_emails', { p_ids: [ID_1] });
    expect(mocks.listUsers).not.toHaveBeenCalled();
  });

  it('super_admin も同様', async () => {
    mocks.requireRole.mockResolvedValue(actor('super_admin'));
    const res = await detailGET(new Request(`http://localhost/api/admin/users/${ID_1}`), detailCtx(ID_1));
    const body = (await res.json()) as DetailBody;
    expect(body.data.email).toBe(EMAIL_1);
  });

  it('support: 詳細は 200 だが email は null (RPC を呼ばない。応答のどこにもメールが出ない)', async () => {
    mocks.requireRole.mockResolvedValue(actor('support'));
    const res = await detailGET(new Request(`http://localhost/api/admin/users/${ID_1}`), detailCtx(ID_1));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect((JSON.parse(text) as DetailBody).data.email).toBeNull();
    expect(text).not.toContain(EMAIL_1);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('メールを持たないユーザーは null', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    const res = await detailGET(new Request(`http://localhost/api/admin/users/${ID_1}`), detailCtx(ID_1));
    const body = (await res.json()) as DetailBody;
    expect(body.data.email).toBeNull();
  });

  it('対象が存在しなければ 404 で、メールも引かない', async () => {
    mocks.results['user_profiles'] = { data: null, error: { message: 'not found' } };
    const res = await detailGET(new Request(`http://localhost/api/admin/users/${ID_1}`), detailCtx(ID_1));
    expect(res.status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('メール取得に失敗しても 200 (email は null)。失敗はログに残る (メールアドレスは出さない)', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42883', message: 'does not exist' } });
    const res = await detailGET(new Request(`http://localhost/api/admin/users/${ID_1}`), detailCtx(ID_1));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DetailBody;
    expect(body.data.email).toBeNull();
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain('example.com');
  });

  it('認可は従来どおり (admin / super_admin / support)。応答はキャッシュさせない', async () => {
    const res = await detailGET(new Request(`http://localhost/api/admin/users/${ID_1}`), detailCtx(ID_1));
    expect(mocks.requireRole).toHaveBeenCalledWith(['admin', 'super_admin', 'support']);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('未認証は 401、権限なしは 403。どちらも DB もメールも引かない', async () => {
    mocks.requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    const unauthenticated = await detailGET(new Request(`http://localhost/api/admin/users/${ID_1}`), detailCtx(ID_1));
    expect(unauthenticated.status).toBe(401);

    mocks.requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED'));
    const forbidden = await detailGET(new Request(`http://localhost/api/admin/users/${ID_1}`), detailCtx(ID_1));
    expect(forbidden.status).toBe(403);

    expect(mocks.fromCalls).toEqual([]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
