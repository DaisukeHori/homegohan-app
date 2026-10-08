/**
 * #1127 契約者がいるプランを廃止できなくする安全装置の contract テスト
 * PATCH /api/super-admin/plans/[id] (status: 'deprecated')
 *
 * 契約者への移行案内・自動更新の停止・廃止前の通知はまだ無い (課金開始までは作らない) ので、
 * 契約者がいるまま廃止すると、廃止したプランで課金だけが続くおそれがある。
 * そのため廃止の前に、契約が終わっていない契約者を service_role で数え、1 件でもいれば 409 で止める。
 *
 *   - 契約者なし            → これまでどおり 200 で廃止できる
 *   - 契約者あり            → 409 OP_PLAN_HAS_SUBSCRIBERS (内訳 counts と文面を返し、プランも監査ログも更新しない)
 *   - 契約者数を数えられない → 500 OP_PLAN_SUBSCRIBER_CHECK_FAILED (0 件とは見なさず、廃止も止める)
 *
 * 状態遷移の規則そのものは tests/plan-status-transition.test.ts が確かめる。
 * 数え方 (どの status・テーブルを数えるか) は tests/plan-subscribers.test.ts が確かめる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createFakeSupabase } from './helpers/fake-supabase';
import {
  createFakePlanSubscribersDb,
  type FakePlanSubscribersDbOptions,
  type FakeRow,
} from './helpers/fake-plan-subscribers-db';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

// 失敗の記録 (app_logs) は実際には書かず、呼ばれ方だけを見る
const mockLoggerError = vi.fn();

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    error: (...args: unknown[]) => mockLoggerError(...args),
    withUser: () => ({ error: (...args: unknown[]) => mockLoggerError(...args) }),
  }),
  generateRequestId: () => 'req_test',
}));

let fakeSupabase: ReturnType<typeof createFakeSupabase>;
let subscribersDb: ReturnType<typeof createFakePlanSubscribersDb>;
const mockGetSupabaseAdmin = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeSupabase),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}));

const { PATCH } = await import('@/app/api/super-admin/plans/[id]/route');

const actor = { id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };
const ENDS_AT = '2027-01-01T00:00:00.000Z';
const DEPRECATE = { status: 'deprecated', ends_at: ENDS_AT };

interface ErrorBody {
  error: {
    code: string;
    message: string;
    counts?: { personal_subscriptions: number; family_groups: number; organizations: number };
  };
}

function existingPlan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    plan_key: 'pro',
    display_name: 'Pro',
    plan_type: 'personal',
    status: 'public',
    ends_at: null,
    ...overrides,
  };
}

function patchRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/super-admin/plans/plan-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}

/**
 * プランの DB (ログインした本人の client) と契約者の DB (service_role の client) をそろえて PATCH を呼ぶ。
 * 1 回目の subscription_plans が既存プランの取得、2 回目が更新後の行。
 */
async function patch(
  body: Record<string, unknown>,
  { plan = existingPlan(), subscribers = {} }: { plan?: Record<string, unknown>; subscribers?: FakePlanSubscribersDbOptions } = {},
) {
  fakeSupabase = createFakeSupabase({
    subscription_plans: [
      { data: plan, error: null },
      { data: { ...plan, status: body.status ?? plan.status }, error: null },
    ],
    admin_audit_logs: [{ data: null, error: null }],
  });
  subscribersDb = createFakePlanSubscribersDb(subscribers);
  const res = await PATCH(patchRequest(body), { params: { id: 'plan-1' } });
  return { res, json: (await res.json()) as ErrorBody & { data?: Record<string, unknown> } };
}

/** fakeSupabase.from が呼ばれたテーブルの並び */
function tablesTouched() {
  return fakeSupabase.from.mock.calls.map((call) => call[0] as string);
}

/** plan 'pro' の個人契約 1 件だけがある状態 */
function onePersonalSubscriber(status = 'active'): FakePlanSubscribersDbOptions {
  return { tables: { personal_subscriptions: [{ plan_key: 'pro', status }] } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(actor);
  mockGetSupabaseAdmin.mockImplementation(() => subscribersDb.client);
});

describe('契約者がいないプランは、これまでどおり廃止できる (#1127)', () => {
  it('契約者が 0 件なら 200。status = deprecated と ends_at でプランを更新し、監査ログも書く', async () => {
    const { res, json } = await patch(DEPRECATE);

    expect(res.status).toBe(200);
    expect(json.data?.status).toBe('deprecated');
    expect(tablesTouched()).toEqual(['subscription_plans', 'subscription_plans', 'admin_audit_logs']);
    const updateBuilder = fakeSupabase.from.mock.results[1]!.value as { update: ReturnType<typeof vi.fn> };
    expect(updateBuilder.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'deprecated', ends_at: ENDS_AT }));
  });

  it('終了済みの契約・解散済みの家族と組織・別プランの契約者しかいなければ、廃止できる', async () => {
    const stale: FakePlanSubscribersDbOptions = {
      tables: {
        personal_subscriptions: [
          { plan_key: 'pro', status: 'cancelled' },
          { plan_key: 'pro', status: 'expired' },
          { plan_key: 'family_basic', status: 'active' },
        ],
        family_groups: [
          { plan_key: 'pro', status: 'dissolved' },
          { plan_key: 'family_basic', status: 'active' },
        ],
        organizations: [
          { plan: 'pro', status: 'dissolved' },
          { plan: 'org_starter', status: 'active' },
        ],
      },
    };

    const { res } = await patch(DEPRECATE, { subscribers: stale });

    expect(res.status).toBe(200);
  });

  it('private のプランも、契約者がいなければ廃止できる', async () => {
    const { res } = await patch(DEPRECATE, { plan: existingPlan({ status: 'private' }) });

    expect(res.status).toBe(200);
  });
});

