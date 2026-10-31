// @vitest-environment node
/**
 * #2120 W3 のテスト (API と表):
 *
 * W3-1: 運営の利用者の一覧・詳細のロールの表示名の表 (OPERATOR_ROLE_LABELS)。キーは公式の 12 種のロール
 *       (付与できるロール ALLOWED_ROLES と、付与できないが roles に残りうる org_admin)、どの表示名も日本語を含み、
 *       表に無い値はそのまま返す (labelOrRaw)。画面に出る文字は tests/admin-users-role-labels-2120.test.tsx で見る。
 * W3-2: GET /api/admin/users は sort=meal_count を受けない (400 VALIDATION_ERROR。DB にも監査にも触れない)。
 *       以前は受け取って登録日の順で返し、監査の filters.sort には meal_count と残していた (記録と実際の並びが食い違う)。
 *       受ける sort (registered_at / last_login) は、それぞれ created_at / last_login_at で並べ、監査にも同じ鍵を残す。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { method: string; args: unknown[] };
type BuilderResult = { data: unknown[] | null; error: unknown; count: number | null; status?: number };

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;

const CHAIN_METHODS = ['select', 'or', 'not', 'is', 'eq', 'contains', 'gte', 'lt', 'lte', 'order', 'range'] as const;

/** from('user_profiles') ごとに作る builder の呼び出しの記録 */
let builders: Call[][] = [];

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
      const { builder, calls } = createTrackingBuilder({ data: [profileRow('u-1')], error: null, count: 1 });
      builders.push(calls);
      return builder;
    },
  }),
}));

const { GET } = await import('@/app/api/admin/users/route');
const { ALLOWED_ROLES, USER_LIST_SORT_KEYS, UsersSearchSchema } = await import('@/lib/admin/users-schemas');
const { OPERATOR_ROLE_LABELS, operatorRoleLabel } = await import('@/lib/admin/operator-role-labels');

/** ひらがな・カタカナ・CJK 統合漢字 (拡張 A を含む)・全角の英数記号 */
const JAPANESE = /[぀-ヿ㐀-鿿＀-￯]/;
/** 表に無い値 (将来の値・壊れた応答) */
const UNKNOWN_VALUE = 'brand_new_role';
/** 付与できない (ALLOWED_ROLES に無い) が、公式のロールとして roles に残りうる値 (#1235) */
const NON_GRANTABLE_ROLE = 'org_admin';

/** 一覧の 1 行 (user_profiles の select の形) */
function profileRow(id: string) {
  return {
    id,
    nickname: `user-${id}`,
    roles: ['user'],
    organization_id: null,
    plan_key_cached: null,
    last_login_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    frozen_at: null,
    frozen_reason: null,
    frozen_by: null,
    unban_at: null,
  };
}

/** 一覧の select の order の呼び出し */
function orderCalls(calls: Call[]): Call[] {
  return calls.filter((c) => c.method === 'order');
}

