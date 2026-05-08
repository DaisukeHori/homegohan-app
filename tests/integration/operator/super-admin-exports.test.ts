/**
 * Integration tests:
 *   GET    /api/super-admin/exports
 *   POST   /api/super-admin/exports
 *   GET    /api/super-admin/exports/[id]
 *   DELETE /api/super-admin/exports/[id]
 *
 * Roles: super_admin only
 * Auth boundary: 403 (admin), 401 (no auth), 400/422 (validation)
 *
 * Note: The exports API uses gdpr_deletion_requests as storage (per route comment).
 *       It degrades gracefully if the table is missing.
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

/** Export ID created via POST — used for GET/DELETE tests */
let testExportId: string;

beforeAll(async () => {
  [superAdminUser, adminUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('exports-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('exports-admin', TS), roles: ['admin'] }),
  ]);
}, 60000);

afterAll(async () => {
  if (testExportId) {
    // Cancel/delete the export record created in tests
    await supabaseAdmin
      .from('gdpr_deletion_requests')
      .delete()
      .eq('id', testExportId);
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
// GET /api/super-admin/exports
// ─────────────────────────────────────────

describe('GET /api/super-admin/exports', () => {
  it('200 for super_admin listing exports', async () => {
    const res = await apiCall('GET', '/api/super-admin/exports', superAdminUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; meta: { total: number; page: number; per_page: number } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toHaveProperty('total');
    expect(body.meta).toHaveProperty('page');
    expect(body.meta).toHaveProperty('per_page');
  });

  it('403 for admin', async () => {
    const res = await apiCall('GET', '/api/super-admin/exports', adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/super-admin/exports');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// POST /api/super-admin/exports
// ─────────────────────────────────────────

describe('POST /api/super-admin/exports', () => {
  it('201 for super_admin creating an export request', async () => {
    const res = await apiCall('POST', '/api/super-admin/exports', superAdminUser.jwt, {
      export_type: 'audit_logs',
      format: 'csv',
      filters: {
        from: '2026-01-01',
        to: '2026-05-08',
      },
      mask_pii: true,
    });
    expect(res.status).toBe(201);
    const body = res.body as { data: { export_id: string; status: string; export_type: string } };
    expect(body.data).toHaveProperty('export_id');
    expect(body.data.status).toBe('processing');
    expect(body.data.export_type).toBe('audit_logs');
    testExportId = body.data.export_id;
  });

  it('400 for invalid export_type', async () => {
    const res = await apiCall('POST', '/api/super-admin/exports', superAdminUser.jwt, {
      export_type: 'invalid_type',
      format: 'csv',
    });
    expect(res.status).toBe(400);
  });

  it('403 for admin', async () => {
    const res = await apiCall('POST', '/api/super-admin/exports', adminUser.jwt, {
      export_type: 'user_data',
      format: 'csv',
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('POST', '/api/super-admin/exports', {
      export_type: 'user_data',
      format: 'csv',
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// GET /api/super-admin/exports/[id]
// ─────────────────────────────────────────

describe('GET /api/super-admin/exports/[id]', () => {
  it('200 for super_admin fetching export status', async () => {
    if (!testExportId) {
      console.warn('Skipping — export creation failed');
      return;
    }
    const res = await apiCall(
      'GET',
      `/api/super-admin/exports/${testExportId}`,
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: { id: string; export_type: string; status: string } };
    expect(body.data.id).toBe(testExportId);
    expect(body.data).toHaveProperty('export_type');
    expect(body.data).toHaveProperty('status');
  });

  it('403 for admin', async () => {
    const id = testExportId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall('GET', `/api/super-admin/exports/${id}`, adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const id = testExportId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth('GET', `/api/super-admin/exports/${id}`);
    expect(res.status).toBe(401);
  });

  it('404 for non-existent export', async () => {
    const res = await apiCall(
      'GET',
      '/api/super-admin/exports/00000000-0000-0000-0000-000000000000',
      superAdminUser.jwt
    );
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────
// DELETE /api/super-admin/exports/[id]
// ─────────────────────────────────────────

describe('DELETE /api/super-admin/exports/[id]', () => {
  it('403 for admin', async () => {
    const id = testExportId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall('DELETE', `/api/super-admin/exports/${id}`, adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const id = testExportId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth('DELETE', `/api/super-admin/exports/${id}`);
    expect(res.status).toBe(401);
  });

  it('404 for non-existent export', async () => {
    const res = await apiCall(
      'DELETE',
      '/api/super-admin/exports/00000000-0000-0000-0000-000000000000',
      superAdminUser.jwt
    );
    expect(res.status).toBe(404);
  });

  it('200 for super_admin cancelling a pending export', async () => {
    if (!testExportId) {
      console.warn('Skipping — export creation failed');
      return;
    }
    const res = await apiCall(
      'DELETE',
      `/api/super-admin/exports/${testExportId}`,
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: { id: string; deleted: boolean } };
    expect(body.data.id).toBe(testExportId);
    expect(body.data.deleted).toBe(true);
    // Mark as cleaned up
    testExportId = '';
  });
});