describe('契約者がいるプランは、廃止を 409 で止める (#1127)', () => {
  it.each(['trialing', 'active', 'paused', 'past_due', 'grace'])(
    '個人契約 (status = %s) が 1 件でもあれば 409 OP_PLAN_HAS_SUBSCRIBERS',
    async (status) => {
      const { res, json } = await patch(DEPRECATE, { subscribers: onePersonalSubscriber(status) });

      expect(res.status).toBe(409);
      expect(json.error.code).toBe('OP_PLAN_HAS_SUBSCRIBERS');
      expect(json.error.counts).toEqual({ personal_subscriptions: 1, family_groups: 0, organizations: 0 });
    },
  );

  it('家族グループ (active) がいれば 409', async () => {
    const { res, json } = await patch(DEPRECATE, {
      subscribers: { tables: { family_groups: [{ plan_key: 'pro', status: 'active' }] } },
    });

    expect(res.status).toBe(409);
    expect(json.error.counts).toEqual({ personal_subscriptions: 0, family_groups: 1, organizations: 0 });
  });

  it('組織 (plan = plan_key の active) がいれば 409', async () => {
    const { res, json } = await patch(DEPRECATE, {
      subscribers: { tables: { organizations: [{ plan: 'pro', status: 'active' }] } },
    });

    expect(res.status).toBe(409);
    expect(json.error.counts).toEqual({ personal_subscriptions: 0, family_groups: 0, organizations: 1 });
  });

  it('3 種類にいるときは、counts にテーブルごとの内訳を返し、文面にも件数を出す', async () => {
    const rows = (n: number, row: FakeRow): FakeRow[] => Array.from({ length: n }, () => ({ ...row }));
    const { res, json } = await patch(DEPRECATE, {
      subscribers: {
        tables: {
          personal_subscriptions: rows(3, { plan_key: 'pro', status: 'active' }),
          family_groups: rows(2, { plan_key: 'pro', status: 'active' }),
          organizations: rows(1, { plan: 'pro', status: 'active' }),
        },
      },
    });

    expect(res.status).toBe(409);
    expect(json.error.counts).toEqual({ personal_subscriptions: 3, family_groups: 2, organizations: 1 });
    expect(json.error.message).toContain('個人契約 3 件・家族グループ 2 件・組織 1 件');
  });

  it('止めたときは、プランを更新せず、監査ログも書かない (プランの取得 1 回だけ)', async () => {
    const { res } = await patch(DEPRECATE, { subscribers: onePersonalSubscriber() });

    expect(res.status).toBe(409);
    expect(tablesTouched()).toEqual(['subscription_plans']);
  });

  it('文面: 公開中のプランには「非公開にする」を案内し、非公開のプランには案内しない', async () => {
    const publicPlan = await patch(DEPRECATE, { plan: existingPlan({ status: 'public' }), subscribers: onePersonalSubscriber() });
    const privatePlan = await patch(DEPRECATE, { plan: existingPlan({ status: 'private' }), subscribers: onePersonalSubscriber() });

    expect(publicPlan.json.error.message).toContain('契約者がいるため、このプランは廃止できません');
    expect(publicPlan.json.error.message).toContain('「非公開にする」');
    expect(privatePlan.res.status).toBe(409);
    expect(privatePlan.json.error.message).toContain('契約者がいるため、このプランは廃止できません');
    expect(privatePlan.json.error.message).not.toContain('非公開');
  });

  it('ends_at をプランが既に持っていて、今回のリクエストに無くても、契約者がいれば 409', async () => {
    const { res, json } = await patch(
      { status: 'deprecated' },
      { plan: existingPlan({ ends_at: ENDS_AT }), subscribers: onePersonalSubscriber() },
    );

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('OP_PLAN_HAS_SUBSCRIBERS');
  });

  it('plan_key が違う別プランの契約者がいても、このプランは止めない', async () => {
    const { res } = await patch(DEPRECATE, {
      plan: existingPlan({ plan_key: 'pro_plus' }),
      subscribers: { tables: { personal_subscriptions: [{ plan_key: 'pro', status: 'active' }] } },
    });

    expect(res.status).toBe(200);
  });
});

