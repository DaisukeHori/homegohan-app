/**
 * Integration tests: PATCH/DELETE /api/super-admin/coupons/[id]
 * Roles: super_admin only
 * Auth boundary: 403 (admin), 401 (no auth), 422 (validation)
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

/** Coupon created in beforeAll and used across tests */
let testCouponId: string;

beforeAll(async () => {
  [superAdminUser, adminUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('coupon-id-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('coupon-id-admin', TS), roles: ['admin'] }),
  ]);

  // Create a test coupon directly via admin client
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

  const { data, error } = await supabaseAdmin
    .from('coupons')
    .insert({
      code: `IDTEST${TS}`,
      display_name: `ID Test Coupon ${TS}`,
      discount_type: 'percentage',
      discount_value: 10,
      applicable_to: 'personal',
      valid_from: tomorrow,
      valid_until: nextMonth,
      max_uses: 100,
      per_user_limit: 1,
      uses_count: 0,
      status: 'active',
      created_by: superAdminUser.userId,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Failed to create test coupon: ${error?.message}`);
  }
  testCouponId = data.id;
}, 60000);

afterAll(async () => {
  if (testCouponId) {
    await supabaseAdmin.from('coupon_redemptions').delete().eq('coupon_id', testCouponId);
    await supabaseAdmin.from('coupons').delete().eq('id', testCouponId);
  }

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
// PATCH /api/super-admin/coupons/[id]
// ─────────────────────────────────────────

describe('PATCH /api/super-admin/coupons/[id]', () => {
  it('200 for super_admin updating a coupon', async () => {
    const res = await apiCall('PATCH', `/api/super-admin/coupons/${testCouponId}`, superAdminUser.jwt, {
      display_name: `Updated Coupon ${TS}`,
      status: 'paused',
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: { id: string; display_name: string; status: string } };
    expect(body.data.id).toBe(testCouponId);
    expect(body.data.status).toBe('paused');
  });

  it('403 for admin trying to patch coupon', async () => {
    const res = await apiCall('PATCH', `/api/super-admin/coupons/${testCouponId}`, adminUser.jwt, {
      display_name: 'Admin cannot update',
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('PATCH', `/api/super-admin/coupons/${testCouponId}`, {
      display_name: 'No auth update',
    });
    expect(res.status).toBe(401);
  });

  it('400/422 for invalid body (empty update fields)', async () => {
    const res = await apiCall('PATCH', `/api/super-admin/coupons/${testCouponId}`, superAdminUser.jwt, {
      // CouponUpdateSchema requires at least one field — send invalid type
      discount_value: 'not-a-number',
    });
    // Zod validation rejects invalid type → 400 (OP_INVALID_INPUT) or 400 from no update fields
    expect([400, 422]).toContain(res.status);
  });
});

// ─────────────────────────────────────────
// DELETE /api/super-admin/coupons/[id]
// ─────────────────────────────────────────

describe('DELETE /api/super-admin/coupons/[id]', () => {
  let deletableCouponId: string;

  beforeAll(async () => {
    // Create a coupon with uses_count=0 that can be deleted
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

    const { data } = await supabaseAdmin
      .from('coupons')
      .insert({
        code: `DELTEST${TS}`,
        display_name: `Delete Test Coupon ${TS}`,
        discount_type: 'fixed',
        discount_value: 500,
        applicable_to: 'all',
        valid_from: tomorrow,
        valid_until: nextMonth,
        uses_count: 0,
        status: 'active',
        created_by: superAdminUser.userId,
      })
      .select('id')
      .single();

    if (data) {
      deletableCouponId = data.id;
    }
  });

  afterAll(async () => {
    // Cleanup if test did not delete
    if (deletableCouponId) {
      await supabaseAdmin.from('coupons').delete().eq('id', deletableCouponId);
    }
  });

  it('403 for admin trying to delete coupon', async () => {
    const couponId = deletableCouponId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall('DELETE', `/api/super-admin/coupons/${couponId}`, adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const couponId = deletableCouponId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth('DELETE', `/api/super-admin/coupons/${couponId}`);
    expect(res.status).toBe(401);
  });

  it('404 for non-existent coupon', async () => {
    const res = await apiCall(
      'DELETE',
      '/api/super-admin/coupons/00000000-0000-0000-0000-000000000000',
      superAdminUser.jwt
    );
    expect(res.status).toBe(404);
  });

  it('204 for super_admin deleting unused coupon', async () => {
    if (!deletableCouponId) {
      console.warn('Skipping DELETE test — coupon creation failed');
      return;
    }
    const res = await apiCall('DELETE', `/api/super-admin/coupons/${deletableCouponId}`, superAdminUser.jwt);
    expect(res.status).toBe(204);
    // Mark as deleted so afterAll cleanup is skipped
    deletableCouponId = '';
  });
});
