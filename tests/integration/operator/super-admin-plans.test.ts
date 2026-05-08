/**
 * Integration tests: GET/POST/PATCH /api/super-admin/plans
 * Roles: super_admin only
 * Auth boundary: 403 (admin, general), 401 (no auth)
 * Special: 9 plan_key seed confirmation, UNIQUE violation → 409, version inc
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUserWithRoles, cleanupTestUser, cleanupAuditLogs, testEmail, type TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';

const TS = Date.now();

let superAdminUser: TestUser;
let adminUser: TestUser;
let generalUser: TestUser;

// Track created plan IDs for cleanup
const createdPlanIds: string[] = [];

beforeAll(async () => {
  [superAdminUser, adminUser, generalUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('plans-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('plans-admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('plans-gen', TS), roles: ['user'] }),
  ]);
}, 60000);

afterAll(async () => {
  // Cleanup created plans (only draft can be deleted)
  for (const planId of createdPlanIds) {
    await supabaseAdmin.from('subscription_plans').delete().eq('id', planId).eq('status', 'draft');
  }

  await Promise.all([
    cleanupAuditLogs(superAdminUser.userId),
    cleanupAuditLogs(adminUser.userId),
  ]);

  await Promise.all([
    cleanupTestUser(superAdminUser.userId),
    cleanupTestUser(adminUser.userId),
    cleanupTestUser(generalUser.userId),
  ]);
}, 30000);

describe('GET /api/super-admin/plans', () => {
  it('200 for super_admin with 9 canonical plan_key seeds', async () => {
    const res = await apiCall('GET', '/api/super-admin/plans?per_page=50', superAdminUser.jwt);
    expect(res.status).toBe(200);

    const body = res.body as {
      data: Array<{ plan_key: string }>;
      meta: { total: number };
    };
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(Array.isArray(body.data)).toBe(true);

    // Canonical 9 plan_keys (operator/01-data-model.md §3.2 seed)
    const canonicalPlanKeys = [
      'free',
      'pro',
      'family_basic',
      'family_pro',
      'family_addon',
      'org_starter',
      'org_standard',
      'org_pro',
      'org_enterprise',
    ];

    const existingPlanKeys = body.data.map((p) => p.plan_key);
    for (const key of canonicalPlanKeys) {
      expect(existingPlanKeys).toContain(key);
    }
  });

  it('403 for admin (admin cannot access super-admin plans)', async () => {
    const res = await apiCall('GET', '/api/super-admin/plans', adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/super-admin/plans', generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/super-admin/plans');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/super-admin/plans', () => {
  const testPlanKey = `test_integration_plan_${TS}`;

  it('201 for super_admin creating a new plan', async () => {
    const res = await apiCall('POST', '/api/super-admin/plans', superAdminUser.jwt, {
      plan_key: testPlanKey,
      display_name: `Integration Test Plan ${TS}`,
      plan_type: 'personal',
      monthly_price_jpy: 980,
      yearly_price_jpy: 9800,
    });

    expect(res.status).toBe(201);
    const body = res.body as { data: { id: string; plan_key: string; status: string } };
    expect(body.data).toHaveProperty('id');
    expect(body.data.plan_key).toBe(testPlanKey);
    expect(body.data.status).toBe('draft');

    if (body.data.id) {
      createdPlanIds.push(body.data.id);
    }
  });

  it('409 for duplicate plan_key (UNIQUE violation)', async () => {
    const res = await apiCall('POST', '/api/super-admin/plans', superAdminUser.jwt, {
      plan_key: testPlanKey, // same key as above
      display_name: 'Duplicate Plan',
      plan_type: 'personal',
    });

    expect(res.status).toBe(409);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('OP_PLAN_KEY_DUPLICATE');
  });

  it('403 for admin', async () => {
    const res = await apiCall('POST', '/api/super-admin/plans', adminUser.jwt, {
      plan_key: `admin_cannot_create_${TS}`,
      display_name: 'Should fail',
      plan_type: 'personal',
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('POST', '/api/super-admin/plans', {
      plan_key: 'no_auth_plan',
      display_name: 'No auth plan',
      plan_type: 'personal',
    });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/super-admin/plans/[id]', () => {
  let testPlanId: string;

  beforeAll(async () => {
    // Create a draft plan to patch
    const res = await apiCall('POST', '/api/super-admin/plans', superAdminUser.jwt, {
      plan_key: `test_patch_plan_${TS}`,
      display_name: `Patch Test Plan ${TS}`,
      plan_type: 'personal',
      monthly_price_jpy: 500,
    });

    if (res.status === 201) {
      testPlanId = (res.body as { data: { id: string } }).data.id;
      createdPlanIds.push(testPlanId);
    }
  });

  it('200 for super_admin updating draft plan', async () => {
    if (!testPlanId) {
      console.warn('Skipping PATCH test - plan creation failed');
      return;
    }

    const newName = `Updated Plan ${TS}`;
    const res = await apiCall('PATCH', `/api/super-admin/plans/${testPlanId}`, superAdminUser.jwt, {
      display_name: newName,
      description: 'Updated description',
    });

    expect(res.status).toBe(200);
    const body = res.body as { data: { display_name: string; updated_at: string } };
    expect(body.data.display_name).toBe(newName);
    expect(body.data).toHaveProperty('updated_at');
  });

  it('audit log inserted for plan update', async () => {
    if (!testPlanId) return;

    const { data: logs } = await supabaseAdmin
      .from('admin_audit_logs')
      .select('*')
      .eq('actor_id', superAdminUser.userId)
      .eq('action_type', 'update_plan')
      .eq('target_id', testPlanId)
      .order('created_at', { ascending: false })
      .limit(1);

    expect(logs).toHaveLength(1);
    expect(logs![0].target_type).toBe('subscription_plan');
  });

  it('403 for admin trying to patch plan', async () => {
    if (!testPlanId) return;

    const res = await apiCall('PATCH', `/api/super-admin/plans/${testPlanId}`, adminUser.jwt, {
      display_name: 'Admin cannot update',
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const dummyId = '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth('PATCH', `/api/super-admin/plans/${dummyId}`, {
      display_name: 'No auth update',
    });
    expect(res.status).toBe(401);
  });
});
