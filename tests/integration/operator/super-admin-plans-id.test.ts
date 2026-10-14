/**
 * Integration tests:
 *   GET    /api/super-admin/plans/[id]
 *   DELETE /api/super-admin/plans/[id]
 *   POST   /api/super-admin/plans/[id]/price-change
 *   GET    /api/super-admin/plans/[id]/price-impact
 *
 * Roles: super_admin only
 * Auth boundary: 403 (admin), 401 (no auth), 422 (validation/business rule)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUserWithRoles,
  cleanupTestUser,
  cleanupAuditLogs,
  testEmail,
  type TestUser,
} from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';

const TS = Date.now();

let superAdminUser: TestUser;
let adminUser: TestUser;

/** Draft plan used in GET/price-impact/price-change tests */
let draftPlanId: string;
/** Public plan used in price-change tests (non-draft path) */
let publicPlanId: string;

beforeAll(async () => {
  [superAdminUser, adminUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('plans-id-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('plans-id-admin', TS), roles: ['admin'] }),
  ]);

  // Create a draft plan for GET / DELETE tests
  // INSERT の error は必ず確認する (作れないまま黙ってスキップさせず、このあとのテストが空振りで通るのを防ぐ)
  const { data: draft, error: draftError } = await supabaseAdmin
    .from('subscription_plans')
    .insert({
      plan_key: `test_get_draft_${TS}`,
      display_name: `GET Test Draft Plan ${TS}`,
      plan_type: 'personal',
      status: 'draft',
      monthly_price_jpy: 980,
      yearly_price_jpy: 9800,
      version: 1,
    })
    .select('id')
    .single();

  if (draftError || !draft) throw new Error(`Failed to create the draft plan: ${draftError?.message}`);
  draftPlanId = draft.id;

  // Create a public plan for price-change / price-impact tests
  const { data: pub, error: pubError } = await supabaseAdmin
    .from('subscription_plans')
    .insert({
      plan_key: `test_public_plan_${TS}`,
      display_name: `Public Test Plan ${TS}`,
      plan_type: 'personal',
      status: 'public',
      monthly_price_jpy: 1500,
      yearly_price_jpy: 15000,
      version: 1,
    })
    .select('id')
    .single();

  if (pubError || !pub) throw new Error(`Failed to create the public plan: ${pubError?.message}`);
  publicPlanId = pub.id;
}, 60000);

afterAll(async () => {
  // Draft can be deleted; public plan needs status reset first
  if (draftPlanId) {
    await supabaseAdmin.from('subscription_plans').delete().eq('id', draftPlanId).eq('status', 'draft');
  }
  if (publicPlanId) {
    // Set to draft first so FK constraints allow deletion
    await supabaseAdmin
      .from('subscription_plans')
      .update({ status: 'draft' })
      .eq('id', publicPlanId);
    await supabaseAdmin.from('subscription_plans').delete().eq('id', publicPlanId);
  }

  await supabaseAdmin
    .from('plan_price_history')
    .delete()
    .in('plan_id', [draftPlanId, publicPlanId].filter(Boolean));

  await Promise.all([
    cleanupAuditLogs(superAdminUser.userId),
    cleanupAuditLogs(adminUser.userId),
  ]);

  await Promise.all([
    cleanupTestUser(superAdminUser.userId),
    cleanupTestUser(adminUser.userId),
  ]);
}, 30000);

// ─────────────────────────────────────────
// GET /api/super-admin/plans/[id]
// ─────────────────────────────────────────

