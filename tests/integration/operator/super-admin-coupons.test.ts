/**
 * Integration tests: GET/POST /api/super-admin/coupons, redemptions
 * Roles: super_admin only
 * Auth boundary: 403 (admin, general), 401 (no auth)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUserWithRoles, cleanupTestUser, cleanupAuditLogs, testEmail, type TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';
import { jstDayOffset } from '@/lib/jst-day-ranges';

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
    // #1483: 有効開始日・有効期限は JST の暦日 (YYYY-MM-DD) で送る
    const tomorrow = jstDayOffset(1);
    const nextMonth = jstDayOffset(30);

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
    // #1483: 有効開始日・有効期限は JST の暦日 (YYYY-MM-DD) で送る
    const tomorrow = jstDayOffset(1);
    const nextMonth = jstDayOffset(30);

    const res = await apiCall('POST', '/api/super-admin/coupons', superAdminUser.jwt, {
      code: couponCode,
      display_name: `Redemption Test Coupon ${TS}`,
      discount_type: 'fixed',
      discount_value: 500,
      applicable_to: 'all',
      valid_from: tomorrow,
      valid_until: nextMonth,
    });

    // 作れなかったときに黙ってスキップさせない (このあとのテストが空振りで通るのを防ぐ)
    if (res.status !== 201) {
      throw new Error(`Failed to create the coupon for the redemptions tests: ${res.status} ${JSON.stringify(res.body)}`);
    }
    testCouponId = (res.body as { data: { id: string } }).data.id;
    createdCouponIds.push(testCouponId);
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

/**
 * #1483: 有効開始日・有効期限は JST の暦日。開始日の JST 0:00 から、期限の日の JST 23:59:59 まで使える。
 * 使えるかどうかの判定は DB の関数 apply_coupon の `now() < valid_from` (開始前) / `now() > valid_until` (期限切れ)。
 * DB の now() は動かせないので、同じ比べ方を DB (timestamptz の比較。マイクロ秒の精度) に境目の時刻で問い合わせて確かめる:
 *   開始前でない = `valid_from <= 時刻` / 期限切れでない = `valid_until >= 時刻`
 */
describe('POST /api/super-admin/coupons: 有効開始日・有効期限の JST の境目 (#1483)', () => {
  let boundaryCouponId: string;

  beforeAll(async () => {
    const res = await apiCall('POST', '/api/super-admin/coupons', superAdminUser.jwt, {
      code: `JSTDAY${TS}`,
      discount_type: 'percentage',
      discount_value: 10,
      valid_from: '2026-10-10',
      valid_until: '2026-10-20',
    });
    if (res.status !== 201) {
      throw new Error(`Failed to create the coupon for the JST boundary tests: ${res.status} ${JSON.stringify(res.body)}`);
    }
    boundaryCouponId = (res.body as { data: { id: string } }).data.id;
    createdCouponIds.push(boundaryCouponId);
  });

  /** apply_coupon の判定で、その時刻にクーポンが開始前でないか (valid_from <= at) を DB で比べる */
  async function startedAt(at: string): Promise<boolean> {
    const { data, error } = await supabaseAdmin.from('coupons').select('id').eq('id', boundaryCouponId).lte('valid_from', at);
    if (error) throw new Error(error.message);
    return data.length === 1;
  }

  /** apply_coupon の判定で、その時刻にクーポンが期限切れでないか (valid_until >= at) を DB で比べる */
  async function notExpiredAt(at: string): Promise<boolean> {
    const { data, error } = await supabaseAdmin.from('coupons').select('id').eq('id', boundaryCouponId).gte('valid_until', at);
    if (error) throw new Error(error.message);
    return data.length === 1;
  }

  it('期限の日の 23:59:59 JST は有効・翌日の 0:00 JST は無効', async () => {
    expect(await notExpiredAt('2026-10-20T23:59:59+09:00')).toBe(true);
    expect(await notExpiredAt('2026-10-20T23:59:59.999999+09:00')).toBe(true);
    expect(await notExpiredAt('2026-10-21T00:00:00+09:00')).toBe(false);
  });

  it('開始日の 0:00 JST から有効・前日の 23:59 JST は無効', async () => {
    expect(await startedAt('2026-10-10T00:00:00+09:00')).toBe(true);
    expect(await startedAt('2026-10-09T23:59:00+09:00')).toBe(false);
    expect(await startedAt('2026-10-09T23:59:59.999999+09:00')).toBe(false);
  });

  it('一覧・詳細で読み出す時刻は、JST の暦日にすると入力した日付に戻る', async () => {
    const res = await apiCall('GET', `/api/super-admin/coupons/${boundaryCouponId}`, superAdminUser.jwt);
    expect(res.status).toBe(200);
    const coupon = (res.body as { data: { valid_from: string; valid_until: string } }).data;
    expect(new Date(coupon.valid_from).toISOString()).toBe('2026-10-09T15:00:00.000Z');
    expect(coupon.valid_until).toMatch(/^2026-10-20T14:59:59\.999999(\+00:00|Z)$/);
  });

  it('PATCH で有効期限を日付で変えると、その日の JST 23:59:59.999999 になる', async () => {
    const res = await apiCall('PATCH', `/api/super-admin/coupons/${boundaryCouponId}`, superAdminUser.jwt, {
      valid_until: '2026-10-31',
    });
    expect(res.status).toBe(200);
    expect(await notExpiredAt('2026-10-31T23:59:59.999999+09:00')).toBe(true);
    expect(await notExpiredAt('2026-11-01T00:00:00+09:00')).toBe(false);
  });

  it('存在しない日付は 400 OP_INVALID_INPUT', async () => {
    const post = await apiCall('POST', '/api/super-admin/coupons', superAdminUser.jwt, {
      code: `JSTBAD${TS}`,
      discount_type: 'percentage',
      discount_value: 10,
      valid_from: '2026-02-30',
      valid_until: '2026-10-20',
    });
    expect(post.status).toBe(400);
    expect((post.body as { error: { code: string } }).error.code).toBe('OP_INVALID_INPUT');

    const patch = await apiCall('PATCH', `/api/super-admin/coupons/${boundaryCouponId}`, superAdminUser.jwt, {
      valid_until: '2026-02-30',
    });
    expect(patch.status).toBe(400);
    expect((patch.body as { error: { code: string } }).error.code).toBe('OP_INVALID_INPUT');
  });
});
