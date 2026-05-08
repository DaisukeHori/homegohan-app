/**
 * Integration tests: GET /api/super-admin/audit-logs
 * super_admin only — admin cannot view audit logs (by design)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUserWithRoles, cleanupTestUser, cleanupAuditLogs, testEmail, type TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';

const TS = Date.now();

let superAdminUser: TestUser;
let adminUser: TestUser;
let generalUser: TestUser;

beforeAll(async () => {
  [superAdminUser, adminUser, generalUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('audit-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('audit-admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('audit-gen', TS), roles: ['user'] }),
  ]);

  // Insert a test audit log so the list is non-empty
  await supabaseAdmin.from('admin_audit_logs').insert({
    actor_id: superAdminUser.userId,
    action_type: 'integration_test.audit_log',
    target_type: 'test',
    details: { test: true, ts: TS },
    severity: 'info',
  });
}, 60000);

afterAll(async () => {
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

describe('GET /api/super-admin/audit-logs', () => {
  it('200 for super_admin', async () => {
    const res = await apiCall('GET', '/api/super-admin/audit-logs', superAdminUser.jwt);
    expect(res.status).toBe(200);

    const body = res.body as {
      data: Array<{
        id: string;
        actor_id: string;
        action_type: string;
        severity: string;
        created_at: string;
      }>;
      meta: { total: number; page: number; per_page: number };
    };

    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toHaveProperty('total');
    expect(body.meta).toHaveProperty('page');
    expect(body.meta).toHaveProperty('per_page');
  });

  it('super_admin can filter by actor_id', async () => {
    const res = await apiCall(
      'GET',
      `/api/super-admin/audit-logs?actor_id=${superAdminUser.userId}`,
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);

    const body = res.body as {
      data: Array<{ actor_id: string }>;
    };

    // All returned logs should be from our actor
    for (const log of body.data) {
      expect(log.actor_id).toBe(superAdminUser.userId);
    }

    // Our test log should be present
    const testLog = body.data.find(
      (l) => l.actor_id === superAdminUser.userId
    );
    expect(testLog).toBeDefined();
  });

  it('403 for admin (audit-logs are super_admin only)', async () => {
    const res = await apiCall('GET', '/api/super-admin/audit-logs', adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/super-admin/audit-logs', generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/super-admin/audit-logs');
    expect(res.status).toBe(401);
  });
});
