/**
 * #1102 (旧 #1212) 価格変更の影響シミュレーション API の contract テスト
 * GET /api/super-admin/plans/[id]/price-impact
 *
 * オーナー判断 (2026-10-08): 価格変更は新規契約だけに適用する。既存の契約者の請求額は変わらない。
 * そのため、この API は適用範囲 (applies_to) を new_only だけ受け付け、既存契約への影響は常に 0 件 / 0 円を返す。
 *   - new_only (省略時も)  : 既存契約は現行価格のまま。personal_subscriptions を集計せず 0 件 / 0 円 / サンプルなし
 *   - on_renewal / immediately : 400 (OP_INVALID_QUERY)。以前は既存契約を集計して返していたが、
 *     既存サブスクリプションへ新価格を反映する処理は無く (選んでも請求額は変わらない)、偽の選択肢だったため廃止した
 *
 * (#1212 の経緯: それ以前は applies_to をエコーバックするだけで、new_only を選んでも
 *  「全既存契約者 x 価格差」を MRR 影響として返していた。)
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

/**
 * subscription_plans (プラン取得) だけを返す Supabase フェイク。
 * 他のテーブル (personal_subscriptions など) へアクセスしたら例外にする。
 */
function createImpactSupabase(opts: { plan: FakeQueryResult }) {
  const from = vi.fn((table: string) => {
    if (table === 'subscription_plans') return createQueryBuilder(opts.plan);
    throw new Error(`unexpected table "${table}"`);
  });
  return { from };
}

/** 現行月額 1,500 円の個人プラン */
function existingPlan() {
  return { id: 'plan-1', plan_key: 'pro', monthly_price_jpy: 1500, plan_type: 'personal' };
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

function tablesAccessed(fake: ReturnType<typeof createImpactSupabase>) {
  return fake.from.mock.calls.map((c) => c[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(actor);
});

describe('GET /api/super-admin/plans/[id]/price-impact (#1102: 新規契約のみ。既存契約に影響しない)', () => {
  it('new_only は 0 件 / 0 円 / サンプルなしを返し、personal_subscriptions を集計しない', async () => {
    fakeSupabase = createImpactSupabase({ plan: { data: existingPlan(), error: null } });

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
    // プランの存在確認だけ。契約の集計はしない
    expect(tablesAccessed(fakeSupabase)).toEqual(['subscription_plans']);
  });

  it('値下げでも MRR 変化は 0 (既存契約は現行価格のまま)', async () => {
    fakeSupabase = createImpactSupabase({ plan: { data: existingPlan(), error: null } });

    const res = await GET(impactRequest('new_monthly_price_jpy=1000&applies_to=new_only'), {
      params: { id: 'plan-1' },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as ImpactBody;
    expect(json.data.affected_subscription_count).toBe(0);
    expect(json.data.affected_mrr_change_jpy).toBe(0);
    expect(json.data.new_monthly_price_jpy).toBe(1000);
  });

  it('applies_to を省略した場合も new_only として扱う', async () => {
    fakeSupabase = createImpactSupabase({ plan: { data: existingPlan(), error: null } });

    const res = await GET(impactRequest('new_monthly_price_jpy=2000'), { params: { id: 'plan-1' } });

    expect(res.status).toBe(200);
    const json = (await res.json()) as ImpactBody;
    expect(json.data.applies_to).toBe('new_only');
    expect(json.data.effective_timing).toBe('none');
    expect(json.data.affected_subscription_count).toBe(0);
    expect(json.data.affected_mrr_change_jpy).toBe(0);
    expect(tablesAccessed(fakeSupabase)).toEqual(['subscription_plans']);
  });

  it('新価格を省略した場合は現行価格を返す (新価格 = 現行価格)', async () => {
    fakeSupabase = createImpactSupabase({ plan: { data: existingPlan(), error: null } });

    const res = await GET(impactRequest(''), { params: { id: 'plan-1' } });

    expect(res.status).toBe(200);
    const json = (await res.json()) as ImpactBody;
    expect(json.data.current_monthly_price_jpy).toBe(1500);
    expect(json.data.new_monthly_price_jpy).toBe(1500);
    expect(json.data.affected_mrr_change_jpy).toBe(0);
  });

  it('現行月額が未設定 (NULL) のプランは 0 円として扱う', async () => {
    fakeSupabase = createImpactSupabase({
      plan: { data: { ...existingPlan(), monthly_price_jpy: null }, error: null },
    });

    const res = await GET(impactRequest('new_monthly_price_jpy=500'), { params: { id: 'plan-1' } });

    expect(res.status).toBe(200);
    const json = (await res.json()) as ImpactBody;
    expect(json.data.current_monthly_price_jpy).toBe(0);
    expect(json.data.new_monthly_price_jpy).toBe(500);
  });
});

describe('GET /api/super-admin/plans/[id]/price-impact (#1102: new_only 以外は 400)', () => {
  it.each(['on_renewal', 'immediately'])(
    '%s は 400 (OP_INVALID_QUERY) で拒否し、DB にアクセスしない',
    async (appliesTo) => {
      fakeSupabase = createImpactSupabase({ plan: { data: existingPlan(), error: null } });

      const res = await GET(impactRequest(`new_monthly_price_jpy=2000&applies_to=${appliesTo}`), {
        params: { id: 'plan-1' },
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe('OP_INVALID_QUERY');
      // 理由が読める message (issues 配列の生 JSON ではない)
      expect(json.error.message).toContain('new_only');
      expect(json.error.message.startsWith('[')).toBe(false);
      expect(fakeSupabase.from).not.toHaveBeenCalled();
    },
  );

  it('不正な applies_to も 400 (OP_INVALID_QUERY) で、DB にアクセスしない', async () => {
    fakeSupabase = createImpactSupabase({ plan: { data: existingPlan(), error: null } });

    const res = await GET(impactRequest('new_monthly_price_jpy=2000&applies_to=everyone'), {
      params: { id: 'plan-1' },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_INVALID_QUERY');
    expect(fakeSupabase.from).not.toHaveBeenCalled();
  });

  it('新価格が負の値・小数なら 400 (OP_INVALID_QUERY)', async () => {
    fakeSupabase = createImpactSupabase({ plan: { data: existingPlan(), error: null } });

    for (const bad of ['-1', '12.5']) {
      const res = await GET(impactRequest(`new_monthly_price_jpy=${bad}`), { params: { id: 'plan-1' } });
      expect(res.status).toBe(400);
    }
    expect(fakeSupabase.from).not.toHaveBeenCalled();
  });
});

describe('GET /api/super-admin/plans/[id]/price-impact (#1102: 権限とプラン取得)', () => {
  it('プランが存在しなければ 404 を返す', async () => {
    fakeSupabase = createImpactSupabase({ plan: { data: null, error: { message: 'not found' } } });

    const res = await GET(impactRequest('new_monthly_price_jpy=2000'), { params: { id: 'missing' } });

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OP_PLAN_NOT_FOUND');
    expect(tablesAccessed(fakeSupabase)).toEqual(['subscription_plans']);
  });

  it('super_admin 以外 (requireRole が拒否) は 403 で、DB にアクセスしない', async () => {
    const { ForbiddenError } = await import('@/lib/auth/errors');
    mockRequireRole.mockRejectedValue(new ForbiddenError('forbidden'));
    fakeSupabase = createImpactSupabase({ plan: { data: existingPlan(), error: null } });

    const res = await GET(impactRequest('new_monthly_price_jpy=2000'), { params: { id: 'plan-1' } });

    expect(res.status).toBe(403);
    expect(fakeSupabase.from).not.toHaveBeenCalled();
  });
});
