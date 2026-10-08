/**
 * Integration tests: GET/PATCH /api/admin/users, freeze (+ impersonate が無いこと)
 * Roles: admin, super_admin, support
 * Auth boundary: 401 (no auth), 403 (general user)
 *
 * freeze の解除 (DELETE) は admin-moderation-detail.test.ts にある。
 * impersonate (なりすまし) は #1124 で API ごと削除した。無いこと (404) をこのファイルの末尾で確認する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUserWithRoles, cleanupTestUser, cleanupAuditLogs, testEmail, type TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';
import { expectError } from '../helpers/admin-test-utils';

const TS = Date.now();

let adminUser: TestUser;
let superAdminUser: TestUser;
let supportUser: TestUser;
let generalUser: TestUser;
let targetUser: TestUser;

beforeAll(async () => {
  [adminUser, superAdminUser, supportUser, generalUser, targetUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('superadmin', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('support', TS), roles: ['support'] }),
    createTestUserWithRoles({ email: testEmail('general', TS), roles: ['user'] }),
    createTestUserWithRoles({ email: testEmail('target', TS), roles: ['user'] }),
  ]);
}, 60000);

afterAll(async () => {
  // Cleanup audit logs first to avoid FK issues
  await Promise.all([
    cleanupAuditLogs(adminUser.userId),
    cleanupAuditLogs(superAdminUser.userId),
    cleanupAuditLogs(supportUser.userId),
  ]);

  // Unfreeze target user before cleanup
  await supabaseAdmin
    .from('user_profiles')
    .update({ frozen_at: null, frozen_reason: null, frozen_by: null, unban_at: null })
    .eq('id', targetUser.userId);

  await Promise.all([
    cleanupTestUser(adminUser.userId),
    cleanupTestUser(superAdminUser.userId),
    cleanupTestUser(supportUser.userId),
    cleanupTestUser(generalUser.userId),
    cleanupTestUser(targetUser.userId),
  ]);
}, 30000);

describe('GET /api/admin/users', () => {
  it('200 for admin', async () => {
    const res = await apiCall('GET', '/api/admin/users', adminUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
  });

  it('200 for super_admin', async () => {
    const res = await apiCall('GET', '/api/admin/users', superAdminUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  it('200 for support', async () => {
    const res = await apiCall('GET', '/api/admin/users', supportUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  // #1145: メールアドレスは admin / super_admin にだけ返す (詳細は tests/integration/security/admin-users-email.test.ts)
  it('admin: メールアドレスで検索でき、email が返る (#1145)', async () => {
    const res = await apiCall('GET', `/api/admin/users?q=${encodeURIComponent(targetUser.email)}`, adminUser.jwt);
    expect(res.status).toBe(200);
    const items = (res.body as { data: Array<{ id: string; email: string | null }> }).data;
    const item = items.find((u) => u.id === targetUser.userId);
    expect(item?.email).toBe(targetUser.email);
  });

  it('support: メールアドレスで検索しても見つからず、email は返らない (#1145)', async () => {
    const res = await apiCall('GET', `/api/admin/users?q=${encodeURIComponent(targetUser.email)}`, supportUser.jwt);
    expect(res.status).toBe(200);
    const items = (res.body as { data: Array<{ id: string; email: string | null }> }).data;
    expect(items.find((u) => u.id === targetUser.userId)).toBeUndefined();
    expect(items.every((u) => u.email === null)).toBe(true);
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/admin/users', generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/admin/users');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/users/[id]', () => {
  it('200 for admin with valid user id', async () => {
    const res = await apiCall('GET', `/api/admin/users/${targetUser.userId}`, adminUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect((res.body as { data: { id: string } }).data.id).toBe(targetUser.userId);
    // #1145: admin には auth.users のメールアドレスが返る
    expect((res.body as { data: { email: string | null } }).data.email).toBe(targetUser.email);
  });

  it('200 for super_admin', async () => {
    const res = await apiCall('GET', `/api/admin/users/${targetUser.userId}`, superAdminUser.jwt);
    expect(res.status).toBe(200);
    expect((res.body as { data: { email: string | null } }).data.email).toBe(targetUser.email);
  });

  it('200 for support (メールアドレスは返らない)', async () => {
    const res = await apiCall('GET', `/api/admin/users/${targetUser.userId}`, supportUser.jwt);
    expect(res.status).toBe(200);
    // #1145: support には email を返さない
    expect((res.body as { data: { email: string | null } }).data.email).toBeNull();
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', `/api/admin/users/${targetUser.userId}`, generalUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', `/api/admin/users/${targetUser.userId}`);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/admin/users/[id]', () => {
  // 既知の不具合 (#1103 項目 5): user_profiles に admin_note 列が無く (本番スキーマも同じ)、
  // UPDATE が「column does not exist」で失敗して常に 500 になる。直ったら `.fails` を外すこと。
  it.fails('[既知の不具合 #1103] 200 for admin and inserts audit log (現状は admin_note 列が無く 500)', async () => {
    const res = await apiCall('PATCH', `/api/admin/users/${targetUser.userId}`, adminUser.jwt, {
      admin_note: 'Integration test note',
    });
    expect(res.status).toBe(200);
    expect((res.body as { data: { success: boolean } }).data.success).toBe(true);

    // Verify audit log was inserted
    const { data: logs } = await supabaseAdmin
      .from('admin_audit_logs')
      .select('*')
      .eq('actor_id', adminUser.userId)
      .eq('action_type', 'admin.user.note_update')
      .eq('target_id', targetUser.userId)
      .order('created_at', { ascending: false })
      .limit(1);

    expect(logs).toHaveLength(1);
    expect(logs![0].actor_id).toBe(adminUser.userId);
  });

  it('403 for support (support cannot PATCH)', async () => {
    const res = await apiCall('PATCH', `/api/admin/users/${targetUser.userId}`, supportUser.jwt, {
      admin_note: 'Should not work',
    });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('PATCH', `/api/admin/users/${targetUser.userId}`, {
      admin_note: 'No auth test',
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/users/[id]/freeze', () => {
  it('200 for admin and inserts audit log', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/users/${targetUser.userId}/freeze`,
      adminUser.jwt,
      {
        ban_type: 'temporary',
        reason_category: 'spam',
        reason_detail: 'Integration test freeze',
        duration_days: 1,
        notify_user: false,
      }
    );
    expect(res.status).toBe(200);
    const body = res.body as { data: { ban_id: string; unban_at: string } };
    expect(body.data).toHaveProperty('ban_id');
    expect(body.data).toHaveProperty('unban_at');

    // Verify audit log
    const { data: logs } = await supabaseAdmin
      .from('admin_audit_logs')
      .select('*')
      .eq('actor_id', adminUser.userId)
      .eq('action_type', 'admin.user.ban')
      .eq('target_id', targetUser.userId)
      .order('created_at', { ascending: false })
      .limit(1);

    expect(logs).toHaveLength(1);
    expect(logs![0].details).toMatchObject({
      ban_type: 'temporary',
      reason_category: 'spam',
    });
  });

  it('403 for general user', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/users/${targetUser.userId}/freeze`,
      generalUser.jwt,
      {
        ban_type: 'temporary',
        reason_category: 'spam',
        reason_detail: 'Should fail',
        duration_days: 1,
        notify_user: false,
      }
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth(
      'POST',
      `/api/admin/users/${targetUser.userId}/freeze`,
      {
        ban_type: 'temporary',
        reason_category: 'spam',
        reason_detail: 'No auth test',
        duration_days: 1,
        notify_user: false,
      }
    );
    expect(res.status).toBe(401);
  });
});

// #1124: なりすまし (impersonate) は提供しない。
// 以前の POST /api/admin/users/[id]/impersonate は、トークンを監査ログに平文で書くだけで、
// 受け取って使う側がどこにも無かったため、API ごと削除した (サポートは読み取り専用のユーザー画面で対応する)。
// 最も強い権限 (super_admin) でも 404 になり、監査ログ (action_type = 'impersonate') も増えないことを確認する。
describe('POST /api/admin/users/[id]/impersonate (提供しない: #1124)', () => {
  it('404 for super_admin (API は削除済み) and writes no audit log', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/users/${targetUser.userId}/impersonate`,
      superAdminUser.jwt,
      { reason: 'impersonate は提供しない' }
    );
    expectError(res, 404);

    const { data: logs, error } = await supabaseAdmin
      .from('admin_audit_logs')
      .select('id')
      .eq('actor_id', superAdminUser.userId)
      .eq('action_type', 'impersonate');
    expect(error).toBeNull();
    expect(logs).toHaveLength(0);
  });
});
