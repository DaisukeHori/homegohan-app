// @vitest-environment node
/**
 * #1148 /api/super-admin/flags の単体テスト
 *
 * - GET の active_user_count: 以前は常に 0 だった。実際の判定 (evaluateFlag) を全ユーザーに実行した人数を返す。
 *     enabled = false は 0 / 全員が対象で条件なしは総数 / percentage・role・plan・org・条件ありは 1 人ずつ判定
 * - 認可が先: super_admin 以外 (admin を含む) と未ログインは、ユーザーを読むサービスロールの client を作らない
 * - 数えられなかったとき (読み出しの失敗) は、一覧そのものは返し、active_user_count は null、原因は構造化ログに残す
 * - 読むのは判定に要る列 (id / roles / organization_id / plan_key_cached / created_at) だけ
 * - 作成・更新・削除のあと、このインスタンスのフラグのキャッシュを新しくする (invalidateFeatureFlag)
 *
 * requireRole は本物 (src/lib/auth/helpers.ts) を使い、ログイン中のユーザーと user_profiles の取得だけを差し替える。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  roles: ['super_admin'] as string[],
  flagRows: [] as Row[],
  users: [] as Row[],
  countError: null as { message: string; code?: string } | null,
  adminClientError: null as Error | null,
  /** 管理者のクライアントで user_profiles に出した select の列 */
  adminSelects: [] as string[],
  /** 本人の権限の client が feature_flags に対して行った書き込み */
  writes: [] as Array<{ table: string; op: string; payload: unknown }>,
}));
const getSupabaseAdmin = vi.hoisted(() => vi.fn());
const logUserError = vi.hoisted(() => vi.fn());
const invalidateFeatureFlag = vi.hoisted(() => vi.fn());

function sessionFrom(table: string) {
  if (table === 'user_profiles') {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      single: async () => ({
        data: { roles: state.roles, organization_id: null, frozen_at: null, unban_at: null },
        error: null,
      }),
    };
    return builder;
  }
  if (table === 'feature_flags') {
    // GET: select().order() を await。PATCH: update().eq().select().single()。POST: insert().select().single()
    const builder: any = new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => resolve({ data: state.flagRows, error: null });
        }
        if (prop === 'single') {
          return async () => ({ data: { key: 'updated_flag', enabled: true }, error: null });
        }
        if (prop === 'insert' || prop === 'update' || prop === 'delete') {
          return (payload?: unknown) => {
            state.writes.push({ table, op: String(prop), payload });
            return builder;
          };
        }
        return () => builder;
      },
      apply: () => builder,
    });
    return builder;
  }
  if (table === 'feature_packages') {
    const builder: any = new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
        if (prop === 'single') return async () => ({ data: null, error: { message: 'no basic package' } });
        return () => builder;
      },
      apply: () => builder,
    });
    return builder;
  }
  if (table === 'admin_audit_logs') {
    return { insert: async () => ({ error: null }) };
  }
  throw new Error(`本人の権限の client が想定外の表 ${table} に触れた`);
}

/** サービスロールの client: user_profiles の件数と、ページ送りの取得だけを再現する */
function adminClient() {
  return {
    from: (table: string) => {
      if (table !== 'user_profiles') throw new Error(`管理者の client が想定外の表 ${table} に触れた`);
      return {
        select: (columns: string, options?: { count?: string; head?: boolean }) => {
          state.adminSelects.push(columns);
          if (options?.head) {
            return Promise.resolve(
              state.countError
                ? { count: null, error: state.countError }
                : { count: state.users.length, error: null },
            );
          }
          const builder: any = {
            order: () => builder,
            range: async (from: number, to: number) => ({ data: state.users.slice(from, to + 1), error: null }),
          };
          return builder;
        },
      };
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: {
      getUser: async () =>
        state.user
          ? { data: { user: state.user }, error: null }
          : { data: { user: null }, error: { message: 'Auth session missing!' } },
    },
    from: (table: string) => sessionFrom(table),
  }),
  getSupabaseAdmin: () => getSupabaseAdmin(),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logUserError })),
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

vi.mock('@/lib/feature-flags', () => ({
  invalidateFeatureFlag: (key: string) => invalidateFeatureFlag(key),
}));

