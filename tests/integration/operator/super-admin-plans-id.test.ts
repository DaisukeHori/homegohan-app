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
  const { data: draft } = await supabaseAdmin
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

  if (draft) {
    draftPlanId = draft.id;
  }

  // Create a public plan for price-change / price-impact tests
  const { data: pub } = await supabaseAdmin
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

  if (pub) {
    publicPlanId = pub.id;
  }
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
    const { data } = await supabaseAdmin
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

    if (data) {
      deletablePlanId = data.id;
    }
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
    const body = res.body as { data: { plan_id: string; new_monthly_price_jpy: number } };
    expect(body.data.plan_id).toBe(publicPlanId);
    expect(body.data.new_monthly_price_jpy).toBe(1800);
  });

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
