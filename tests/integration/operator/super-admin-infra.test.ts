/**
 * Integration tests:
 *   GET /api/super-admin/infra/metrics
 *   GET /api/super-admin/infra/alerts
 *
 * Roles: super_admin only
 * Auth boundary: 403 (admin), 401 (no auth), 400 (invalid query)
 *
 * インフラ監視 (infra_alerts / infra_metrics) は、書き込む処理 (監視データの収集) がまだ無く、本番では常に空 (#1180)。
 * 画面は空を「問題なし」ではなく「未接続」と表示する。アラート API は、環境変数 (SENTRY_DSN / BETTER_STACK_TOKEN) の
 * 有無から作っていた Sentry / Better Stack の接続状態 (external_sources) を返さない
 * (どちらもリポジトリのどこにも使われておらず、環境変数があっても接続されていないため)。
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
    createTestUserWithRoles({ email: testEmail('infra-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('infra-admin', TS), roles: ['admin'] }),
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
// GET /api/super-admin/infra/metrics
// ─────────────────────────────────────────

describe('GET /api/super-admin/infra/metrics', () => {
  it('200 for super_admin fetching infra metrics', async () => {
    const res = await apiCall('GET', '/api/super-admin/infra/metrics', superAdminUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; meta: { count: number } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toHaveProperty('count');
  });

  it('200 with query filters (metric_name, limit)', async () => {
    const res = await apiCall(
      'GET',
      '/api/super-admin/infra/metrics?metric_name=cpu_usage&limit=10',
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; meta: { count: number } };
    expect(Array.isArray(body.data)).toBe(true);
    // Filtered result should have <= 10 entries
    expect(body.data.length).toBeLessThanOrEqual(10);
  });

  it('403 for admin', async () => {
    const res = await apiCall('GET', '/api/super-admin/infra/metrics', adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/super-admin/infra/metrics');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// GET /api/super-admin/infra/alerts
// ─────────────────────────────────────────

describe('GET /api/super-admin/infra/alerts', () => {
  it('200 for super_admin fetching infra alerts', async () => {
    const res = await apiCall('GET', '/api/super-admin/infra/alerts', superAdminUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as {
      data: unknown[];
      meta: { total: number; page: number; per_page: number };
      external_sources?: unknown;
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toHaveProperty('total');
    expect(body.meta).toHaveProperty('page');
    expect(body.meta).toHaveProperty('per_page');
    // Sentry / Better Stack の接続状態は返さない
    expect(body.external_sources).toBeUndefined();
  });

  it('200 with resolved filter', async () => {
    const res = await apiCall(
      'GET',
      '/api/super-admin/infra/alerts?resolved=false&page=1&per_page=10',
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('403 for admin', async () => {
    const res = await apiCall('GET', '/api/super-admin/infra/alerts', adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/super-admin/infra/alerts');
    expect(res.status).toBe(401);
  });
});
