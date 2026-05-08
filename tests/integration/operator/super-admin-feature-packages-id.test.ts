/**
 * Integration tests:
 *   GET    /api/super-admin/feature-packages/[id]
 *   PATCH  /api/super-admin/feature-packages/[id]
 *   DELETE /api/super-admin/feature-packages/[id]
 *
 * Roles: super_admin only
 * Auth boundary: 403 (admin), 401 (no auth), 400/404 (validation)
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

/** Package created in beforeAll — used for GET and PATCH tests */
let testPackageId: string;
/** Separate package created for DELETE tests so GET/PATCH still work */
let deletablePackageId: string;

beforeAll(async () => {
  [superAdminUser, adminUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('fpkg-id-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('fpkg-id-admin', TS), roles: ['admin'] }),
  ]);

  // Create a feature package for GET / PATCH
  const { data: pkg } = await supabaseAdmin
    .from('feature_packages')
    .insert({
      package_key: `test_pkg_id_${TS}`,
      display_name: `ID Test Package ${TS}`,
      description: 'Integration test feature package',
      feature_flags: ['test_flag_a', 'test_flag_b'],
      display_order: 99,
      status: 'active',
    })
    .select('id')
    .single();

  if (pkg) {
    testPackageId = pkg.id;
  }

  // Create a separate package for DELETE tests
  const { data: del } = await supabaseAdmin
    .from('feature_packages')
    .insert({
      package_key: `test_del_pkg_${TS}`,
      display_name: `Delete Test Package ${TS}`,
      feature_flags: [],
      display_order: 100,
      status: 'active',
    })
    .select('id')
    .single();

  if (del) {
    deletablePackageId = del.id;
  }
}, 60000);

afterAll(async () => {
  if (testPackageId) {
    await supabaseAdmin.from('feature_packages').delete().eq('id', testPackageId);
  }
  if (deletablePackageId) {
    await supabaseAdmin.from('feature_packages').delete().eq('id', deletablePackageId);
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
// GET /api/super-admin/feature-packages/[id]
// ─────────────────────────────────────────

describe('GET /api/super-admin/feature-packages/[id]', () => {
  it('200 for super_admin fetching package detail', async () => {
    if (!testPackageId) {
      console.warn('Skipping — package creation failed');
      return;
    }
    const res = await apiCall(
      'GET',
      `/api/super-admin/feature-packages/${testPackageId}`,
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: { id: string; package_key: string; feature_flags: string[] } };
    expect(body.data.id).toBe(testPackageId);
    expect(Array.isArray(body.data.feature_flags)).toBe(true);
  });

  it('403 for admin', async () => {
    const id = testPackageId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall('GET', `/api/super-admin/feature-packages/${id}`, adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const id = testPackageId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth('GET', `/api/super-admin/feature-packages/${id}`);
    expect(res.status).toBe(401);
  });

  it('404 for non-existent package', async () => {
    const res = await apiCall(
      'GET',
      '/api/super-admin/feature-packages/00000000-0000-0000-0000-000000000000',
      superAdminUser.jwt
    );
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────
// PATCH /api/super-admin/feature-packages/[id]
// ─────────────────────────────────────────

describe('PATCH /api/super-admin/feature-packages/[id]', () => {
  it('200 for super_admin updating package', async () => {
    if (!testPackageId) {
      console.warn('Skipping — package creation failed');
      return;
    }
    const newName = `Updated Package ${TS}`;
    const res = await apiCall(
      'PATCH',
      `/api/super-admin/feature-packages/${testPackageId}`,
      superAdminUser.jwt,
      {
        display_name: newName,
        description: 'Updated by integration test',
        feature_flags: ['test_flag_a', 'test_flag_b', 'test_flag_c'],
      }
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: { id: string; display_name: string; feature_flags: string[] } };
    expect(body.data.id).toBe(testPackageId);
    expect(body.data.display_name).toBe(newName);
    expect(body.data.feature_flags).toContain('test_flag_c');
  });

  it('403 for admin', async () => {
    const id = testPackageId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall(
      'PATCH',
      `/api/super-admin/feature-packages/${id}`,
      adminUser.jwt,
      { display_name: 'Admin cannot update' }
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const id = testPackageId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth(
      'PATCH',
      `/api/super-admin/feature-packages/${id}`,
      { display_name: 'No auth update' }
    );
    expect(res.status).toBe(401);
  });

  it('400 for invalid status value', async () => {
    const id = testPackageId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall(
      'PATCH',
      `/api/super-admin/feature-packages/${id}`,
      superAdminUser.jwt,
      { status: 'invalid_status_value' }
    );
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────
// DELETE /api/super-admin/feature-packages/[id]
// ─────────────────────────────────────────

describe('DELETE /api/super-admin/feature-packages/[id]', () => {
  it('403 for admin', async () => {
    const id = deletablePackageId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCall('DELETE', `/api/super-admin/feature-packages/${id}`, adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const id = deletablePackageId ?? '00000000-0000-0000-0000-000000000000';
    const res = await apiCallNoAuth('DELETE', `/api/super-admin/feature-packages/${id}`);
    expect(res.status).toBe(401);
  });

  it('404 for non-existent package', async () => {
    const res = await apiCall(
      'DELETE',
      '/api/super-admin/feature-packages/00000000-0000-0000-0000-000000000000',
      superAdminUser.jwt
    );
    expect(res.status).toBe(404);
  });

  it('204 for super_admin deleting package', async () => {
    if (!deletablePackageId) {
      console.warn('Skipping — package creation failed');
      return;
    }
    const res = await apiCall(
      'DELETE',
      `/api/super-admin/feature-packages/${deletablePackageId}`,
      superAdminUser.jwt
    );
    expect(res.status).toBe(204);
    deletablePackageId = '';
  });
});