describe('GET /api/super-admin/plans/[id]', () => {
  it('200 for super_admin fetching plan detail', async () => {
    if (!draftPlanId) {
      console.warn('Skipping — plan creation failed');
      return;
    }
    const res = await apiCall('GET', `/api/super-admin/plans/${draftPlanId}`, superAdminUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as { data: { id: string; plan_key: string; price_history: unknown[] } };
    expect(body.data.id).toBe(draftPlanId);
    expect(body.data).toHaveProperty('price_history');
    expect(Array.isArray(body.data.price_history)).toBe(true);
  });

  it('403 for admin', async () => {
    const id = draftPlanId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall('GET', `/api/super-admin/plans/${id}`, adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const id = draftPlanId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth('GET', `/api/super-admin/plans/${id}`);
    expect(res.status).toBe(401);
  });

  it('404 for non-existent plan', async () => {
    const res = await apiCall(
      'GET',
      '/api/super-admin/plans/00000000-0000-0000-0000-000000000000',
      superAdminUser.jwt
    );
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────
// DELETE /api/super-admin/plans/[id]
// ─────────────────────────────────────────

describe('DELETE /api/super-admin/plans/[id]', () => {
  let deletablePlanId: string;

  beforeAll(async () => {
    const { data, error } = await supabaseAdmin
      .from('subscription_plans')
      .insert({
        plan_key: `test_del_plan_${TS}`,
        display_name: `Delete Test Plan ${TS}`,
        plan_type: 'personal',
        status: 'draft',
        version: 1,
      })
      .select('id')
      .single();

    if (error || !data) throw new Error(`Failed to create the plan to delete: ${error?.message}`);
    deletablePlanId = data.id;
  });

  afterAll(async () => {
    if (deletablePlanId) {
      await supabaseAdmin.from('subscription_plans').delete().eq('id', deletablePlanId);
    }
  });

  it('403 for admin trying to delete plan', async () => {
    const id = deletablePlanId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall('DELETE', `/api/super-admin/plans/${id}`, adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const id = deletablePlanId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth('DELETE', `/api/super-admin/plans/${id}`);
    expect(res.status).toBe(401);
  });

  it('422 for deleting non-draft plan', async () => {
    if (!publicPlanId) {
      console.warn('Skipping — public plan creation failed');
      return;
    }
    const res = await apiCall('DELETE', `/api/super-admin/plans/${publicPlanId}`, superAdminUser.jwt);
    expect(res.status).toBe(422);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('OP_PLAN_NOT_DRAFT');
  });

  it('204 for super_admin deleting a draft plan', async () => {
    if (!deletablePlanId) {
      console.warn('Skipping — plan creation failed');
      return;
    }
    const res = await apiCall('DELETE', `/api/super-admin/plans/${deletablePlanId}`, superAdminUser.jwt);
    expect(res.status).toBe(204);
    deletablePlanId = '';
  });
});

// ─────────────────────────────────────────
// POST /api/super-admin/plans/[id]/price-change
// ─────────────────────────────────────────

describe('POST /api/super-admin/plans/[id]/price-change', () => {
  it('200 for super_admin executing price change on public plan', async () => {
    if (!publicPlanId) {
      console.warn('Skipping — public plan creation failed');
      return;
    }
    // #1102: 月額・年額を同時に変えられる (Stripe 同期が必須の環境でも 1 回のリクエストで両方を同期する)
    const res = await apiCall(
      'POST',
      `/api/super-admin/plans/${publicPlanId}/price-change`,
      superAdminUser.jwt,
      {
        new_monthly_price_jpy: 1800,
        new_yearly_price_jpy: 18000,
        applies_to: 'new_only',
        reason: 'Integration test price change',
        effective_at: new Date().toISOString(),
      }
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      data: { plan_id: string; new_monthly_price_jpy: number; new_yearly_price_jpy: number; applies_to: string };
    };
    expect(body.data.plan_id).toBe(publicPlanId);
    expect(body.data.new_monthly_price_jpy).toBe(1800);
    expect(body.data.new_yearly_price_jpy).toBe(18000);
    expect(body.data.applies_to).toBe('new_only');

    const { data: row } = await supabaseAdmin
      .from('subscription_plans')
      .select('monthly_price_jpy, yearly_price_jpy')
      .eq('id', publicPlanId)
      .single();
    expect(row).toEqual({ monthly_price_jpy: 1800, yearly_price_jpy: 18000 });
  });

  it('200 when only the yearly price changes (monthly price and Price IDs stay as they were)', async () => {
    if (!publicPlanId) {
      console.warn('Skipping — public plan creation failed');
      return;
    }
    const { data: before } = await supabaseAdmin
      .from('subscription_plans')
      .select('monthly_price_jpy, stripe_price_id, stripe_yearly_price_id')
      .eq('id', publicPlanId)
      .single();

    const res = await apiCall(
      'POST',
      `/api/super-admin/plans/${publicPlanId}/price-change`,
      superAdminUser.jwt,
      {
        new_monthly_price_jpy: null,
        new_yearly_price_jpy: 19000,
        reason: 'Integration test yearly-only price change (applies_to omitted = new_only)',
        effective_at: new Date().toISOString(),
      }
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: { applies_to: string } };
    expect(body.data.applies_to).toBe('new_only');

    const { data: after } = await supabaseAdmin
      .from('subscription_plans')
      .select('monthly_price_jpy, yearly_price_jpy, stripe_price_id, stripe_yearly_price_id')
      .eq('id', publicPlanId)
      .single();
    expect(after).toEqual({ ...before, yearly_price_jpy: 19000 });
  });

  it.each(['on_renewal', 'immediately'])(
    '400 for applies_to=%s (price changes apply to new contracts only), and the plan is left untouched',
    async (appliesTo) => {
      if (!publicPlanId) {
        console.warn('Skipping — public plan creation failed');
        return;
      }
      const { data: before } = await supabaseAdmin
        .from('subscription_plans')
        .select('monthly_price_jpy, yearly_price_jpy')
        .eq('id', publicPlanId)
        .single();
      const { count: historyBefore } = await supabaseAdmin
        .from('plan_price_history')
        .select('id', { count: 'exact', head: true })
        .eq('plan_id', publicPlanId);

      const res = await apiCall(
        'POST',
        `/api/super-admin/plans/${publicPlanId}/price-change`,
        superAdminUser.jwt,
        {
          new_monthly_price_jpy: 2500,
          applies_to: appliesTo,
          reason: 'Should be rejected: existing contracts cannot be re-priced',
          effective_at: new Date().toISOString(),
        }
      );
      expect(res.status).toBe(400);
      const body = res.body as { error: { code: string; message: string } };
      expect(body.error.code).toBe('OP_INVALID_INPUT');
      expect(body.error.message).toContain('new_only');

      const { data: after } = await supabaseAdmin
        .from('subscription_plans')
        .select('monthly_price_jpy, yearly_price_jpy')
        .eq('id', publicPlanId)
        .single();
      expect(after).toEqual(before);
      const { count: historyAfter } = await supabaseAdmin
        .from('plan_price_history')
        .select('id', { count: 'exact', head: true })
        .eq('plan_id', publicPlanId);
      expect(historyAfter).toBe(historyBefore);
    }
  );

  it('422 for draft plan (use PATCH instead)', async () => {
    if (!draftPlanId) {
      console.warn('Skipping — draft plan creation failed');
      return;
    }
    const res = await apiCall(
      'POST',
      `/api/super-admin/plans/${draftPlanId}/price-change`,
      superAdminUser.jwt,
      {
        new_monthly_price_jpy: 2000,
        applies_to: 'new_only',
        reason: 'Should fail',
        effective_at: new Date().toISOString(),
      }
    );
    expect(res.status).toBe(422);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('OP_PLAN_DRAFT_USE_PATCH');
  });

  it('403 for admin', async () => {
    const id = publicPlanId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall(
      'POST',
      `/api/super-admin/plans/${id}/price-change`,
      adminUser.jwt,
      {
        new_monthly_price_jpy: 999,
        applies_to: 'new_only',
        reason: 'Admin should fail',
        effective_at: new Date().toISOString(),
      }
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const id = publicPlanId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth('POST', `/api/super-admin/plans/${id}/price-change`, {
      new_monthly_price_jpy: 999,
      applies_to: 'new_only',
      reason: 'No auth',
      effective_at: new Date().toISOString(),
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// GET /api/super-admin/plans/[id]/price-impact
// ─────────────────────────────────────────

describe('GET /api/super-admin/plans/[id]/price-impact', () => {
  it('200 for super_admin fetching price impact simulation', async () => {
    if (!publicPlanId) {
      console.warn('Skipping — public plan creation failed');
      return;
    }
    const res = await apiCall(
      'GET',
      `/api/super-admin/plans/${publicPlanId}/price-impact?new_monthly_price_jpy=2000&applies_to=new_only`,
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      data: {
        affected_subscription_count: number;
        affected_mrr_change_jpy: number;
        new_monthly_price_jpy: number;
      };
    };
    expect(body.data).toHaveProperty('affected_subscription_count');
    expect(body.data).toHaveProperty('affected_mrr_change_jpy');
    expect(body.data.new_monthly_price_jpy).toBe(2000);
  });

  it('403 for admin', async () => {
    const id = publicPlanId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall(
      'GET',
      `/api/super-admin/plans/${id}/price-impact?new_monthly_price_jpy=2000`,
      adminUser.jwt
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const id = publicPlanId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth(
      'GET',
      `/api/super-admin/plans/${id}/price-impact?new_monthly_price_jpy=2000`
    );
    expect(res.status).toBe(401);
  });

  it('404 for non-existent plan', async () => {
    const res = await apiCall(
      'GET',
      '/api/super-admin/plans/00000000-0000-0000-0000-000000000000/price-impact?new_monthly_price_jpy=2000',
      superAdminUser.jwt
    );
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────
// GET /api/super-admin/plans/[id]/price-impact — 価格変更は新規契約のみ (#1102 / #1212)
//
// 従来は applies_to を無視して常に「全既存契約者 x 価格差」を返していたため、
// 新規契約のみ (new_only) でも既存契約への即時の収益影響として表示されていた (#1212)。
// オーナー判断 (2026-10-08, #1102): 価格変更は新規契約だけに適用する。applies_to は new_only だけ。
// on_renewal / immediately は 400 で、既存契約者が居ても影響は常に 0 件 / 0 円。
// personal_subscriptions を実際に seed し、既存契約者が居ても数えられないことを検証する。
// 他の describe が公開プランの価格を変更する (price-change) ため、専用のプランを使う。
// ─────────────────────────────────────────

describe('GET /api/super-admin/plans/[id]/price-impact (#1102: 新規契約のみ。既存契約者が居ても影響なし)', () => {
  const CURRENT_PRICE = 1000;
  const NEW_PRICE = 1300;
  /**
   * 既存の契約 (同一プラン + active/trialing/paused + Stripe サブスクあり)。
   * 以前はこれらを数えて MRR 変化を返していた。いまは居ても数えない (新規契約のみ)。
   * 1 ユーザーが持てる有効な契約は 1 件 (部分ユニーク索引) のため、契約ごとに別ユーザーを使う。
   */
  const COUNTED_STATUSES = ['active', 'active', 'active', 'active', 'trialing', 'paused'] as const;
  const COUNTED = COUNTED_STATUSES.length;

  let impactPlanId: string;
  let otherPlanId: string;
  let userIds: string[] = [];

  /** 契約の seed 用に、認証ユーザーだけを作る (ロール・JWT は不要) */
  async function createSubscriberUser(index: number): Promise<string> {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: testEmail(`plans-impact-sub${index}`, TS),
      password: 'TestPass!2026',
      email_confirm: true,
    });
    if (error || !data.user) {
      throw new Error(`Failed to create subscriber user ${index}: ${error?.message}`);
    }
    return data.user.id;
  }

  beforeAll(async () => {
    const planBase = {
      plan_type: 'personal',
      status: 'public',
      monthly_price_jpy: CURRENT_PRICE,
      yearly_price_jpy: 10000,
      version: 1,
    };
    const { data: plans, error: planErr } = await supabaseAdmin
      .from('subscription_plans')
      .insert([
        { ...planBase, plan_key: `test_impact_${TS}`, display_name: `Impact Test Plan ${TS}` },
        { ...planBase, plan_key: `test_impact_other_${TS}`, display_name: `Impact Other Plan ${TS}` },
      ])
      .select('id, plan_key');
    if (planErr || !plans) {
      throw new Error(`Failed to create impact test plans: ${planErr?.message}`);
    }
    impactPlanId = plans.find((p) => p.plan_key === `test_impact_${TS}`)!.id;
    otherPlanId = plans.find((p) => p.plan_key === `test_impact_other_${TS}`)!.id;

    // 集計対象 6 人 + 対象外の seed 用 2 人
    userIds = await Promise.all(Array.from({ length: COUNTED + 2 }, (_, i) => createSubscriberUser(i)));
    const pausedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { error: subErr } = await supabaseAdmin.from('personal_subscriptions').insert([
      ...COUNTED_STATUSES.map((status, i) => ({
        user_id: userIds[i],
        plan_key: `test_impact_${TS}`,
        status,
        stripe_subscription_id: `sub_test_${TS}_${i}`,
        // status='paused' は paused_until 必須 (ps_paused_until_required)
        ...(status === 'paused' ? { paused_until: pausedUntil } : {}),
      })),
      // 対象外: 解約済み (cancelled は有効な契約の部分ユニーク索引の対象外なので 1 人目に重ねて seed できる)
      {
        user_id: userIds[0],
        plan_key: `test_impact_${TS}`,
        status: 'cancelled',
        stripe_subscription_id: `sub_test_${TS}_cancelled`,
      },
      // 対象外: Stripe サブスクリプションを持たない契約
      { user_id: userIds[COUNTED], plan_key: `test_impact_${TS}`, status: 'active', stripe_subscription_id: null },
      // 対象外: 別プランの契約
      {
        user_id: userIds[COUNTED + 1],
        plan_key: `test_impact_other_${TS}`,
        status: 'active',
        stripe_subscription_id: `sub_test_${TS}_other`,
      },
    ]);
    if (subErr) {
      throw new Error(`Failed to seed personal_subscriptions: ${subErr.message}`);
    }
  }, 90000);

  afterAll(async () => {
    // personal_subscriptions.plan_key は ON DELETE RESTRICT のため、契約 → ユーザー → プランの順に消す
    if (userIds.length > 0) {
      await supabaseAdmin.from('personal_subscriptions').delete().in('user_id', userIds);
      await Promise.all(userIds.map((id) => cleanupTestUser(id)));
    }
    for (const planId of [impactPlanId, otherPlanId].filter(Boolean)) {
      await supabaseAdmin.from('subscription_plans').update({ status: 'draft' }).eq('id', planId);
      await supabaseAdmin.from('subscription_plans').delete().eq('id', planId);
    }
  }, 60000);

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

  const impactPath = (appliesTo?: string) =>
    `/api/super-admin/plans/${impactPlanId}/price-impact?new_monthly_price_jpy=${NEW_PRICE}` +
    (appliesTo ? `&applies_to=${appliesTo}` : '');

  it('new_only: 既存契約者が居ても 0 件 / MRR 変化 0 / サンプルなし (既存契約は現行価格のまま)', async () => {
    const res = await apiCall('GET', impactPath('new_only'), superAdminUser.jwt);
    expect(res.status).toBe(200);
    const { data } = res.body as ImpactBody;
    expect(data.affected_subscription_count).toBe(0);
    expect(data.affected_mrr_change_jpy).toBe(0);
    expect(data.affected_user_sample).toEqual([]);
    expect(data.applies_to).toBe('new_only');
    expect(data.effective_timing).toBe('none');
    expect(data.current_monthly_price_jpy).toBe(CURRENT_PRICE);
    expect(data.new_monthly_price_jpy).toBe(NEW_PRICE);
  });

  it('applies_to を省略した場合は new_only 扱い', async () => {
    const res = await apiCall('GET', impactPath(), superAdminUser.jwt);
    expect(res.status).toBe(200);
    const { data } = res.body as ImpactBody;
    expect(data.applies_to).toBe('new_only');
    expect(data.affected_subscription_count).toBe(0);
    expect(data.affected_mrr_change_jpy).toBe(0);
  });

  it.each(['on_renewal', 'immediately'])(
    '400 for applies_to=%s (既存契約へは反映できないため、選択肢ごと廃止)',
    async (appliesTo) => {
      const res = await apiCall('GET', impactPath(appliesTo), superAdminUser.jwt);
      expect(res.status).toBe(400);
      const body = res.body as { error: { code: string; message: string } };
      expect(body.error.code).toBe('OP_INVALID_QUERY');
      expect(body.error.message).toContain('new_only');
    }
  );

  it('400 for invalid applies_to', async () => {
    const res = await apiCall('GET', impactPath('everyone'), superAdminUser.jwt);
    expect(res.status).toBe(400);
  });
});
