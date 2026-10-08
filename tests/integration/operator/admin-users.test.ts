/**
 * Integration tests: GET/PATCH /api/admin/users, freeze, impersonate
 * Roles: admin, super_admin, support
 * Auth boundary: 401 (no auth), 403 (general user)
 *
 * freeze の解除 (DELETE) は admin-moderation-detail.test.ts にある。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUserWithRoles, cleanupTestUser, cleanupAuditLogs, testEmail, type TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';
import { expectError, randomUuid } from '../helpers/admin-test-utils';

const TS = Date.now();

let adminUser: TestUser;
let superAdminUser: TestUser;
let supportUser: TestUser;
let generalUser: TestUser;
let targetUser: TestUser;
// impersonate 専用の対象。targetUser は freeze のテストで凍結されるため、凍結中は impersonate できない
// (#1030) 仕様と干渉しないよう、凍結しない別ユーザーを使う。
let impersonateTarget: TestUser;

beforeAll(async () => {
  [adminUser, superAdminUser, supportUser, generalUser, targetUser, impersonateTarget] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('superadmin', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('support', TS), roles: ['support'] }),
    createTestUserWithRoles({ email: testEmail('general', TS), roles: ['user'] }),
    createTestUserWithRoles({ email: testEmail('target', TS), roles: ['user'] }),
    createTestUserWithRoles({ email: testEmail('imp-target', TS), roles: ['user'] }),
  ]);
}, 60000);

afterAll(async () => {
  // Cleanup audit logs first to avoid FK issues
  await Promise.all([
    cleanupAuditLogs(adminUser.userId),
    cleanupAuditLogs(superAdminUser.userId),
    cleanupAuditLogs(supportUser.userId),
  ]);

  // Unfreeze target users before cleanup
  await supabaseAdmin
    .from('user_profiles')
    .update({ frozen_at: null, frozen_reason: null, frozen_by: null, unban_at: null })
    .in('id', [targetUser.userId, impersonateTarget.userId]);

  await Promise.all([
    cleanupTestUser(adminUser.userId),
    cleanupTestUser(superAdminUser.userId),
    cleanupTestUser(supportUser.userId),
    cleanupTestUser(generalUser.userId),
    cleanupTestUser(targetUser.userId),
    cleanupTestUser(impersonateTarget.userId),
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
  });

  it('200 for super_admin', async () => {
    const res = await apiCall('GET', `/api/admin/users/${targetUser.userId}`, superAdminUser.jwt);
    expect(res.status).toBe(200);
  });

  it('200 for support', async () => {
    const res = await apiCall('GET', `/api/admin/users/${targetUser.userId}`, supportUser.jwt);
    expect(res.status).toBe(200);
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

describe('POST /api/admin/users/[id]/impersonate', () => {
  it('200 for super_admin - returns a token and writes an audit log with impersonated_by', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/users/${impersonateTarget.userId}/impersonate`,
      superAdminUser.jwt,
      { reason: 'Integration test impersonation' }
    );
    expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(200);
    const data = (res.body as { data: { impersonation_token: string; expires_at: string } }).data;
    expect(data.impersonation_token).toEqual(expect.any(String));
    expect(new Date(data.expires_at).getTime()).toBeGreaterThan(Date.now());

    // 監査ログに impersonated_by 付きで残る
    const { data: logs } = await supabaseAdmin
      .from('admin_audit_logs')
      .select('*')
      .eq('actor_id', superAdminUser.userId)
      .eq('action_type', 'impersonate')
      .eq('target_id', impersonateTarget.userId)
      .order('created_at', { ascending: false })
      .limit(1);
    expect(logs).toHaveLength(1);
    expect(logs![0].impersonated_by).toBe(superAdminUser.userId);
    expect(logs![0].details).toMatchObject({ reason: 'Integration test impersonation' });
  });

  it('403 AUTH_IMPERSONATION_TARGET_FROZEN when the target user is frozen (#1030)', async () => {
    // 凍結中のユーザーとして振る舞うセッションを発行できてしまうと、凍結を迂回できる。
    // freeze のテストの結果に依存しないよう、service_role で確実に凍結してから呼ぶ。
    await supabaseAdmin
      .from('user_profiles')
      .update({
        frozen_at: new Date().toISOString(),
        frozen_reason: '[spam] impersonate test',
        frozen_by: adminUser.userId,
        unban_at: null,
      })
      .eq('id', targetUser.userId);

    const res = await apiCall(
      'POST',
      `/api/admin/users/${targetUser.userId}/impersonate`,
      superAdminUser.jwt,
      { reason: 'Impersonating a frozen user must be refused' }
    );
    expectError(res, 403, 'AUTH_IMPERSONATION_TARGET_FROZEN');
  });

  it('404 AUTH_IMPERSONATION_TARGET_NOT_FOUND for a user that does not exist', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/users/${randomUuid()}/impersonate`,
      superAdminUser.jwt,
      { reason: 'Non-existent user' }
    );
    expectError(res, 404, 'AUTH_IMPERSONATION_TARGET_NOT_FOUND');
  });

  it('400 for a missing reason (validation error)', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/users/${impersonateTarget.userId}/impersonate`,
      superAdminUser.jwt,
      { reason: '' }
    );
    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('403 for admin (admin cannot impersonate)', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/users/${targetUser.userId}/impersonate`,
      adminUser.jwt,
      { reason: 'Admin should not impersonate' }
    );
    expect(res.status).toBe(403);
  });

  it('403 for general user', async () => {
    const res = await apiCall(
      'POST',
      `/api/admin/users/${targetUser.userId}/impersonate`,
      generalUser.jwt,
      { reason: 'General user should not impersonate' }
    );
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth(
      'POST',
      `/api/admin/users/${targetUser.userId}/impersonate`,
      { reason: 'No auth impersonate' }
    );
    expect(res.status).toBe(401);
  });
});
