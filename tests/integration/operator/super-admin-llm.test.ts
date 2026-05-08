/**
 * Integration tests:
 *   GET   /api/super-admin/llm/usage
 *   GET   /api/super-admin/llm/quotas
 *   PATCH /api/super-admin/llm/quotas
 *
 * Roles: super_admin only
 * Auth boundary: 403 (admin), 401 (no auth), 400 (validation)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUserWithRoles,
  cleanupTestUser,
  cleanupAuditLogs,
  testEmail,
  type TestUser,
} from '../helpers/users';
import { apiCall, apiCallNoAuth } from '../helpers/api';

const TS = Date.now();

let superAdminUser: TestUser;
let adminUser: TestUser;

beforeAll(async () => {
  [superAdminUser, adminUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('llm-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('llm-admin', TS), roles: ['admin'] }),
  ]);
}, 60000);

afterAll(async () => {
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
// GET /api/super-admin/llm/usage
// ─────────────────────────────────────────

describe('GET /api/super-admin/llm/usage', () => {
  it('200 for super_admin fetching LLM usage summary', async () => {
    const res = await apiCall('GET', '/api/super-admin/llm/usage?period=7d', superAdminUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as {
      data: {
        total_cost_usd: number;
        total_cost_jpy: number;
        total_requests: number;
        total_tokens: number;
        by_model: unknown[];
        by_function: unknown[];
        top_users: unknown[];
        timeseries: unknown[];
        period: { from: string; to: string };
      };
    };
    expect(body.data).toHaveProperty('total_cost_usd');
    expect(body.data).toHaveProperty('total_cost_jpy');
    expect(body.data).toHaveProperty('total_requests');
    expect(body.data).toHaveProperty('total_tokens');
    expect(Array.isArray(body.data.by_model)).toBe(true);
    expect(Array.isArray(body.data.by_function)).toBe(true);
    expect(Array.isArray(body.data.top_users)).toBe(true);
    expect(Array.isArray(body.data.timeseries)).toBe(true);
    expect(body.data.period).toHaveProperty('from');
    expect(body.data.period).toHaveProperty('to');
  });

  it('200 with custom period range', async () => {
    const res = await apiCall(
      'GET',
      '/api/super-admin/llm/usage?period=custom&from=2026-05-01&to=2026-05-08',
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);
  });

  it('200 with model filter', async () => {
    const res = await apiCall(
      'GET',
      '/api/super-admin/llm/usage?period=30d&model=gpt-4o',
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);
  });

  it('403 for admin', async () => {
    const res = await apiCall('GET', '/api/super-admin/llm/usage', adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/super-admin/llm/usage');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// GET /api/super-admin/llm/quotas
// ─────────────────────────────────────────

describe('GET /api/super-admin/llm/quotas', () => {
  it('200 for super_admin fetching quota list', async () => {
    const res = await apiCall('GET', '/api/super-admin/llm/quotas', superAdminUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as {
      data: Array<{ plan_key: string; daily_limit: number | null; monthly_limit: number | null }>;
    };
    expect(Array.isArray(body.data)).toBe(true);
    // Verify at least one canonical plan key is present
    const planKeys = body.data.map((q) => q.plan_key);
    expect(planKeys).toContain('free');
  });

  it('403 for admin', async () => {
    const res = await apiCall('GET', '/api/super-admin/llm/quotas', adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/super-admin/llm/quotas');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// PATCH /api/super-admin/llm/quotas
// ─────────────────────────────────────────

describe('PATCH /api/super-admin/llm/quotas', () => {
  /** UUID used as target_id for user-level quota override */
  const testTargetId = '00000000-0000-0000-0000-000000000001';

  it('200 for super_admin overriding user quota', async () => {
    const res = await apiCall('PATCH', '/api/super-admin/llm/quotas', superAdminUser.jwt, {
      target_type: 'user',
      target_id: testTargetId,
      daily_limit: 200,
      monthly_limit: 5000,
      reason: 'Integration test quota override',
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      data: { target_type: string; target_id: string; daily_limit: number; updated_by: string };
    };
    expect(body.data.target_type).toBe('user');
    expect(body.data.target_id).toBe(testTargetId);
    expect(body.data.daily_limit).toBe(200);
    expect(body.data.updated_by).toBe(superAdminUser.userId);
  });

  it('400 for missing reason field', async () => {
    const res = await apiCall('PATCH', '/api/super-admin/llm/quotas', superAdminUser.jwt, {
      target_type: 'user',
      target_id: testTargetId,
      daily_limit: 100,
      // reason is required
    });
    expect(res.status).toBe(400);
  });

  it('400 for invalid target_type', async () => {
    const res = await apiCall('PATCH', '/api/super-admin/llm/quotas', superAdminUser.jwt, {
      target_type: 'invalid_type',
      target_id: testTargetId,
      daily_limit: 100,
      reason: 'Should fail',
    });
    expect(res.status).toBe(400);
  });

  it('403 for admin', async () => {
    const res = await apiCall('PATCH', '/api/super-admin/llm/quotas', adminUser.jwt, {
      target_type: 'user',
      target_id: testTargetId,
      daily_limit: 100,
      reason: 'Admin should fail',
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('PATCH', '/api/super-admin/llm/quotas', {
      target_type: 'user',
      target_id: testTargetId,
      daily_limit: 100,
      reason: 'No auth',
    });
    expect(res.status).toBe(401);
  });
});
