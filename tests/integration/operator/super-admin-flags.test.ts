/**
 * Integration tests:
 *   GET  /api/super-admin/flags
 *   POST /api/super-admin/flags
 *   PATCH  /api/super-admin/flags/[key]
 *   DELETE /api/super-admin/flags/[key]
 *
 * Roles: super_admin only
 * Auth boundary: 403 (admin), 401 (no auth), 400/409 (validation)
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

/** Flag key created via POST and used in PATCH/DELETE tests */
const testFlagKey = `integration_test_flag_${TS}`;

beforeAll(async () => {
  [superAdminUser, adminUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('flags-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('flags-admin', TS), roles: ['admin'] }),
  ]);
}, 60000);

afterAll(async () => {
  // Remove the flag from 'basic' feature package if it was added
  const { data: basicPkg } = await supabaseAdmin
    .from('feature_packages')
    .select('id, feature_flags')
    .eq('package_key', 'basic')
    .single();

  if (basicPkg) {
    const flags = (basicPkg.feature_flags as string[]) ?? [];
    if (flags.includes(testFlagKey)) {
      await supabaseAdmin
        .from('feature_packages')
        .update({ feature_flags: flags.filter((f) => f !== testFlagKey) })
        .eq('id', basicPkg.id);
    }
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
// GET /api/super-admin/flags
// ─────────────────────────────────────────

describe('GET /api/super-admin/flags', () => {
  it('200 for super_admin with data and meta', async () => {
    const res = await apiCall('GET', '/api/super-admin/flags', superAdminUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; meta: { total: number } };
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.meta.total).toBe('number');
  });

  it('403 for admin', async () => {
    const res = await apiCall('GET', '/api/super-admin/flags', adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/super-admin/flags');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// POST /api/super-admin/flags
// ─────────────────────────────────────────

describe('POST /api/super-admin/flags', () => {
  it('201 for super_admin creating a feature flag', async () => {
    const res = await apiCall('POST', '/api/super-admin/flags', superAdminUser.jwt, {
      key: testFlagKey,
      description: 'Integration test flag',
      enabled: false,
    });
    expect(res.status).toBe(201);
    const body = res.body as { data: { key: string; enabled: boolean } };
    expect(body.data.key).toBe(testFlagKey);
    expect(body.data.enabled).toBe(false);
  });

  it('409 for duplicate flag key', async () => {
    const res = await apiCall('POST', '/api/super-admin/flags', superAdminUser.jwt, {
      key: testFlagKey,
      description: 'Duplicate flag',
      enabled: true,
    });
    expect(res.status).toBe(409);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('OP_FEATURE_FLAG_IN_USE');
  });

  it('400 for invalid key (uppercase / special chars)', async () => {
    const res = await apiCall('POST', '/api/super-admin/flags', superAdminUser.jwt, {
      key: 'INVALID-KEY!',
      description: 'Should fail',
      enabled: true,
    });
    expect(res.status).toBe(400);
  });

  it('403 for admin', async () => {
    const res = await apiCall('POST', '/api/super-admin/flags', adminUser.jwt, {
      key: `admin_flag_${TS}`,
      description: 'Admin should fail',
      enabled: false,
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('POST', '/api/super-admin/flags', {
      key: `noauth_flag_${TS}`,
      description: 'No auth flag',
      enabled: false,
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// PATCH /api/super-admin/flags/[key]
// ─────────────────────────────────────────

describe('PATCH /api/super-admin/flags/[key]', () => {
  it('200 for super_admin updating a feature flag', async () => {
    const res = await apiCall(
      'PATCH',
      `/api/super-admin/flags/${testFlagKey}`,
      superAdminUser.jwt,
      { enabled: true, description: 'Updated description' }
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: { key: string; enabled: boolean } };
    expect(body.data.key).toBe(testFlagKey);
    expect(body.data.enabled).toBe(true);
  });

  it('403 for admin', async () => {
    const res = await apiCall(
      'PATCH',
      `/api/super-admin/flags/${testFlagKey}`,
      adminUser.jwt,
      { enabled: false }
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth(
      'PATCH',
      `/api/super-admin/flags/${testFlagKey}`,
      { enabled: false }
    );
    expect(res.status).toBe(401);
  });

  it('400 for invalid body (bad rollout_strategy type)', async () => {
    const res = await apiCall(
      'PATCH',
      `/api/super-admin/flags/${testFlagKey}`,
      superAdminUser.jwt,
      { rollout_strategy: { type: 'invalid_type' } }
    );
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────
// DELETE /api/super-admin/flags/[key]
// ─────────────────────────────────────────

describe('DELETE /api/super-admin/flags/[key]', () => {
  /** A standalone flag key that is not in any feature_package — so DELETE succeeds */
  const orphanFlagKey = `orphan_flag_${TS}`;

  it('403 for admin', async () => {
    const res = await apiCall(
      'DELETE',
      `/api/super-admin/flags/${testFlagKey}`,
      adminUser.jwt
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('DELETE', `/api/super-admin/flags/${testFlagKey}`);
    expect(res.status).toBe(401);
  });

  it('409 for flag that is still in use by a feature_package', async () => {
    // testFlagKey was added to 'basic' package via POST — so DELETE should return 409
    const res = await apiCall(
      'DELETE',
      `/api/super-admin/flags/${testFlagKey}`,
      superAdminUser.jwt
    );
    expect(res.status).toBe(409);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('OP_FEATURE_FLAG_IN_USE');
  });

  it('200 for super_admin deleting an orphan flag key (not in any package)', async () => {
    // The DELETE route checks feature_packages for the key — orphanFlagKey has never been inserted
    const res = await apiCall(
      'DELETE',
      `/api/super-admin/flags/${orphanFlagKey}`,
      superAdminUser.jwt
    );
    // The route does NOT check if the flag exists; it just confirms it is not in any package
    // and returns 200 with deleted:true
    expect(res.status).toBe(200);
    const body = res.body as { data: { key: string; deleted: boolean } };
    expect(body.data.key).toBe(orphanFlagKey);
    expect(body.data.deleted).toBe(true);
  });
});
