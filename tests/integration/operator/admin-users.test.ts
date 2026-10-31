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
import { SUPER_ADMIN_FREEZE_REJECTED_MESSAGE } from '@/lib/admin/user-ban';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import ws from 'ws';

/** ログインした本人の JWT で RLS を通る client (PostgREST に直接問い合わせる) */
function userScopedClient(jwt: string): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

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
  // PATCH が追加した管理ノート (admin_user_notes.admin_id は auth.users を ON DELETE なしで参照するため、ユーザーより先に消す)
  await supabaseAdmin.from('admin_user_notes').delete().eq('user_id', targetUser.userId);

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

  // #2107 Y10: 退会で user_profiles の行は消える (auth.users への外部キーが ON DELETE CASCADE) ので、削除済みの絞り込みは常に 0 件。
  // 以前は status=deleted に絞り込みが無く、生きているユーザー (ここでは対象のユーザー) を削除済みの一覧として返していた
  it('status=deleted は、いるユーザーを返さず 0 件 (同じ検索の status=active では返る) (#2107 Y10)', async () => {
    const q = encodeURIComponent(targetUser.email);
    const active = await apiCall('GET', `/api/admin/users?q=${q}&status=active`, adminUser.jwt);
    expect(active.status).toBe(200);
    const activeItems = (active.body as { data: Array<{ id: string }> }).data;
    expect(activeItems.map((u) => u.id)).toContain(targetUser.userId);

    const deleted = await apiCall('GET', `/api/admin/users?q=${q}&status=deleted`, adminUser.jwt);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ data: [], meta: { total: 0 } });

    // 検索語なし (全ユーザー) でも 0 件
    const deletedAll = await apiCall('GET', '/api/admin/users?status=deleted', adminUser.jwt);
    expect(deletedAll.status).toBe(200);
    expect(deletedAll.body).toMatchObject({ data: [], meta: { total: 0 } });
  });

  // #2112 Z5: plan を受けたら plan_key_cached で絞る (応答の plan_key と同じ意味で、free は plan_key_cached が NULL か 'free')。
  // 以前は plan を監査の検索条件に残すだけで絞らず、全プランの利用者を返していた。
  // 検索語 (このファイルのテストの利用者のメールに共通する部分) で、このファイルの利用者だけに絞ってから比べる
  it('plan=pro は pro の利用者だけ、plan=free は plan_key_cached が NULL か free の利用者だけを返す (#2112 Z5)', async () => {
    const q = encodeURIComponent(`-${TS}@homegohan.test`);
    const setPlan = async (userId: string, planKeyCached: string | null) => {
      const { error } = await supabaseAdmin.from('user_profiles').update({ plan_key_cached: planKeyCached }).eq('id', userId);
      expect(error).toBeNull();
    };
    await setPlan(targetUser.userId, 'pro');
    await setPlan(generalUser.userId, 'free');
    try {
      type ListBody = { data: Array<{ id: string; plan_key: string }>; meta: { total: number } };

      // 絞らないときは pro と free (NULL を含む) の両方が出る
      const all = await apiCall('GET', `/api/admin/users?q=${q}`, adminUser.jwt);
      expect(all.status).toBe(200);
      const allIds = (all.body as ListBody).data.map((u) => u.id);
      expect(allIds).toEqual(expect.arrayContaining([targetUser.userId, generalUser.userId, supportUser.userId]));

      const pro = await apiCall('GET', `/api/admin/users?q=${q}&plan=pro`, adminUser.jwt);
      expect(pro.status).toBe(200);
      const proBody = pro.body as ListBody;
      expect(proBody.data.map((u) => u.id)).toEqual([targetUser.userId]);
      expect(proBody.data.every((u) => u.plan_key === 'pro')).toBe(true);
      expect(proBody.meta.total).toBe(1);

      const free = await apiCall('GET', `/api/admin/users?q=${q}&plan=free`, adminUser.jwt);
      expect(free.status).toBe(200);
      const freeBody = free.body as ListBody;
      const freeIds = freeBody.data.map((u) => u.id);
      // plan_key_cached が 'free' の利用者 (generalUser) と NULL の利用者 (supportUser など) の両方
      expect(freeIds).toEqual(expect.arrayContaining([generalUser.userId, supportUser.userId]));
      expect(freeIds).not.toContain(targetUser.userId);
      expect(freeBody.data.every((u) => u.plan_key === 'free')).toBe(true);
      expect(freeBody.meta.total).toBe(freeIds.length);

      // 件数より後ろのページは、同じ plan の絞り込みで数え直した件数を返す
      const beyond = await apiCall('GET', `/api/admin/users?q=${q}&plan=pro&page=9`, adminUser.jwt);
      expect(beyond.status).toBe(200);
      expect(beyond.body).toMatchObject({ data: [], meta: { total: 1 } });
    } finally {
      await setPlan(targetUser.userId, null);
      await setPlan(generalUser.userId, null);
    }
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
  // #1103 (項目 5): 以前は存在しない user_profiles.admin_note 列へ UPDATE して常に 500 だった。
  // 管理ノートは admin_user_notes に 1 行追加する (本人には読めない運営の内部メモ)。
  it('200 for admin: admin_user_notes に 1 行追加され、admin.user.note_add が本文なしで記録される', async () => {
    const noteText = `Integration test note ${TS}`;
    const res = await apiCall('PATCH', `/api/admin/users/${targetUser.userId}`, adminUser.jwt, {
      admin_note: `  ${noteText}  `,
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: { success: boolean; note_id: string } };
    expect(body.data.success).toBe(true);

    const { data: notes } = await supabaseAdmin
      .from('admin_user_notes')
      .select('id, user_id, admin_id, note')
      .eq('user_id', targetUser.userId)
      .eq('admin_id', adminUser.userId);
    expect(notes).toEqual([
      { id: body.data.note_id, user_id: targetUser.userId, admin_id: adminUser.userId, note: noteText },
    ]);

    const { data: logs } = await supabaseAdmin
      .from('admin_audit_logs')
      .select('*')
      .eq('actor_id', adminUser.userId)
      .eq('action_type', 'admin.user.note_add')
      .eq('target_id', targetUser.userId);
    expect(logs).toHaveLength(1);
    expect(logs![0].details).toEqual({ note_id: body.data.note_id });
  });

  it('200 for super_admin', async () => {
    const res = await apiCall('PATCH', `/api/admin/users/${targetUser.userId}`, superAdminUser.jwt, {
      admin_note: 'super_admin note',
    });
    expect(res.status).toBe(200);
    const { data: notes } = await supabaseAdmin
      .from('admin_user_notes')
      .select('note')
      .eq('user_id', targetUser.userId)
      .eq('admin_id', superAdminUser.userId);
    expect(notes).toEqual([{ note: 'super_admin note' }]);
  });

  it('対象ユーザー本人は自分の管理ノートを読めない (RLS)', async () => {
    const { data, error } = await userScopedClient(targetUser.jwt).from('admin_user_notes').select('id').eq('user_id', targetUser.userId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('404 for unknown user (何も追加しない)', async () => {
    const unknownId = '00000000-0000-4000-8000-000000000000';
    const res = await apiCall('PATCH', `/api/admin/users/${unknownId}`, adminUser.jwt, { admin_note: 'x' });
    expect(res.status).toBe(404);
    const { data } = await supabaseAdmin.from('admin_user_notes').select('id').eq('user_id', unknownId);
    expect(data).toEqual([]);
  });

  it('400 for blank note (空白だけのノートは追加しない)', async () => {
    const res = await apiCall('PATCH', `/api/admin/users/${targetUser.userId}`, adminUser.jwt, { admin_note: '   ' });
    expect(res.status).toBe(400);
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

  // #2026 凍結の通知メール (cross/24 §12 I-1)。結合テストの環境は RESEND_API_KEY の有無で sent (email_outbox に 1 行) か skipped (行なし) になる
  it('I-1 notify_user: true で凍結すると 200 で data.notification.status が sent か skipped (RESEND_API_KEY の有無) で、監査の details.notification.status が同じ値。sent なら email_outbox に template account_frozen・user_id = 対象の行が 1 行', async () => {
    const res = await apiCall('POST', `/api/admin/users/${targetUser.userId}/freeze`, adminUser.jwt, {
      ban_type: 'temporary',
      reason_category: 'spam',
      reason_detail: 'Integration test freeze (notify)',
      duration_days: 1,
      notify_user: true,
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: { ban_id: string; notification: { status: string; reason?: string } } };
    expect(['sent', 'skipped']).toContain(body.data.notification.status);

    const { data: logs } = await supabaseAdmin
      .from('admin_audit_logs')
      .select('details')
      .eq('actor_id', adminUser.userId)
      .eq('action_type', 'admin.user.ban')
      .eq('target_id', targetUser.userId)
      .order('created_at', { ascending: false })
      .limit(1);
    expect(logs).toHaveLength(1);
    const details = logs![0].details as { ban_id: string; notification: { status: string; reason: string | null; outbox_id: string | null } };
    expect(details.ban_id).toBe(body.data.ban_id);
    expect(details.notification.status).toBe(body.data.notification.status);

    const { data: outboxRows, error: outboxError } = await supabaseAdmin
      .from('email_outbox')
      .select('id, template, user_id, idempotency_key, redact_after_send, html_body')
      .eq('idempotency_key', `account-frozen:${body.data.ban_id}`);
    expect(outboxError).toBeNull();
    try {
      if (body.data.notification.status === 'sent') {
        expect(outboxRows).toHaveLength(1);
        expect(outboxRows![0]).toMatchObject({
          id: details.notification.outbox_id,
          template: 'account_frozen',
          user_id: targetUser.userId,
          redact_after_send: false,
          html_body: null,
        });
      } else {
        expect(details.notification).toEqual({ status: 'skipped', reason: 'not_configured', outbox_id: null });
        expect(outboxRows).toHaveLength(0);
      }
    } finally {
      await supabaseAdmin.from('email_outbox').delete().eq('idempotency_key', `account-frozen:${body.data.ban_id}`);
    }
  });

  // 凍結の UPDATE は「読んだ時点の super_admin でない状態のまま」の条件つき (roles が NULL なら roles IS NULL、そうでなければ
  // roles が super_admin を含まない)。本物の PostgREST で、どちらの条件も 1 行に当たる (凍結できる) ことと、super_admin は凍結されないことを確かめる
  // (上の『200 for admin』が roles = ['user'] の条件を通る)
  // (読んでから書くまでに super_admin になる割り込みの再現は tests/user-freeze-super-admin-race.test.ts)
  it('roles が NULL の利用者も凍結できる (200)', async () => {
    const { error: nullError } = await supabaseAdmin.from('user_profiles').update({ roles: null }).eq('id', targetUser.userId);
    expect(nullError).toBeNull();
    try {
      const res = await apiCall('POST', `/api/admin/users/${targetUser.userId}/freeze`, adminUser.jwt, {
        ban_type: 'temporary',
        reason_category: 'spam',
        reason_detail: 'Integration test freeze (roles NULL)',
        duration_days: 1,
        notify_user: false,
      });
      expect(res.status).toBe(200);
      const { data: profile } = await supabaseAdmin
        .from('user_profiles')
        .select('frozen_at')
        .eq('id', targetUser.userId)
        .single();
      expect(profile?.frozen_at).not.toBeNull();
    } finally {
      await supabaseAdmin.from('user_profiles').update({ roles: ['user'] }).eq('id', targetUser.userId);
    }
  });

  it('super_admin は凍結しない (403 OP_TARGET_PROTECTED。frozen_at は NULL のまま)', async () => {
    const res = await apiCall('POST', `/api/admin/users/${superAdminUser.userId}/freeze`, adminUser.jwt, {
      ban_type: 'temporary',
      reason_category: 'spam',
      reason_detail: 'Should not freeze a super_admin',
      duration_days: 1,
      notify_user: false,
    });
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string; message: string } }).error).toEqual({
      code: 'OP_TARGET_PROTECTED',
      // 凍結のフォームはこの文をそのまま出すので、ロールの呼び名は運営の画面の表示名 (#2134 U1-1)
      message: SUPER_ADMIN_FREEZE_REJECTED_MESSAGE,
    });
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('frozen_at')
      .eq('id', superAdminUser.userId)
      .single();
    expect(profile?.frozen_at).toBeNull();
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
