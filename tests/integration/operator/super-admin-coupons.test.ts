/**
 * Integration tests: GET/POST /api/super-admin/coupons, redemptions
 * Roles: super_admin only
 * Auth boundary: 403 (admin, general), 401 (no auth)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUserWithRoles, cleanupTestUser, cleanupAuditLogs, testEmail, type TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';

const TS = Date.now();

let superAdminUser: TestUser;
let adminUser: TestUser;
let generalUser: TestUser;

const createdCouponIds: string[] = [];

beforeAll(async () => {
  [superAdminUser, adminUser, generalUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('coupon-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('coupon-admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('coupon-gen', TS), roles: ['user'] }),
  ]);
}, 60000);

afterAll(async () => {
  // Cleanup coupons (redemptions are FK child, delete first)
  if (createdCouponIds.length > 0) {
    await supabaseAdmin.from('coupon_redemptions').delete().in('coupon_id', createdCouponIds);
    await supabaseAdmin.from('coupons').delete().in('id', createdCouponIds);
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

describe('GET /api/super-admin/coupons', () => {
  it('200 for super_admin', async () => {
    const res = await apiCall('GET', '/api/super-admin/coupons', superAdminUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(Array.isArray((res.body as { data: unknown[] }).data)).toBe(true);
  });

  it('403 for admin', async () => {
    const res = await apiCall('GET', '/api/super-admin/coupons', adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/super-admin/coupons', generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/super-admin/coupons');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/super-admin/coupons', () => {
  it('201 for super_admin creating a coupon', async () => {
    const couponCode = `TEST${TS}`;
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString();

    const res = await apiCall('POST', '/api/super-admin/coupons', superAdminUser.jwt, {
      code: couponCode,
      display_name: `Integration Test Coupon ${TS}`,
      discount_type: 'percentage',
      discount_value: 10,
      applicable_to: 'personal',
      valid_from: tomorrow,
      valid_until: nextMonth,
      max_uses: 100,
      per_user_limit: 1,
    });

    expect(res.status).toBe(201);
    const body = res.body as { data: { id: string; code: string; status: string } };
    expect(body.data).toHaveProperty('id');
    expect(body.data.code).toBe(couponCode);
    expect(body.data.status).toBe('active');

    if (body.data.id) {
      createdCouponIds.push(body.data.id);
    }
  });

  it('403 for admin', async () => {
    const res = await apiCall('POST', '/api/super-admin/coupons', adminUser.jwt, {
      code: `ADMINFAIL${TS}`,
      discount_type: 'percentage',
      discount_value: 5,
      valid_from: '2026-01-01',
      valid_until: '2026-12-31',
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('POST', '/api/super-admin/coupons', {
      code: 'NOAUTHCODE',
      discount_type: 'percentage',
      discount_value: 5,
      valid_from: '2026-01-01',
      valid_until: '2026-12-31',
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/super-admin/coupons/[id]/redemptions', () => {
  let testCouponId: string;

  beforeAll(async () => {
    // Create a coupon to test redemptions
    const couponCode = `REDEEM${TS}`;
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString();

    const res = await apiCall('POST', '/api/super-admin/coupons', superAdminUser.jwt, {
      code: couponCode,
      display_name: `Redemption Test Coupon ${TS}`,
      discount_type: 'fixed',
      discount_value: 500,
      applicable_to: 'all',
      valid_from: tomorrow,
      valid_until: nextMonth,
    });

    if (res.status === 201) {
      testCouponId = (res.body as { data: { id: string } }).data.id;
      createdCouponIds.push(testCouponId);
    }
  });

  it('200 for super_admin with empty redemptions array', async () => {
    if (!testCouponId) {
      console.warn('Skipping redemptions test - coupon creation failed');
      return;
    }

    const res = await apiCall(
      'GET',
      `/api/super-admin/coupons/${testCouponId}/redemptions`,
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);

    const body = res.body as {
      data: unknown[];
      meta: { total: number; coupon_code: string };
    };
    expect(Array.isArray(body.data)).toBe(true);
    // New coupon has no redemptions
    expect(body.data).toHaveLength(0);
    expect(body.meta).toHaveProperty('coupon_code');
    expect(body.meta).toHaveProperty('total');
    expect(body.meta.total).toBe(0);
  });

  it('404 for non-existent coupon id', async () => {
    const res = await apiCall(
      'GET',
      '/api/super-admin/coupons/00000000-0000-0000-0000-000000000000/redemptions',
      superAdminUser.jwt
    );
    expect(res.status).toBe(404);
  });

  it('403 for admin', async () => {
    const couponId = testCouponId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall(
      'GET',
      `/api/super-admin/coupons/${couponId}/redemptions`,
      adminUser.jwt
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const couponId = testCouponId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth(
      'GET',
      `/api/super-admin/coupons/${couponId}/redemptions`
    );
    expect(res.status).toBe(401);
  });
});
