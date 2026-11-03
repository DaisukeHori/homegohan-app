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
  // INSERT の error は必ず確認する (作れないまま黙ってスキップさせず、このあとのテストが空振りで通るのを防ぐ)
  const { data: pkg, error: pkgError } = await supabaseAdmin
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

  if (pkgError || !pkg) throw new Error(`Failed to create the feature package: ${pkgError?.message}`);
  testPackageId = pkg.id;

  // Create a separate package for DELETE tests
  const { data: del, error: delError } = await supabaseAdmin
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

  if (delError || !del) throw new Error(`Failed to create the feature package to delete: ${delError?.message}`);
  deletablePackageId = del.id;
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
    // 機能フラグを送るときは、画面と同じく GET で読んだ updated_at を書く条件として添える (#2195 V4)
    const read = await apiCall('GET', `/api/super-admin/feature-packages/${testPackageId}`, superAdminUser.jwt);
    expect(read.status).toBe(200);
    const readUpdatedAt = (read.body as { data: { updated_at: string } }).data.updated_at;
    const res = await apiCall(
      'PATCH',
      `/api/super-admin/feature-packages/${testPackageId}`,
      superAdminUser.jwt,
      {
        display_name: newName,
        description: 'Updated by integration test',
        feature_flags: ['test_flag_a', 'test_flag_b', 'test_flag_c'],
        expected_updated_at: readUpdatedAt,
      }
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: { id: string; display_name: string; feature_flags: string[] } };
    expect(body.data.id).toBe(testPackageId);
    expect(body.data.display_name).toBe(newName);
    expect(body.data.feature_flags).toContain('test_flag_c');
  });

  // #2195 V4: 機能フラグの一覧は配列全体を書き換えるので、画面が読んだ updated_at のままのときだけ書く。
  // 以前は条件なしで書き、画面を開いたあとに機能フラグの作成 (append_flag_to_feature_package) が足したキーを古い一覧で消していた
  describe('機能フラグの一覧の楽観ロック (#2195 V4)', () => {
    const appendedFlag = `test_flag_appended_${TS}`;
    const readPackage = async () => {
      const { data, error } = await supabaseAdmin
        .from('feature_packages')
        .select('package_key, feature_flags, updated_at')
        .eq('id', testPackageId)
        .single();
      if (error) throw new Error(`Failed to read the feature package: ${error.message}`);
      return data as { package_key: string; feature_flags: string[]; updated_at: string };
    };

    it('400 OP_INVALID_INPUT when feature_flags is sent without expected_updated_at (書かない)', async () => {
      const before = await readPackage();
      const res = await apiCall(
        'PATCH',
        `/api/super-admin/feature-packages/${testPackageId}`,
        superAdminUser.jwt,
        { feature_flags: ['test_flag_a'] }
      );
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('OP_INVALID_INPUT');
      expect((await readPackage()).feature_flags).toEqual(before.feature_flags);
    });

    it('409 CONFLICT_STALE_DATA when a flag was appended after the read: 足されたキーを消さない。読み直した updated_at なら書ける', async () => {
      const read = await apiCall('GET', `/api/super-admin/feature-packages/${testPackageId}`, superAdminUser.jwt);
      expect(read.status).toBe(200);
      const opened = (read.body as { data: { package_key: string; feature_flags: string[]; updated_at: string } }).data;

      // 画面を開いたあとに、機能フラグの作成と同じ関数でキーを足す (updated_at も now() になる)
      const { data: outcome, error: rpcError } = await supabaseAdmin.rpc('append_flag_to_feature_package', {
        p_package_key: opened.package_key,
        p_flag_key: appendedFlag,
      });
      if (rpcError) throw new Error(`Failed to append the flag: ${rpcError.message}`);
      expect(outcome).toBe('added');

      const stale = await apiCall(
        'PATCH',
        `/api/super-admin/feature-packages/${testPackageId}`,
        superAdminUser.jwt,
        { feature_flags: opened.feature_flags.filter((flag) => flag !== 'test_flag_c'), expected_updated_at: opened.updated_at }
      );
      expect(stale.status).toBe(409);
      expect((stale.body as { error: { code: string } }).error.code).toBe('CONFLICT_STALE_DATA');
      const afterStale = await readPackage();
      expect(afterStale.feature_flags).toContain(appendedFlag);
      expect(afterStale.feature_flags).toContain('test_flag_c');

      // 読み直した updated_at を添えれば書ける (足されたキーを残した一覧)
      const reread = await apiCall('GET', `/api/super-admin/feature-packages/${testPackageId}`, superAdminUser.jwt);
      const latest = (reread.body as { data: { feature_flags: string[]; updated_at: string } }).data;
      const nextFlags = latest.feature_flags.filter((flag) => flag !== 'test_flag_c');
      const saved = await apiCall(
        'PATCH',
        `/api/super-admin/feature-packages/${testPackageId}`,
        superAdminUser.jwt,
        { feature_flags: nextFlags, expected_updated_at: latest.updated_at }
      );
      expect(saved.status).toBe(200);
      const savedRow = (saved.body as { data: { feature_flags: string[]; updated_at: string } }).data;
      expect(savedRow.feature_flags).toEqual(nextFlags);
      expect(savedRow.feature_flags).toContain(appendedFlag);

      // 保存の応答の updated_at (書いたあとの値) が、次の保存の条件としてそのまま使える
      const again = await apiCall(
        'PATCH',
        `/api/super-admin/feature-packages/${testPackageId}`,
        superAdminUser.jwt,
        { feature_flags: [...nextFlags, 'test_flag_c'], expected_updated_at: savedRow.updated_at }
      );
      expect(again.status).toBe(200);
      expect((await readPackage()).feature_flags).toEqual([...nextFlags, 'test_flag_c']);
    });
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

  // #2064: 遷移表 (active → deprecated。deprecated は終端) に無い変更は 409 で断り、書かず監査ログも残さない
  // (以前は同じ状態への変更 active → active や廃止の取り消しが 200 で通り、監査ログが残った)
  it('409 OP_FEATURE_PACKAGE_INVALID_TRANSITION for active → active: 状態は変わらず、監査ログも残らない', async () => {
    const countAudits = async () => {
      const { count, error } = await supabaseAdmin
        .from('admin_audit_logs')
        .select('id', { count: 'exact', head: true })
        .eq('target_id', testPackageId);
      if (error) throw new Error(`Failed to count the audit logs: ${error.message}`);
      return count ?? 0;
    };
    const auditsBefore = await countAudits();
    const res = await apiCall(
      'PATCH',
      `/api/super-admin/feature-packages/${testPackageId}`,
      superAdminUser.jwt,
      { status: 'active' }
    );
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('OP_FEATURE_PACKAGE_INVALID_TRANSITION');
    const { data: row, error } = await supabaseAdmin.from('feature_packages').select('status').eq('id', testPackageId).single();
    if (error) throw new Error(`Failed to read the feature package: ${error.message}`);
    expect(row.status).toBe('active');
    expect(await countAudits()).toBe(auditsBefore);
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
