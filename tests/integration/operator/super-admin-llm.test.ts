/**
 * Integration tests:
 *   GET   /api/super-admin/llm/usage
 *   GET   /api/super-admin/llm/quotas
 *   PATCH /api/super-admin/llm/quotas
 *
 * Roles: super_admin only
 * Auth boundary: 403 (admin), 401 (no auth)
 *
 * クォータ管理は準備中 (未対応) (#1149)。
 *   - GET は目安の値を返す。応答の enforced: false が「AI の呼び出しには適用されていない」ことを表す
 *   - PATCH は 501 OP_NOT_SUPPORTED。何も保存せず、監査ログ (super_admin.llm_quota.override) も残さない
 *     (以前は、値を保存せずに監査ログだけを残して、受け取った値をそのまま返していた)
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
      enforced: boolean;
      note: string;
    };
    expect(Array.isArray(body.data)).toBe(true);
    // Verify at least one canonical plan key is present
    const planKeys = body.data.map((q) => q.plan_key);
    expect(planKeys).toContain('free');
    // 目安の値で、AI の呼び出しには適用されていない
    expect(body.enforced).toBe(false);
    expect(body.note).toContain('適用されておらず');
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
  const validBody = {
    target_type: 'user',
    target_id: testTargetId,
    daily_limit: 200,
    monthly_limit: 5000,
    reason: 'Integration test quota override',
  };

  it('501 OP_NOT_SUPPORTED for super_admin (nothing is saved, so no success-looking response)', async () => {
    const res = await apiCall('PATCH', '/api/super-admin/llm/quotas', superAdminUser.jwt, validBody);
    expect(res.status).toBe(501);
    const body = res.body as { error?: { code?: string; message?: string }; data?: unknown };
    expect(body.error?.code).toBe('OP_NOT_SUPPORTED');
    expect(body.error?.message).toContain('準備中（未対応）');
    // 受け取った値をそのまま返さない
    expect(body.data).toBeUndefined();
  });

  it('does not write the super_admin.llm_quota.override audit log', async () => {
    await apiCall('PATCH', '/api/super-admin/llm/quotas', superAdminUser.jwt, validBody);

    const { count, error } = await supabaseAdmin
      .from('admin_audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('actor_id', superAdminUser.userId)
      .eq('action_type', 'super_admin.llm_quota.override');
    expect(error).toBeNull();
    expect(count).toBe(0);
  });

  it('501 for super_admin even with an invalid body (no validation: the feature itself is not supported)', async () => {
    const res = await apiCall('PATCH', '/api/super-admin/llm/quotas', superAdminUser.jwt, {
      target_type: 'invalid_type',
      target_id: testTargetId,
      daily_limit: 100,
      reason: 'Should not be validated',
    });
    expect(res.status).toBe(501);
  });

  it('403 for admin', async () => {
    const res = await apiCall('PATCH', '/api/super-admin/llm/quotas', adminUser.jwt, {
      ...validBody,
      reason: 'Admin should fail',
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('PATCH', '/api/super-admin/llm/quotas', {
      ...validBody,
      reason: 'No auth',
    });
    expect(res.status).toBe(401);
  });
});
