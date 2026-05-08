/**
 * Integration tests: GET/POST /api/super-admin/feature-packages
 * Roles: super_admin only
 * Auth boundary: 403 (admin, general), 401 (no auth)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUserWithRoles, cleanupTestUser, cleanupAuditLogs, testEmail, type TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';

const TS = Date.now();

let superAdminUser: TestUser;
let adminUser: TestUser;
let generalUser: TestUser;

const createdPackageIds: string[] = [];

beforeAll(async () => {
  [superAdminUser, adminUser, generalUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('fpkg-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('fpkg-admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('fpkg-gen', TS), roles: ['user'] }),
  ]);
}, 60000);

afterAll(async () => {
  // Cleanup created packages
  if (createdPackageIds.length > 0) {
    await supabaseAdmin.from('feature_packages').delete().in('id', createdPackageIds);
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

describe('GET /api/super-admin/feature-packages', () => {
  it('200 for super_admin', async () => {
    const res = await apiCall('GET', '/api/super-admin/feature-packages', superAdminUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(Array.isArray((res.body as { data: unknown[] }).data)).toBe(true);
  });

  it('403 for admin', async () => {
    const res = await apiCall('GET', '/api/super-admin/feature-packages', adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/super-admin/feature-packages', generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/super-admin/feature-packages');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/super-admin/feature-packages', () => {
  it('201 for super_admin creating a feature package', async () => {
    const packageKey = `test_pkg_${TS}`;

    const res = await apiCall('POST', '/api/super-admin/feature-packages', superAdminUser.jwt, {
      package_key: packageKey,
      display_name: `Integration Test Package ${TS}`,
      description: 'Created by integration test',
      feature_flags: ['ai_advisor', 'advanced_analytics'],
      display_order: 99,
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      data: { id: string; package_key: string; status: string; feature_flags: string[] };
    };
    expect(body.data).toHaveProperty('id');
    expect(body.data.package_key).toBe(packageKey);
    expect(body.data.status).toBe('active');
    expect(Array.isArray(body.data.feature_flags)).toBe(true);

    if (body.data.id) {
      createdPackageIds.push(body.data.id);
    }
  });

  it('409 for duplicate package_key', async () => {
    // Use a pre-existing or already created package_key
    if (createdPackageIds.length === 0) return;

    const { data: pkg } = await supabaseAdmin
      .from('feature_packages')
      .select('package_key')
      .eq('id', createdPackageIds[0])
      .single();

    if (!pkg) return;

    const res = await apiCall('POST', '/api/super-admin/feature-packages', superAdminUser.jwt, {
      package_key: pkg.package_key,
      display_name: 'Duplicate Package',
      feature_flags: [],
    });
    expect(res.status).toBe(409);
  });

  it('403 for admin', async () => {
    const res = await apiCall('POST', '/api/super-admin/feature-packages', adminUser.jwt, {
      package_key: `admin_cannot_${TS}`,
      display_name: 'Admin cannot create',
      feature_flags: [],
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('POST', '/api/super-admin/feature-packages', {
      package_key: 'no_auth_pkg',
      display_name: 'No auth package',
      feature_flags: [],
    });
    expect(res.status).toBe(401);
  });
});