describe('安全装置が働く範囲は、廃止への遷移だけ (#1127)', () => {
  it('公開 --> 非公開 は、契約者がいても止めず、契約者数も数えない (新規申込だけを止める操作)', async () => {
    const { res } = await patch({ status: 'private' }, { subscribers: onePersonalSubscriber() });

    expect(res.status).toBe(200);
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('廃止の取り消し (deprecated --> private) は、契約者がいても止めず、契約者数も数えない', async () => {
    const { res } = await patch(
      { status: 'private' },
      { plan: existingPlan({ status: 'deprecated' }), subscribers: onePersonalSubscriber() },
    );

    expect(res.status).toBe(200);
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('status を変えない編集 (表示名の変更) は、契約者がいても止めず、契約者数も数えない', async () => {
    const { res } = await patch({ display_name: 'Pro (新)' }, { subscribers: onePersonalSubscriber() });

    expect(res.status).toBe(200);
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('廃止予定日 (ends_at) が無い廃止は、先に 400 で止まり、契約者数は数えない', async () => {
    const { res, json } = await patch({ status: 'deprecated' }, { subscribers: onePersonalSubscriber() });

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('OP_PLAN_DEPRECATE_ENDS_AT_REQUIRED');
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('許可されない遷移 (draft --> deprecated) は、先に 422 で止まり、契約者数は数えない', async () => {
    const { res, json } = await patch(DEPRECATE, { plan: existingPlan({ status: 'draft' }), subscribers: onePersonalSubscriber() });

    expect(res.status).toBe(422);
    expect(json.error.code).toBe('OP_PLAN_INVALID_TRANSITION');
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });
});

describe('契約者数を数えられなかったときは、廃止を止める (fail-closed) (#1127)', () => {
  it.each([
    ['personal_subscriptions', '42P01'],
    ['family_groups', '42703'],
    ['organizations', 'PGRST301'],
  ] as const)('%s の取得が DB エラーなら 500。0 件とは見なさず、プランを更新しない', async (table, code) => {
    const { res, json } = await patch(DEPRECATE, {
      subscribers: { errors: { [table]: { message: `relation secret_internal_name does not exist`, code } } },
    });

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('OP_PLAN_SUBSCRIBER_CHECK_FAILED');
    expect(tablesTouched()).toEqual(['subscription_plans']);
    // 詳細は app_logs に残し、DB の生のエラー文は本文に出さない (#1172)
    expect(JSON.stringify(json)).not.toContain('secret_internal_name');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    const [message, error, metadata] = mockLoggerError.mock.calls[0]!;
    expect(message).toContain('契約者数を確認できなかった');
    expect((error as Error).message).toContain(table);
    expect(metadata).toEqual({ plan_id: 'plan-1', plan_key: 'pro', table, pg_code: code });
  });

  it('件数が返らない (count が null) ときも 500。プランを更新しない', async () => {
    const { res, json } = await patch(DEPRECATE, { subscribers: { nullCount: ['organizations'] } });

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('OP_PLAN_SUBSCRIBER_CHECK_FAILED');
    expect(tablesTouched()).toEqual(['subscription_plans']);
  });

  it('service_role のクライアントを作れない (環境変数がない) ときも 500。プランを更新しない', async () => {
    mockGetSupabaseAdmin.mockImplementation(() => {
      throw new Error('Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    });

    const { res, json } = await patch(DEPRECATE);

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('OP_PLAN_SUBSCRIBER_CHECK_FAILED');
    expect(JSON.stringify(json)).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(tablesTouched()).toEqual(['subscription_plans']);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it('プランの plan_key が空なら、どの契約者にも一致して「0 件」になる前に 500 で止める', async () => {
    const { res, json } = await patch(DEPRECATE, { plan: existingPlan({ plan_key: '' }), subscribers: onePersonalSubscriber() });

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('OP_PLAN_SUBSCRIBER_CHECK_FAILED');
    expect(subscribersDb.from).not.toHaveBeenCalled();
  });
});

describe('認可の前に service_role を使わない (#1127)', () => {
  it('未認証 (401) では、service_role のクライアントを作らない', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));

    const res = await PATCH(patchRequest(DEPRECATE), { params: { id: 'plan-1' } });

    expect(res.status).toBe(401);
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('super_admin 以外 (403) では、service_role のクライアントを作らない', async () => {
    mockRequireRole.mockRejectedValueOnce(new ForbiddenError('FORBIDDEN_ROLE'));

    const res = await PATCH(patchRequest(DEPRECATE), { params: { id: 'plan-1' } });

    expect(res.status).toBe(403);
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('認可は super_admin だけに限る', async () => {
    await patch(DEPRECATE);

    expect(mockRequireRole).toHaveBeenCalledWith(['super_admin']);
  });

  it('契約者を数えるクエリは、件数だけを取り、3 つのテーブルを plan_key で絞る', async () => {
    await patch(DEPRECATE);

    expect(subscribersDb.queries.map((q) => q.table).sort()).toEqual(['family_groups', 'organizations', 'personal_subscriptions']);
    for (const query of subscribersDb.queries) {
      expect(query.options).toEqual({ count: 'exact', head: true });
      expect(query.eq).toEqual(expect.arrayContaining([[query.table === 'organizations' ? 'plan' : 'plan_key', 'pro']]));
    }
  });
});
