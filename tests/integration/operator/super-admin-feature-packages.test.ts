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
    // 前のテストの結果に頼らず、重複させる元のパッケージをここで作る
    // (INSERT の error を確認しないと、元が無いまま 201 になって気づけない)
    const packageKey = `test_dup_pkg_${TS}`;
    const { data: pkg, error } = await supabaseAdmin
      .from('feature_packages')
      .insert({
        package_key: packageKey,
        display_name: `Duplicate Source Package ${TS}`,
        feature_flags: ['test_flag_a'],
        display_order: 98,
        status: 'active',
      })
      .select('id')
      .single();
    if (error || !pkg) throw new Error(`Failed to create the package to duplicate: ${error?.message}`);
    createdPackageIds.push(pkg.id);

    // feature_flags は 1 つ以上が必要 (空配列だと 409 の前に 400 になる)
    const res = await apiCall('POST', '/api/super-admin/feature-packages', superAdminUser.jwt, {
      package_key: packageKey,
      display_name: 'Duplicate Package',
      feature_flags: ['test_flag_a'],
    });
    expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('OP_PACKAGE_KEY_DUPLICATE');
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
