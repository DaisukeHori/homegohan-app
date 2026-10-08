/**
 * #1212 回帰防止 contract テスト
 * GET /api/super-admin/plans/[id]/price-impact
 *
 * 従来は applies_to をパースしてレスポンスにエコーバックするだけで集計には使っておらず、
 * 「新規契約のみ (new_only)」を選んでも「全既存契約者 x 価格差」の MRR 影響を返していた
 * (super_admin が収益への影響を見誤る)。
 * 修正後は applies_to ごとに既存契約への影響を切り分ける。
 *   - new_only    : 既存契約は現行価格のまま。personal_subscriptions を集計せず 0 件 / 0 円
 *   - on_renewal  : 既存契約は次回更新時から新価格 (effective_timing = next_renewal)
 *   - immediately : 既存契約へ即時に新価格 (effective_timing = immediate)
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryBuilder, type FakeQueryResult } from './helpers/fake-supabase';

const mockRequireRole = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

let fakeSupabase: ReturnType<typeof createImpactSupabase>;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(fakeSupabase),
}));

const { GET } = await import('@/app/api/super-admin/plans/[id]/price-impact/route');

const actor = { id: 'sa-1', email: 'sa@example.com', roles: ['super_admin'], organization_id: null };

type Builder = Record<string, unknown>;

/** 共有の fake query builder には無い .in() / .not() (price-impact が使う) を足す */
function withInNot(builder: Builder): Builder {
  builder.in = vi.fn(() => builder);
  builder.not = vi.fn(() => builder);
  return builder;
}

/**
 * subscription_plans (プラン取得) と personal_subscriptions (影響契約の集計) だけを返す Supabase フェイク。
 * 他のテーブルへアクセスしたら例外にする。
 */
function createImpactSupabase(opts: { plan: FakeQueryResult; subscriptions?: FakeQueryResult }) {
  const subscriptionBuilders: Builder[] = [];
  const from = vi.fn((table: string) => {
    if (table === 'subscription_plans') return withInNot(createQueryBuilder(opts.plan));
    if (table === 'personal_subscriptions') {
      const builder = withInNot(
        createQueryBuilder(opts.subscriptions ?? { data: [], error: null, count: 0 }),
      );
      subscriptionBuilders.push(builder);
      return builder;
    }
    throw new Error(`unexpected table "${table}"`);
  });
  return { from, subscriptionBuilders };
}

/** 現行月額 1,500 円の個人プラン */
function existingPlan() {
  return { id: 'plan-1', plan_key: 'pro', monthly_price_jpy: 1500, plan_type: 'personal' };
}

/** 影響対象の契約。count は DB 上の全件数 (data は limit 5 のサンプル) */
function subscriptions(userIds: string[], count = userIds.length): FakeQueryResult {
  return {
    data: userIds.map((userId) => ({ id: `ps-${userId}`, user_id: userId })),
    error: null,
    count,
  };
}

function impactRequest(query: string) {
  return new NextRequest(`http://localhost/api/super-admin/plans/plan-1/price-impact?${query}`);
}

type ImpactBody = {
  data: {
    affected_subscription_count: number;
    affected_mrr_change_jpy: number;
    current_monthly_price_jpy: number;
    new_monthly_price_jpy: number;
    applies_to: string;
    effective_timing: string;
    affected_user_sample: Array<{ user_id: string }>;
  };
};

function personalSubscriptionsCalls(fake: ReturnType<typeof createImpactSupabase>) {
  return fake.from.mock.calls.filter((c) => c[0] === 'personal_subscriptions');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(actor);
});

