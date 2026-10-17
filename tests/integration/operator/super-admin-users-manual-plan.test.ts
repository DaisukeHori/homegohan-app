/**
 * Integration tests: GET/POST/DELETE /api/super-admin/users/[id]/manual-plan (billing/02 §9・テスト 49)
 * Roles: super_admin only (AAL2 のセッション。createTestUserWithRoles が TOTP を登録して aal2 の JWT にする)
 * Auth boundary: 403 (admin, support, general), 401 (no auth)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestUserWithRoles, cleanupTestUser, cleanupAuditLogs, testEmail, type TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';
import { dataOf, expectError, latestAuditLog, randomUuid } from '../helpers/admin-test-utils';
import { jstDayOffset } from '@/lib/jst-day-ranges';

const TS = Date.now();

let superAdminUser: TestUser;
let adminUser: TestUser;
let supportUser: TestUser;
let generalUser: TestUser;
let targetUser: TestUser;

const GRANT_REASON = 'integration test manual grant (#1797)';
const REVOKE_REASON = 'integration test manual revoke (#1797)';
/** 付与できるプラン (public の personal / family) */
const GRANTABLE_PLAN_KEYS = ['pro', 'family_basic', 'family_pro'] as const;
/** 画面の選択肢に出ないプラン (free は 0 円、org は組織ライセンス、family_addon は private のアドオン) */
const NON_GRANTABLE_PLAN_KEYS = ['free', 'org_standard', 'family_addon'] as const;
/**
 * plans に無いプランの名前 (付与できないことを確かめる)。
 * 名前に KEY を含めない: 「…KEYS, '<文字列>'」の並びが gitleaks の generic-api-key に誤検知されるため。
 */
const UNKNOWN_PLAN = 'no_such_plan_1797';

interface ManualPlanView {
  current: { plan_key: string; status: string; source: 'stripe' | 'manual'; expires_at: string | null } | null;
  plans: Array<{ plan_key: string }>;
  history: Array<{ action_type: string; plan_key: string | null; reason: string | null }>;
}

function pathOf(userId: string): string {
  return `/api/super-admin/users/${userId}/manual-plan`;
}

beforeAll(async () => {
  [superAdminUser, adminUser, supportUser, generalUser, targetUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('manualplan-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('manualplan-admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('manualplan-support', TS), roles: ['support'] }),
    createTestUserWithRoles({ email: testEmail('manualplan-general', TS), roles: ['user'] }),
    createTestUserWithRoles({ email: testEmail('manualplan-target', TS), roles: ['user'] }),
  ]);
}, 60000);

afterAll(async () => {
  // 付与の行は利用者の削除で CASCADE。監査の行 (target が対象の利用者) は actor で消える
  await supabaseAdmin.from('personal_subscriptions').delete().eq('user_id', targetUser.userId);
  await Promise.all([
    cleanupAuditLogs(superAdminUser.userId),
    cleanupAuditLogs(adminUser.userId),
    cleanupAuditLogs(supportUser.userId),
  ]);
  await Promise.all([
    cleanupTestUser(superAdminUser.userId),
    cleanupTestUser(adminUser.userId),
    cleanupTestUser(supportUser.userId),
    cleanupTestUser(generalUser.userId),
    cleanupTestUser(targetUser.userId),
  ]);
}, 30000);

describe('manual-plan: 認証の境界', () => {
  it('401 without auth for GET / POST / DELETE', async () => {
    const path = pathOf(targetUser.userId);
    expectError(await apiCallNoAuth('GET', path), 401, 'AUTH_UNAUTHENTICATED');
    expectError(await apiCallNoAuth('POST', path, { plan_key: 'pro', reason: GRANT_REASON }), 401, 'AUTH_UNAUTHENTICATED');
    expectError(await apiCallNoAuth('DELETE', path, { reason: REVOKE_REASON }), 401, 'AUTH_UNAUTHENTICATED');
  });

  it('403 OP_PERMISSION_DENIED for admin / support / general on GET / POST / DELETE', async () => {
    const path = pathOf(targetUser.userId);
    for (const user of [adminUser, supportUser, generalUser]) {
      expectError(await apiCall('GET', path, user.jwt), 403, 'OP_PERMISSION_DENIED');
      expectError(await apiCall('POST', path, user.jwt, { plan_key: 'pro', reason: GRANT_REASON }), 403, 'OP_PERMISSION_DENIED');
      expectError(await apiCall('DELETE', path, user.jwt, { reason: REVOKE_REASON }), 403, 'OP_PERMISSION_DENIED');
    }
    // 403 の呼び出しは何も書かない
    const { data } = await supabaseAdmin.from('personal_subscriptions').select('id').eq('user_id', targetUser.userId);
    expect(data ?? []).toHaveLength(0);
  });
});

