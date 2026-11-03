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
import { NEW_FLAG_DEFAULT_PACKAGE_KEY } from '@/lib/super-admin/feature-package-flag-append';

const TS = Date.now();

let superAdminUser: TestUser;
let adminUser: TestUser;

/** Flag key created via POST and used in PATCH/DELETE tests */
const testFlagKey = `integration_test_flag_${TS}`;
/** #2189 W4: 運営最上位 2 人がほぼ同時に作るフラグのキー (どちらも basic のパッケージに残ること) */
const concurrentFlagKeys = [`integration_w4_flag_a_${TS}`, `integration_w4_flag_b_${TS}`] as const;
/** このファイルが作るフラグのキー (後片付けで basic のパッケージと feature_flags から消す) */
const createdFlagKeys: readonly string[] = [testFlagKey, ...concurrentFlagKeys];

/** basic のパッケージのフラグキーの一覧を読む */
async function basicPackageFlags(): Promise<{ id: string; flags: string[] } | null> {
  const { data } = await supabaseAdmin
    .from('feature_packages')
    .select('id, feature_flags')
    .eq('package_key', NEW_FLAG_DEFAULT_PACKAGE_KEY)
    .single();
  return data ? { id: data.id as string, flags: (data.feature_flags as string[]) ?? [] } : null;
}

beforeAll(async () => {
  [superAdminUser, adminUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('flags-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('flags-admin', TS), roles: ['admin'] }),
  ]);
}, 60000);

afterAll(async () => {
  // Remove the flags from 'basic' feature package if they were added
  // (結合テストはファイルを 1 本ずつ流す (vitest.integration.config.ts の maxWorkers: 1) ので、ここで読んでから書いても他のファイルと重ならない)
  const basicPkg = await basicPackageFlags();
  if (basicPkg && basicPkg.flags.some((f) => createdFlagKeys.includes(f))) {
    await supabaseAdmin
      .from('feature_packages')
      .update({ feature_flags: basicPkg.flags.filter((f) => !createdFlagKeys.includes(f)) })
      .eq('id', basicPkg.id);
  }

  // #1029: feature_flags テーブルの実データも掃除する (DELETE テストは 409 で
  // ブロックされるため testFlagKey の行が残ったままになる)
  await supabaseAdmin.from('feature_flags').delete().in('key', [...createdFlagKeys]);

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

  // #2189 W4: 以前は basic の feature_flags を読んでから [...読んだ値, key] で書いており、2 本が重なると後から書いた方の一覧だけが残った。
  // いまは DB の関数 1 本 (1 文の条件つき UPDATE) で足すので、同時に作っても両方のキーが残る
  // (重なりを決まった順で再現する確認は tests/integration/rls/feature-packages-append-flag-rpc.test.ts の I-4)
  it('201 for two flags created at the same time — both keys stay in the basic package (#2189 W4)', async () => {
    const responses = await Promise.all(
      concurrentFlagKeys.map((key) =>
        apiCall('POST', '/api/super-admin/flags', superAdminUser.jwt, { key, description: 'W4 concurrent flag', enabled: false }),
      ),
    );
    for (const res of responses) expect(res.status).toBe(201);
    const basicPkg = await basicPackageFlags();
    expect(basicPkg, 'basic のパッケージが無い').not.toBeNull();
    for (const key of concurrentFlagKeys) {
      expect(basicPkg!.flags.filter((f) => f === key), key).toHaveLength(1);
    }
    expect(basicPkg!.flags).toContain(testFlagKey);
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

  it('404 for a flag key that does not exist in feature_flags', async () => {
    const res = await apiCall(
      'PATCH',
      `/api/super-admin/flags/nonexistent_flag_${TS}`,
      superAdminUser.jwt,
      { enabled: true }
    );
    expect(res.status).toBe(404);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('OP_FEATURE_FLAG_NOT_FOUND');
  });

  // #1029: PATCH で保存した enabled 状態が実際に永続化され、GET で読み返せることを検証する
  // (修正前は PATCH が監査ログを INSERT するだけの no-op で、GET は enabled:true を
  // ハードコードして返していた)
  it('persists enabled=false — a subsequent GET reflects the PATCH', async () => {
    const patchRes = await apiCall(
      'PATCH',
      `/api/super-admin/flags/${testFlagKey}`,
      superAdminUser.jwt,
      { enabled: false }
    );
    expect(patchRes.status).toBe(200);
    const patchBody = patchRes.body as { data: { key: string; enabled: boolean } };
    expect(patchBody.data.enabled).toBe(false);

    const getRes = await apiCall('GET', '/api/super-admin/flags', superAdminUser.jwt);
    expect(getRes.status).toBe(200);
    const getBody = getRes.body as { data: Array<{ key: string; enabled: boolean }> };
    const persisted = getBody.data.find((f) => f.key === testFlagKey);
    expect(persisted).toBeDefined();
    expect(persisted?.enabled).toBe(false);
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
    // orphanFlagKey was never created via POST, so it has no row in feature_flags and is
    // not referenced by any feature_packages.feature_flags array. The DELETE FROM feature_flags
    // affects 0 rows (no error) — the route still returns 200 with deleted:true (idempotent).
    const res = await apiCall(
      'DELETE',
      `/api/super-admin/flags/${orphanFlagKey}`,
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: { key: string; deleted: boolean } };
    expect(body.data.key).toBe(orphanFlagKey);
    expect(body.data.deleted).toBe(true);
  });
});