import { GET, POST } from '../src/app/api/super-admin/flags/route';
import { DELETE, PATCH } from '../src/app/api/super-admin/flags/[key]/route';

function flag(key: string, overrides: Row = {}): Row {
  return {
    key,
    description: `${key} の説明`,
    enabled: true,
    rollout_strategy: null,
    constraints: null,
    updated_at: '2026-10-08T00:00:00.000Z',
    ...overrides,
  };
}

function user(id: string, overrides: Row = {}): Row {
  return {
    id,
    roles: ['user'],
    organization_id: null,
    plan_key_cached: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

type FlagItem = { key: string; active_user_count: number | null; description: string };

async function getFlags(): Promise<{ status: number; flags: FlagItem[] }> {
  const res = await GET();
  const body = await res.json();
  return { status: res.status, flags: (body.data ?? []) as FlagItem[] };
}

function countOf(flags: FlagItem[], key: string): number | null {
  const found = flags.find((f) => f.key === key);
  expect(found, `${key} が一覧に無い`).toBeDefined();
  return found!.active_user_count;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.user = { id: 'super-1', email: 'super@example.com' };
  state.roles = ['super_admin'];
  state.flagRows = [];
  state.users = [];
  state.countError = null;
  state.adminClientError = null;
  state.adminSelects = [];
  state.writes = [];
  getSupabaseAdmin.mockImplementation(() => {
    if (state.adminClientError) throw state.adminClientError;
    return adminClient();
  });
});

describe('GET /api/super-admin/flags — active_user_count (#1148)', () => {
  it('OFF のフラグは 0、全員が対象で条件の無いフラグはユーザー総数', async () => {
    state.users = [user('u1'), user('u2'), user('u3')];
    state.flagRows = [
      flag('off_flag', { enabled: false }),
      flag('everyone', { rollout_strategy: null }),
      flag('everyone_all', { rollout_strategy: { type: 'all' }, constraints: {} }),
    ];

    const { status, flags } = await getFlags();

    expect(status).toBe(200);
    expect(countOf(flags, 'off_flag')).toBe(0);
    expect(countOf(flags, 'everyone')).toBe(3);
    expect(countOf(flags, 'everyone_all')).toBe(3);
  });

  it('role の段階公開は、そのロールを持つユーザーの数', async () => {
    state.users = [user('u1'), user('u2', { roles: ['user', 'admin'] }), user('u3', { roles: ['super_admin'] })];
    state.flagRows = [flag('staff', { rollout_strategy: { type: 'role', roles: ['admin', 'super_admin'] } })];

    const { flags } = await getFlags();
    expect(countOf(flags, 'staff')).toBe(2);
  });

  it('plan の段階公開と条件: plan_key_cached が空のユーザーは free として数える', async () => {
    state.users = [
      user('u1', { plan_key_cached: 'pro' }),
      user('u2', { plan_key_cached: null }),
      user('u3', { plan_key_cached: 'free' }),
      user('u4', { plan_key_cached: 'family_pro' }),
    ];
    state.flagRows = [
      flag('paid_only', { rollout_strategy: { type: 'plan', plans: ['pro', 'family_pro'] } }),
      flag('not_free', { constraints: { exclude_plans: ['free'] } }),
    ];

    const { flags } = await getFlags();
    expect(countOf(flags, 'paid_only')).toBe(2);
    expect(countOf(flags, 'not_free')).toBe(2);
  });

  it('org の段階公開は、その組織に所属するユーザーの数', async () => {
    const ORG = '11111111-1111-4111-8111-111111111111';
    state.users = [user('u1', { organization_id: ORG }), user('u2', { organization_id: null }), user('u3', { organization_id: ORG })];
    state.flagRows = [flag('org_pilot', { rollout_strategy: { type: 'org', org_ids: [ORG] } })];

    const { flags } = await getFlags();
    expect(countOf(flags, 'org_pilot')).toBe(2);
  });

  it('percentage は、アプリの判定 (evaluateFlag) と同じ結果を数える。100% は総数、0% は 0', async () => {
    const { evaluateFlag } = await import('../src/lib/super-admin/evaluate-flag');
    state.users = Array.from({ length: 200 }, (_, i) => user(`user-${i}`));
    const half = flag('half', { rollout_strategy: { type: 'percentage', value: 50 } });
    state.flagRows = [
      half,
      flag('full', { rollout_strategy: { type: 'percentage', value: 100 } }),
      flag('zero', { rollout_strategy: { type: 'percentage', value: 0 } }),
    ];

    const expected = state.users.filter((u) =>
      evaluateFlag(
        { key: 'half', enabled: true, rollout_strategy: { type: 'percentage', value: 50 }, constraints: null },
        { userId: u.id as string },
      ),
    ).length;

    const { flags } = await getFlags();
    expect(countOf(flags, 'half')).toBe(expected);
    expect(expected).toBeGreaterThan(60);
    expect(expected).toBeLessThan(140);
    expect(countOf(flags, 'full')).toBe(200);
    expect(countOf(flags, 'zero')).toBe(0);
  });

  it('min_user_age_days の条件は、アカウントの作成日で数える', async () => {
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    state.users = [user('u1', { created_at: old }), user('u2', { created_at: recent }), user('u3', { created_at: old })];
    state.flagRows = [flag('veterans', { constraints: { min_user_age_days: 30 } })];

    const { flags } = await getFlags();
    expect(countOf(flags, 'veterans')).toBe(2);
  });

  it('1000 人を超えても、ページを送って全員を数える', async () => {
    state.users = Array.from({ length: 2500 }, (_, i) =>
      user(`user-${String(i).padStart(5, '0')}`, { roles: i % 5 === 0 ? ['admin'] : ['user'] }),
    );
    state.flagRows = [flag('staff', { rollout_strategy: { type: 'role', roles: ['admin'] } })];

    const { flags } = await getFlags();
    expect(countOf(flags, 'staff')).toBe(500);
  });

  it('ユーザーが多すぎて 1 人ずつ判定しないときは、そのフラグだけ null (全員対象のフラグは総数のまま)', async () => {
    state.users = Array.from({ length: 20_001 }, (_, i) => user(`user-${i}`));
    state.flagRows = [
      flag('everyone'),
      flag('staff', { rollout_strategy: { type: 'role', roles: ['admin'] } }),
      flag('off_flag', { enabled: false }),
    ];

    const { status, flags } = await getFlags();

    expect(status).toBe(200);
    expect(countOf(flags, 'everyone')).toBe(20_001);
    expect(countOf(flags, 'staff')).toBeNull();
    expect(countOf(flags, 'off_flag')).toBe(0);
    // 20,001 人の user_profiles を読みに行かない (件数だけ)
    expect(state.adminSelects.filter((c) => c !== 'id')).toEqual([]);
  });

  it('読むのは判定に要る列だけ (メール・名前などは読まない)。件数だけで済むフラグしか無ければ、ユーザーの列は読まない', async () => {
    state.users = [user('u1'), user('u2')];
    state.flagRows = [flag('everyone'), flag('staff', { rollout_strategy: { type: 'role', roles: ['admin'] } })];
    await getFlags();
    expect(state.adminSelects).toContain('id, roles, organization_id, plan_key_cached, created_at');
    for (const columns of state.adminSelects) {
      expect(columns).not.toMatch(/email|nickname|name|avatar|phone/i);
    }

    state.adminSelects = [];
    state.flagRows = [flag('everyone'), flag('off_flag', { enabled: false })];
    await getFlags();
    expect(state.adminSelects).toEqual(['id']);
  });

  it('OFF のフラグだけなら、ユーザーを読みに行かない', async () => {
    state.users = [user('u1')];
    state.flagRows = [flag('off_flag', { enabled: false })];

    const { flags } = await getFlags();

    expect(countOf(flags, 'off_flag')).toBe(0);
    expect(state.adminSelects).toEqual([]);
  });

  it('フラグが 1 つも無ければ空の一覧 (ユーザーを読みに行かない)', async () => {
    state.users = [user('u1')];
    const { status, flags } = await getFlags();
    expect(status).toBe(200);
    expect(flags).toEqual([]);
    expect(state.adminSelects).toEqual([]);
  });

  it('件数の取得に失敗しても、一覧は 200 で返す。active_user_count は null で、原因を構造化ログに残す', async () => {
    state.flagRows = [flag('everyone'), flag('off_flag', { enabled: false })];
    state.countError = { message: 'permission denied for table user_profiles', code: '42501' };

    const { status, flags } = await getFlags();

    expect(status).toBe(200);
    expect(flags.map((f) => f.key)).toEqual(['everyone', 'off_flag']);
    // 集計そのものに失敗したので、全フラグが「算出できない」(null)。0 と取り違えて表示させない
    expect(countOf(flags, 'everyone')).toBeNull();
    expect(countOf(flags, 'off_flag')).toBeNull();
    expect(logUserError).toHaveBeenCalledTimes(1);
    expect(logUserError.mock.calls[0][0]).toContain('集計に失敗');
    expect((logUserError.mock.calls[0][1] as Error).message).toContain('permission denied');
  });

  it('サービスロールの client を作れなくても (環境変数なし)、一覧は 200 で返す', async () => {
    state.flagRows = [flag('everyone')];
    state.adminClientError = new Error('Supabase admin env is missing');

    const { status, flags } = await getFlags();

    expect(status).toBe(200);
    expect(countOf(flags, 'everyone')).toBeNull();
    expect(logUserError).toHaveBeenCalledTimes(1);
  });

  it('従来の項目 (key / description / enabled / rollout_strategy / constraints / updated_at) は変わらない', async () => {
    state.flagRows = [flag('everyone', { description: null, rollout_strategy: { type: 'all' } })];
    state.users = [user('u1')];

    const res = await GET();
    const body = await res.json();

    expect(body.meta).toEqual({ total: 1, page: 1, per_page: 1 });
    expect(body.data[0]).toEqual({
      key: 'everyone',
      description: '',
      enabled: true,
      rollout_strategy: { type: 'all' },
      constraints: null,
      active_user_count: 1,
      updated_at: '2026-10-08T00:00:00.000Z',
    });
  });
});

describe('GET /api/super-admin/flags — 認可が先 (#1148)', () => {
  it.each([
    ['admin', ['admin']],
    ['一般ユーザー', ['user']],
    ['org_admin', ['org_admin']],
  ])('%s は 403。ユーザーを読むサービスロールの client は作らない', async (_label, roles) => {
    state.roles = roles;
    state.flagRows = [flag('everyone')];

    const res = await GET();

    expect(res.status).toBe(403);
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('未ログインは 401。サービスロールの client は作らない', async () => {
    state.user = null;

    const res = await GET();

    expect(res.status).toBe(401);
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });
});

describe('作成・更新・削除のあと、このインスタンスのフラグのキャッシュを新しくする (#1148)', () => {
  function jsonRequest(method: string, body: unknown) {
    return new Request('http://localhost/api/super-admin/flags', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
  }

  it('PATCH /api/super-admin/flags/[key]', async () => {
    const res = await PATCH(jsonRequest('PATCH', { enabled: true }), { params: { key: 'maintenance_mode' } });
    expect(res.status).toBe(200);
    expect(invalidateFeatureFlag).toHaveBeenCalledWith('maintenance_mode');
  });

  it('PATCH が検証エラー (400) のときは忘れない', async () => {
    const res = await PATCH(jsonRequest('PATCH', { enabled: 'yes' }), { params: { key: 'maintenance_mode' } });
    expect(res.status).toBe(400);
    expect(invalidateFeatureFlag).not.toHaveBeenCalled();
  });

  it('DELETE /api/super-admin/flags/[key]', async () => {
    const res = await DELETE(jsonRequest('DELETE', {}), { params: { key: 'some_flag' } });
    expect(res.status).toBe(200);
    expect(invalidateFeatureFlag).toHaveBeenCalledWith('some_flag');
  });

  it('POST /api/super-admin/flags', async () => {
    const res = await POST(jsonRequest('POST', { key: 'new_flag', enabled: false }));
    expect(res.status).toBe(201);
    expect(invalidateFeatureFlag).toHaveBeenCalledWith('new_flag');
  });

  it('super_admin 以外は 403 で、キャッシュには触れない', async () => {
    state.roles = ['admin'];
    const res = await PATCH(jsonRequest('PATCH', { enabled: true }), { params: { key: 'maintenance_mode' } });
    expect(res.status).toBe(403);
    expect(invalidateFeatureFlag).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });
});