describe('manual-plan: super_admin の付与と取り消し', () => {
  it('GET plans contains pro/family_basic/family_pro and no free / org_* / family_addon; POST then GET shows source manual; DELETE then GET shows current null; admin_audit_logs has manual_grant and manual_revoke rows with ip_address and user_agent', async () => {
    const path = pathOf(targetUser.userId);

    // 付与の前: 契約なし。付与できるプランだけが選択肢に出る
    const before = dataOf<ManualPlanView>(await apiCall('GET', path, superAdminUser.jwt));
    expect(before.current).toBeNull();
    const planKeys = before.plans.map((plan) => plan.plan_key);
    for (const planKey of GRANTABLE_PLAN_KEYS) expect(planKeys).toContain(planKey);
    for (const planKey of NON_GRANTABLE_PLAN_KEYS) expect(planKeys).not.toContain(planKey);
    expect(planKeys.some((planKey) => planKey.startsWith('org_'))).toBe(false);

    // 付与 (期限つき): 200 と戻り値
    const expiresOn = jstDayOffset(30);
    const grantResponse = await apiCall('POST', path, superAdminUser.jwt, { plan_key: 'pro', expires_on: expiresOn, reason: GRANT_REASON });
    const granted = dataOf<{ subscription_id: string; user_id: string; plan_key: string; status: string; expires_at: string | null }>(grantResponse);
    expect(granted).toMatchObject({ user_id: targetUser.userId, plan_key: 'pro', status: 'active' });
    expect(granted.expires_at).not.toBeNull();

    // 付与の後: 手動の契約が live。DB 側は Stripe の契約を持たない行
    const afterGrant = dataOf<ManualPlanView>(await apiCall('GET', path, superAdminUser.jwt));
    expect(afterGrant.current).toMatchObject({ plan_key: 'pro', status: 'active', source: 'manual' });
    expect(afterGrant.current?.expires_at).toBe(granted.expires_at);
    expect(afterGrant.history.map((entry) => entry.action_type)).toEqual(['admin.billing.manual_grant']);
    expect(afterGrant.history[0]).toMatchObject({ plan_key: 'pro', reason: GRANT_REASON });
    const { data: rows } = await supabaseAdmin
      .from('personal_subscriptions')
      .select('id, status, stripe_subscription_id')
      .eq('user_id', targetUser.userId);
    expect(rows).toEqual([{ id: granted.subscription_id, status: 'active', stripe_subscription_id: null }]);
    const { data: profile } = await supabaseAdmin.from('user_profiles').select('plan_key_cached').eq('id', targetUser.userId).single();
    expect(profile?.plan_key_cached).toBe('pro');

    // 付与の監査: warn・IP と UA つき
    const grantAudit = await latestAuditLog({ actorId: superAdminUser.userId, actionType: 'admin.billing.manual_grant', targetId: targetUser.userId });
    expect(grantAudit).not.toBeNull();
    expect(grantAudit).toMatchObject({ severity: 'warn', target_type: 'user' });
    expect(grantAudit?.details).toMatchObject({ subscription_id: granted.subscription_id, plan_key: 'pro', reason: GRANT_REASON });
    const { data: grantAuditColumns } = await supabaseAdmin.from('admin_audit_logs').select('ip_address, user_agent').eq('id', grantAudit?.id ?? '').single();
    expect(grantAuditColumns?.ip_address).toBeTruthy();
    expect(grantAuditColumns?.user_agent).toBeTruthy();

    // 付与済みへの付与は 409 (何も書かない)
    expectError(await apiCall('POST', path, superAdminUser.jwt, { plan_key: 'family_basic', reason: GRANT_REASON }), 409, 'OP_SUBSCRIPTION_ALREADY_ACTIVE');

    // 取り消し
    const revokeResponse = await apiCall('DELETE', path, superAdminUser.jwt, { reason: REVOKE_REASON });
    const revoked = dataOf<{ subscription_id: string; status_from: string; status_to: string }>(revokeResponse);
    expect(revoked).toMatchObject({ subscription_id: granted.subscription_id, status_from: 'active', status_to: 'cancelled' });

    // 取り消しの後: 契約なし
    const afterRevoke = dataOf<ManualPlanView>(await apiCall('GET', path, superAdminUser.jwt));
    expect(afterRevoke.current).toBeNull();
    expect(afterRevoke.history.map((entry) => entry.action_type)).toEqual(['admin.billing.manual_revoke', 'admin.billing.manual_grant']);
    const { data: profileAfter } = await supabaseAdmin.from('user_profiles').select('plan_key_cached').eq('id', targetUser.userId).single();
    expect(profileAfter?.plan_key_cached).toBeNull();

    const revokeAudit = await latestAuditLog({ actorId: superAdminUser.userId, actionType: 'admin.billing.manual_revoke', targetId: targetUser.userId });
    expect(revokeAudit).not.toBeNull();
    expect(revokeAudit).toMatchObject({ severity: 'warn', target_type: 'user' });
    expect(revokeAudit?.details).toMatchObject({ subscription_id: granted.subscription_id, plan_key: 'pro', reason: REVOKE_REASON });
    const { data: revokeAuditColumns } = await supabaseAdmin.from('admin_audit_logs').select('ip_address, user_agent').eq('id', revokeAudit?.id ?? '').single();
    expect(revokeAuditColumns?.ip_address).toBeTruthy();
    expect(revokeAuditColumns?.user_agent).toBeTruthy();

    // 取り消すものが無い: 409
    expectError(await apiCall('DELETE', path, superAdminUser.jwt, { reason: REVOKE_REASON }), 409, 'OP_NO_MANUAL_SUBSCRIPTION');
  });

  it('rejects ungrantable plans, a past expiry, a missing user, a non-UUID id and the actor own id', async () => {
    const path = pathOf(targetUser.userId);
    // 付与できないプランは 422 (free / org / private のアドオン / 存在しない)
    for (const planKey of [...NON_GRANTABLE_PLAN_KEYS, UNKNOWN_PLAN]) {
      expectError(await apiCall('POST', path, superAdminUser.jwt, { plan_key: planKey, reason: GRANT_REASON }), 422, 'OP_PLAN_NOT_GRANTABLE');
    }
    // 有効期限が今日 (JST) は 400
    expectError(await apiCall('POST', path, superAdminUser.jwt, { plan_key: 'pro', expires_on: jstDayOffset(0), reason: GRANT_REASON }), 400, 'OP_INVALID_INPUT');
    // 利用者がいない / UUID でない
    expectError(await apiCall('GET', pathOf(randomUuid()), superAdminUser.jwt), 404, 'NOT_FOUND');
    expectError(await apiCall('POST', pathOf(randomUuid()), superAdminUser.jwt, { plan_key: 'pro', reason: GRANT_REASON }), 404, 'NOT_FOUND');
    expectError(await apiCall('GET', '/api/super-admin/users/not-a-uuid/manual-plan', superAdminUser.jwt), 404, 'NOT_FOUND');
    // 自分自身は本文の検証より前に 403 (本文が不正でも)
    expectError(await apiCall('POST', pathOf(superAdminUser.userId), superAdminUser.jwt, { plan_key: 'pro', reason: GRANT_REASON }), 403, 'OP_SELF_MODIFY');
    expectError(await apiCall('POST', pathOf(superAdminUser.userId), superAdminUser.jwt, {}), 403, 'OP_SELF_MODIFY');
    expectError(await apiCall('DELETE', pathOf(superAdminUser.userId), superAdminUser.jwt, { reason: REVOKE_REASON }), 403, 'OP_SELF_MODIFY');
    // GET は自分でも読める
    expect((await apiCall('GET', pathOf(superAdminUser.userId), superAdminUser.jwt)).status).toBe(200);

    // どれも行を書いていない
    const { data } = await supabaseAdmin.from('personal_subscriptions').select('id').eq('user_id', targetUser.userId).eq('status', 'active');
    expect(data ?? []).toHaveLength(0);
  });
});