describe('#2120 W3-1 運営のロールの表示名の表 (OPERATOR_ROLE_LABELS)', () => {
  it('キーは公式の 12 種のロール (付与できるロールと org_admin) で、どの表示名も日本語を含む', () => {
    expect(Object.keys(OPERATOR_ROLE_LABELS).sort()).toEqual([...ALLOWED_ROLES, NON_GRANTABLE_ROLE].sort());
    for (const [role, label] of Object.entries(OPERATOR_ROLE_LABELS)) {
      expect(label).toMatch(JAPANESE);
      expect(operatorRoleLabel(role)).toBe(label);
    }
  });

  it('要件の公式ロール一覧の語で出す (運営管理者・運営最上位・サポート・一般ユーザー)', () => {
    expect(operatorRoleLabel('admin')).toBe('運営管理者');
    expect(operatorRoleLabel('super_admin')).toBe('運営最上位');
    expect(operatorRoleLabel('support')).toBe('サポート');
    expect(operatorRoleLabel('user')).toBe('一般ユーザー');
    expect(operatorRoleLabel('org_industrial_doctor')).toBe('産業医');
  });

  it('表示名は互いに重ならない (札の語で別のロールと取り違えない)', () => {
    const labels = Object.values(OPERATOR_ROLE_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('表に無い値はそのまま返す (Object.prototype のプロパティ名もそのまま)', () => {
    expect(operatorRoleLabel(UNKNOWN_VALUE)).toBe(UNKNOWN_VALUE);
    expect(operatorRoleLabel('toString')).toBe('toString');
    expect(operatorRoleLabel('__proto__')).toBe('__proto__');
  });
});

describe('#2120 W3-2 GET /api/admin/users の sort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    builders = [];
  });

  it('受ける sort は registered_at と last_login の 2 つだけ (meal_count は検査で落ちる)', () => {
    expect([...USER_LIST_SORT_KEYS]).toEqual(['registered_at', 'last_login']);
    expect(UsersSearchSchema.safeParse({ sort: 'meal_count' }).success).toBe(false);
  });

  it('sort=meal_count は 400 VALIDATION_ERROR。一覧を読まず、監査にも残さない', async () => {
    const res = await GET(new Request('http://localhost/api/admin/users?sort=meal_count'));
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    const body = (await res.json()) as { error: { code: string; details: { fieldErrors: Record<string, unknown> } } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(body.error.details.fieldErrors)).toEqual(['sort']);
    expect(builders).toHaveLength(0);
    expect(mockRecordAdminAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['registered_at', 'created_at'],
    ['last_login', 'last_login_at'],
    [undefined, 'created_at'],
  ])('sort=%s は %s の列で並べ、監査の filters.sort は受けた鍵のまま (無ければ残さない)', async (auditedSort, column) => {
    const query = new URLSearchParams({ order: 'asc' });
    if (auditedSort !== undefined) query.set('sort', auditedSort);
    const res = await GET(new Request(`http://localhost/api/admin/users?${query.toString()}`));
    expect(res.status).toBe(HTTP_OK);
    // 昇順 (NULL は最後。いままでの昇順の既定と同じ)。同じ値の行は id の順で、ページの境目でも順が変わらない (#2139 T1)
    expect(orderCalls(builders[0])).toEqual([
      { method: 'order', args: [column, { ascending: true, nullsFirst: false }] },
      { method: 'order', args: ['id', { ascending: true, nullsFirst: false }] },
    ]);
    expect(mockRecordAdminAudit).toHaveBeenCalledTimes(1);
    const details = mockRecordAdminAudit.mock.calls[0][0].details as { filters: Record<string, unknown> };
    if (auditedSort === undefined) {
      expect(details.filters).not.toHaveProperty('sort');
    } else {
      expect(details.filters.sort).toBe(auditedSort);
    }
  });

  it.each([
    ['registered_at', 'created_at'],
    ['last_login', 'last_login_at'],
    [undefined, 'created_at'],
  ])('#2139 T1 sort=%s の降順 (order=desc・order が無いときの既定) は %s の新しい順・NULL は最初で、同じ値の行は id の順', async (sort, column) => {
    for (const order of ['desc', undefined]) {
      builders.length = 0;
      const query = new URLSearchParams();
      if (order !== undefined) query.set('order', order);
      if (sort !== undefined) query.set('sort', sort);
      const res = await GET(new Request(`http://localhost/api/admin/users?${query.toString()}`));
      expect(res.status).toBe(HTTP_OK);
      // NULL の位置はいままでの降順の既定 (最初) と同じ。まだログインしていない人 (last_login_at が空) は最初に出る
      expect(orderCalls(builders[0])).toEqual([
        { method: 'order', args: [column, { ascending: false, nullsFirst: true }] },
        { method: 'order', args: ['id', { ascending: true, nullsFirst: false }] },
      ]);
    }
  });
});
