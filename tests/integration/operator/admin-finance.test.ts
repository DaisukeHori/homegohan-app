/**
 * Integration tests: GET /api/admin/finance/dashboard, revenue
 * Roles: finance, admin, super_admin
 * Auth boundary: 403 (general user)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUserWithRoles, cleanupTestUser, testEmail, type TestUser } from '../helpers/users';
import { apiCall, apiCallNoAuth } from '../helpers/api';

const TS = Date.now();

let financeUser: TestUser;
let adminUser: TestUser;
let superAdminUser: TestUser;
let generalUser: TestUser;

beforeAll(async () => {
  [financeUser, adminUser, superAdminUser, generalUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('fin-fin', TS), roles: ['finance'] }),
    createTestUserWithRoles({ email: testEmail('fin-admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('fin-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('fin-gen', TS), roles: ['user'] }),
  ]);
}, 60000);

afterAll(async () => {
  await Promise.all([
    cleanupTestUser(financeUser.userId),
    cleanupTestUser(adminUser.userId),
    cleanupTestUser(superAdminUser.userId),
    cleanupTestUser(generalUser.userId),
  ]);
}, 30000);

describe('GET /api/admin/finance/dashboard', () => {
  it('200 for finance role', async () => {
    const res = await apiCall('GET', '/api/admin/finance/dashboard', financeUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');

    const data = (res.body as { data: Record<string, unknown> }).data;
    // Validate response shape
    expect(data).toHaveProperty('current_mrr_jpy');
    expect(data).toHaveProperty('current_arr_jpy');
    expect(data).toHaveProperty('churn_rate');
  });

  it('200 for admin role', async () => {
    const res = await apiCall('GET', '/api/admin/finance/dashboard', adminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('200 for super_admin role', async () => {
    const res = await apiCall('GET', '/api/admin/finance/dashboard', superAdminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/admin/finance/dashboard', generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/admin/finance/dashboard');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/finance/revenue', () => {
  it('200 for finance role with JSON structure validation', async () => {
    const res = await apiCall('GET', '/api/admin/finance/revenue', financeUser.jwt);
    expect(res.status).toBe(200);

    const body = res.body as {
      data: unknown[];
      meta: {
        total: number;
        page: number;
        per_page: number;
        summary: {
          avg_mrr_jpy: number;
          latest_mrr_jpy: number;
          latest_arr_jpy: number;
        };
      };
    };

    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(body.meta).toHaveProperty('total');
    expect(body.meta).toHaveProperty('page');
    expect(body.meta).toHaveProperty('per_page');
    expect(body.meta).toHaveProperty('summary');
    expect(body.meta.summary).toHaveProperty('avg_mrr_jpy');
    expect(body.meta.summary).toHaveProperty('latest_mrr_jpy');
    expect(body.meta.summary).toHaveProperty('latest_arr_jpy');
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('200 for admin role', async () => {
    const res = await apiCall('GET', '/api/admin/finance/revenue', adminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/admin/finance/revenue', generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/admin/finance/revenue');
    expect(res.status).toBe(401);
  });
});
