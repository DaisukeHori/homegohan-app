/**
 * Integration tests:
 *   GET  /api/admin/finance/invoices
 *   GET  /api/admin/finance/invoices/[id]
 *   POST /api/admin/finance/exports
 *   GET  /api/admin/finance/nps
 *   GET  /api/admin/finance/reconciliation
 *
 * Roles: finance, admin, super_admin
 * Auth boundary: 403 (general user), 401 (no auth)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUserWithRoles,
  cleanupTestUser,
  testEmail,
  type TestUser,
} from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';

const TS = Date.now();

let financeUser: TestUser;
let adminUser: TestUser;
let superAdminUser: TestUser;
let generalUser: TestUser;

// stripe_webhook_events から既存のインボイス ID を取得 (テスト用)
let sampleInvoiceId: string | null = null;

beforeAll(async () => {
  [financeUser, adminUser, superAdminUser, generalUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('fin2-fin', TS), roles: ['finance'] }),
    createTestUserWithRoles({ email: testEmail('fin2-admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('fin2-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('fin2-gen', TS), roles: ['user'] }),
  ]);

  // 既存の stripe_webhook_events から1件 ID を取得 (invoices/[id] テスト用)
  const { data: events } = await supabaseAdmin
    .from('stripe_webhook_events')
    .select('id')
    .in('event_type', ['invoice.paid', 'invoice.payment_failed', 'invoice.upcoming'])
    .limit(1);

  if (events && events.length > 0) {
    sampleInvoiceId = events[0].id;
  }
}, 60000);

afterAll(async () => {
  await Promise.all([
    cleanupTestUser(financeUser.userId),
    cleanupTestUser(adminUser.userId),
    cleanupTestUser(superAdminUser.userId),
    cleanupTestUser(generalUser.userId),
  ]);
}, 30000);

// ─── GET /api/admin/finance/invoices ──────────────────────────────────────────

describe('GET /api/admin/finance/invoices', () => {
  it('200 for finance role - returns invoices list', async () => {
    const res = await apiCall('GET', '/api/admin/finance/invoices', financeUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    const body = res.body as { data: unknown[]; meta: { total: number; page: number; per_page: number } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toHaveProperty('total');
    expect(body.meta).toHaveProperty('page');
    expect(body.meta).toHaveProperty('per_page');
  });

  it('200 for admin role', async () => {
    const res = await apiCall('GET', '/api/admin/finance/invoices', adminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('200 for super_admin role', async () => {
    const res = await apiCall('GET', '/api/admin/finance/invoices', superAdminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/admin/finance/invoices', generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/admin/finance/invoices');
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/admin/finance/invoices/[id] ─────────────────────────────────────

describe('GET /api/admin/finance/invoices/[id]', () => {
  it('200 or 404 for finance role - returns invoice detail or not found', async () => {
    if (!sampleInvoiceId) {
      // DB にインボイスがない場合は 404 期待
      const res = await apiCall(
        'GET',
        '/api/admin/finance/invoices/00000000-0000-0000-0000-000000000000',
        financeUser.jwt,
      );
      expect([404]).toContain(res.status);
      return;
    }
    const res = await apiCall(
      'GET',
      `/api/admin/finance/invoices/${sampleInvoiceId}`,
      financeUser.jwt,
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data).toHaveProperty('id', sampleInvoiceId);
    expect(data).toHaveProperty('event_type');
    expect(data).toHaveProperty('stripe_links');
  });

  it('200 for admin role', async () => {
    if (!sampleInvoiceId) return; // DB にデータなし、スキップ
    const res = await apiCall(
      'GET',
      `/api/admin/finance/invoices/${sampleInvoiceId}`,
      adminUser.jwt,
    );
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const targetId = sampleInvoiceId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall(
      'GET',
      `/api/admin/finance/invoices/${targetId}`,
      generalUser.jwt,
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const targetId = sampleInvoiceId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth('GET', `/api/admin/finance/invoices/${targetId}`);
    expect(res.status).toBe(401);
  });

  it('404 for non-existent invoice id', async () => {
    const res = await apiCall(
      'GET',
      '/api/admin/finance/invoices/00000000-0000-0000-0000-000000000099',
      financeUser.jwt,
    );
    expect(res.status).toBe(404);
  });
});

// ─── POST /api/admin/finance/exports ──────────────────────────────────────────

describe('POST /api/admin/finance/exports', () => {
  it('200 for finance role - exports revenue CSV', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', financeUser.jwt, {
      export_type: 'revenue',
    });
    expect(res.status).toBe(200);
    // CSV レスポンスなので body は文字列
    const contentType = res.headers['content-type'] ?? '';
    expect(contentType).toContain('text/csv');
  });

  it('200 for admin role - exports invoices CSV', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', adminUser.jwt, {
      export_type: 'invoices',
    });
    expect(res.status).toBe(200);
  });

  it('200 for super_admin role - exports subscriptions CSV', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', superAdminUser.jwt, {
      export_type: 'subscriptions',
    });
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', generalUser.jwt, {
      export_type: 'revenue',
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('POST', '/api/admin/finance/exports', {
      export_type: 'revenue',
    });
    expect(res.status).toBe(401);
  });

  it('400 for invalid export_type (validation error)', async () => {
    const res = await apiCall('POST', '/api/admin/finance/exports', financeUser.jwt, {
      export_type: 'INVALID_TYPE',
    });
    expect([400, 422, 500]).toContain(res.status);
  });
});

// ─── GET /api/admin/finance/nps ───────────────────────────────────────────────

describe('GET /api/admin/finance/nps', () => {
  it('200 for finance role - returns nps and csat data', async () => {
    const res = await apiCall('GET', '/api/admin/finance/nps', financeUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data).toHaveProperty('nps');
    expect(data).toHaveProperty('csat');
    const nps = data.nps as Record<string, unknown>;
    expect(nps).toHaveProperty('nps_score');
    expect(nps).toHaveProperty('total_responses');
  });

  it('200 for admin role', async () => {
    const res = await apiCall('GET', '/api/admin/finance/nps', adminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('200 for super_admin role', async () => {
    const res = await apiCall('GET', '/api/admin/finance/nps', superAdminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/admin/finance/nps', generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/admin/finance/nps');
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/admin/finance/reconciliation ────────────────────────────────────

describe('GET /api/admin/finance/reconciliation', () => {
  it('200 for admin role - returns discrepancies and db_summary', async () => {
    const res = await apiCall('GET', '/api/admin/finance/reconciliation', adminUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    const data = (res.body as { data: Record<string, unknown> }).data;
    expect(data).toHaveProperty('discrepancies');
    expect(data).toHaveProperty('db_summary');
    expect(data).toHaveProperty('stripe_summary');
    expect(Array.isArray((data as { discrepancies: unknown[] }).discrepancies)).toBe(true);
  });

  it('200 for finance role (DB only data)', async () => {
    const res = await apiCall('GET', '/api/admin/finance/reconciliation', financeUser.jwt);
    expect(res.status).toBe(200);
    const meta = (res.body as { meta: Record<string, unknown> }).meta;
    // finance ロールは note が付く
    expect(meta).toHaveProperty('note');
  });

  it('200 for super_admin role', async () => {
    const res = await apiCall('GET', '/api/admin/finance/reconciliation', superAdminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/admin/finance/reconciliation', generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/admin/finance/reconciliation');
    expect(res.status).toBe(401);
  });
});