describe('GET /api/super-admin/plans/[id]/price-impact (#1212: new_only は既存契約に影響しない)', () => {
  it('new_only は既存契約者が居ても 0 件 / 0 円 / サンプルなしを返し、personal_subscriptions を集計しない', async () => {
    fakeSupabase = createImpactSupabase({
      plan: { data: existingPlan(), error: null },
      // 既存契約者が 3 人居ても new_only では影響しない (旧実装はここで 3 件 / +1,500 円を返していた)
      subscriptions: subscriptions(['u1', 'u2', 'u3']),
    });

    const res = await GET(impactRequest('new_monthly_price_jpy=2000&applies_to=new_only'), {
      params: { id: 'plan-1' },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as ImpactBody;
    expect(json.data).toEqual({
      affected_subscription_count: 0,
      affected_mrr_change_jpy: 0,
      current_monthly_price_jpy: 1500,
      new_monthly_price_jpy: 2000,
      applies_to: 'new_only',
      effective_timing: 'none',
      affected_user_sample: [],
    });
    expect(personalSubscriptionsCalls(fakeSupabase)).toHaveLength(0);
  });

  it('new_only は値下げでも MRR 変化 0 (既存契約は現行価格のまま)', async () => {
    fakeSupabase = createImpactSupabase({
      plan: { data: existingPlan(), error: null },
      subscriptions: subscriptions(['u1', 'u2']),
    });

    const res = await GET(impactRequest('new_monthly_price_jpy=1000&applies_to=new_only'), {
      params: { id: 'plan-1' },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as ImpactBody;
    expect(json.data.affected_subscription_count).toBe(0);
    expect(json.data.affected_mrr_change_jpy).toBe(0);
    expect(json.data.new_monthly_price_jpy).toBe(1000);
  });

  it('applies_to を省略した場合は new_only として扱う (レスポンスの applies_to と集計の解釈を一致させる)', async () => {
    fakeSupabase = createImpactSupabase({
      plan: { data: existingPlan(), error: null },
      subscriptions: subscriptions(['u1', 'u2', 'u3']),
    });

    const res = await GET(impactRequest('new_monthly_price_jpy=2000'), { params: { id: 'plan-1' } });

    expect(res.status).toBe(200);
    const json = (await res.json()) as ImpactBody;
    expect(json.data.applies_to).toBe('new_only');
    expect(json.data.effective_timing).toBe('none');
    expect(json.data.affected_subscription_count).toBe(0);
    expect(json.data.affected_mrr_change_jpy).toBe(0);
    expect(personalSubscriptionsCalls(fakeSupabase)).toHaveLength(0);
  });
});

describe('GET /api/super-admin/plans/[id]/price-impact (#1212: on_renewal / immediately は既存契約を集計する)', () => {
  it.each([
    ['on_renewal', 'next_renewal'],
    ['immediately', 'immediate'],
  ])('%s は既存契約数 x 価格差を MRR 変化として返し、effective_timing=%s を付ける', async (appliesTo, timing) => {
    fakeSupabase = createImpactSupabase({
      plan: { data: existingPlan(), error: null },
      subscriptions: subscriptions(['u1', 'u2', 'u3']),
    });

    const res = await GET(impactRequest(`new_monthly_price_jpy=2000&applies_to=${appliesTo}`), {
      params: { id: 'plan-1' },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as ImpactBody;
    expect(json.data).toEqual({
      affected_subscription_count: 3,
      // (2,000 - 1,500) x 3 件
      affected_mrr_change_jpy: 1500,
      current_monthly_price_jpy: 1500,
      new_monthly_price_jpy: 2000,
      applies_to: appliesTo,
      effective_timing: timing,
      affected_user_sample: [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u3' }],
    });
  });

  it('集計は同じプランの active / trialing / paused かつ Stripe サブスクリプションを持つ契約に限る (§3.3 SQL 準拠)', async () => {
    fakeSupabase = createImpactSupabase({
      plan: { data: existingPlan(), error: null },
      subscriptions: subscriptions(['u1']),
    });

    const res = await GET(impactRequest('new_monthly_price_jpy=2000&applies_to=on_renewal'), {
      params: { id: 'plan-1' },
    });
    expect(res.status).toBe(200);

    const calls = personalSubscriptionsCalls(fakeSupabase);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const builder of fakeSupabase.subscriptionBuilders) {
      expect(builder.eq).toHaveBeenCalledWith('plan_key', 'pro');
      expect(builder.in).toHaveBeenCalledWith('status', ['active', 'trialing', 'paused']);
      expect(builder.not).toHaveBeenCalledWith('stripe_subscription_id', 'is', null);
    }
  });

  it('値下げ (新価格 < 現価格) の MRR 変化は負になる', async () => {
    fakeSupabase = createImpactSupabase({
      plan: { data: existingPlan(), error: null },
      subscriptions: subscriptions(['u1', 'u2']),
    });

    const res = await GET(impactRequest('new_monthly_price_jpy=1200&applies_to=on_renewal'), {
      params: { id: 'plan-1' },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as ImpactBody;
    // (1,200 - 1,500) x 2 件
    expect(json.data.affected_mrr_change_jpy).toBe(-600);
  });

  it('影響契約数は全件数 (count) を使い、サンプル (limit 5) の件数には依存しない', async () => {
    fakeSupabase = createImpactSupabase({
      plan: { data: existingPlan(), error: null },
      // DB 上は 120 件だが、サンプルは先頭 5 件だけ
      subscriptions: subscriptions(['u1', 'u2', 'u3', 'u4', 'u5'], 120),
    });

    const res = await GET(impactRequest('new_monthly_price_jpy=2000&applies_to=immediately'), {
      params: { id: 'plan-1' },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as ImpactBody;
    expect(json.data.affected_subscription_count).toBe(120);
    expect(json.data.affected_mrr_change_jpy).toBe(500 * 120);
    expect(json.data.affected_user_sample).toHaveLength(5);
    // サンプルは先頭 5 件に絞る (全件を返さない)
    const limitCalled = fakeSupabase.subscriptionBuilders.some((b) =>
      (b.limit as ReturnType<typeof vi.fn>).mock.calls.some((args) => args[0] === 5),
    );
    expect(limitCalled).toBe(true);
  });

  it('新価格を省略した場合は現行価格との差が 0 なので MRR 変化 0 (件数は集計する)', async () => {
    fakeSupabase = createImpactSupabase({
      plan: { data: existingPlan(), error: null },
      subscriptions: subscriptions(['u1', 'u2', 'u3']),
    });

    const res = await GET(impactRequest('applies_to=on_renewal'), { params: { id: 'plan-1' } });

    expect(res.status).toBe(200);
    const json = (await res.json()) as ImpactBody;
    expect(json.data.new_monthly_price_jpy).toBe(1500);
    expect(json.data.affected_subscription_count).toBe(3);
    expect(json.data.affected_mrr_change_jpy).toBe(0);
  });

  it('既存契約が 0 件なら 0 件 / 0 円', async () => {
    fakeSupabase = createImpactSupabase({
      plan: { data: existingPlan(), error: null },
      subscriptions: subscriptions([]),
    });

    const res = await GET(impactRequest('new_monthly_price_jpy=2000&applies_to=immediately'), {
      params: { id: 'plan-1' },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as ImpactBody;
    expect(json.data.affected_subscription_count).toBe(0);
    expect(json.data.affected_mrr_change_jpy).toBe(0);
    expect(json.data.affected_user_sample).toEqual([]);
  });

  it('personal_subscriptions の集計に失敗したら 500 を返す (0 件として偽成功にしない)', async () => {
    fakeSupabase = createImpactSupabase({
      plan: { data: existingPlan(), error: null },
      subscriptions: { data: null, error: { message: 'permission denied for table personal_subscriptions' }, count: null },
    });

    const res = await GET(impactRequest('new_monthly_price_jpy=2000&applies_to=on_renewal'), {
      params: { id: 'plan-1' },
    });

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_DB_ERROR');
  });
});

describe('GET /api/super-admin/plans/[id]/price-impact (#1212: 入力検証とプラン取得)', () => {
  it('不正な applies_to は 400 (OP_INVALID_QUERY) で、DB にアクセスしない', async () => {
    fakeSupabase = createImpactSupabase({ plan: { data: existingPlan(), error: null } });

    const res = await GET(impactRequest('new_monthly_price_jpy=2000&applies_to=everyone'), {
      params: { id: 'plan-1' },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_INVALID_QUERY');
    expect(fakeSupabase.from).not.toHaveBeenCalled();
  });

  it('プランが存在しなければ 404 を返し、personal_subscriptions を集計しない', async () => {
    fakeSupabase = createImpactSupabase({
      plan: { data: null, error: { message: 'not found' } },
      subscriptions: subscriptions(['u1']),
    });

    const res = await GET(impactRequest('new_monthly_price_jpy=2000&applies_to=immediately'), {
      params: { id: 'missing' },
    });

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_PLAN_NOT_FOUND');
    expect(personalSubscriptionsCalls(fakeSupabase)).toHaveLength(0);
  });
});
