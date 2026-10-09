/**
 * Integration tests:
 *   GET    /api/super-admin/exports
 *   POST   /api/super-admin/exports
 *   GET    /api/super-admin/exports/[id]
 *   DELETE /api/super-admin/exports/[id]
 *   (PUT / PATCH も同様)
 *
 * データエクスポートは準備中 (未対応) で、全メソッドが 501 OP_NOT_SUPPORTED を返す (#1126)。
 * Roles: super_admin only
 * Auth boundary: 403 (admin), 401 (no auth)。認可が先で、権限のある人にだけ 501 を返す。
 *
 * 以前は、ファイルを作る処理が無いまま依頼を受け付け、利用者本人の GDPR 削除要求の表 (gdpr_deletion_requests) を
 * 代用していた。依頼 (POST) は存在しない列に書こうとして失敗し、偽の ID で 201 を返していた。
 * キャンセル (DELETE) は、実在する本人の削除要求に cancelled_at を入れて取り消してしまう。
 * ここでは、実 DB で次を確かめる。
 *   - どのメソッドも 501 で、成功に見える応答 (201・偽の ID) を返さない
 *   - POST は gdpr_deletion_requests に行を作らない
 *   - DELETE は、実在する本人の GDPR 削除要求を取り消さない (cancelled_at が入らず、監査ログも残らない)
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
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

let superAdminUser: TestUser;
let adminUser: TestUser;
/** GDPR 削除要求の本人 */
let subjectUser: TestUser;
/** 本人の GDPR 削除要求 (実在する行。エクスポートの API が触れてはならない) */
let gdprRequestId: string;

interface ErrorBody {
  error?: { code?: string; message?: string };
  data?: unknown;
}

async function gdprRow(id: string) {
  const { data, error } = await supabaseAdmin
    .from('gdpr_deletion_requests')
    .select('id, cancelled_at, executed_at')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`gdpr_deletion_requests select: ${error?.message}`);
  return data as { id: string; cancelled_at: string | null; executed_at: string | null };
}

async function gdprRowCount(userId: string) {
  const { count, error } = await supabaseAdmin
    .from('gdpr_deletion_requests')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw new Error(`gdpr_deletion_requests count: ${error.message}`);
  return count ?? 0;
}

async function auditLogCount(targetId: string) {
  const { count, error } = await supabaseAdmin
    .from('admin_audit_logs')
    .select('id', { count: 'exact', head: true })
    .eq('target_id', targetId);
  if (error) throw new Error(`admin_audit_logs count: ${error.message}`);
  return count ?? 0;
}

beforeAll(async () => {
  [superAdminUser, adminUser, subjectUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('exports-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('exports-admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('exports-subject', TS), roles: ['user'] }),
  ]);

  const { data, error } = await supabaseAdmin
    .from('gdpr_deletion_requests')
    .insert({ user_id: subjectUser.userId })
    .select('id')
    .single();
  if (error || !data) throw new Error(`gdpr_deletion_requests insert: ${error?.message}`);
  gdprRequestId = data.id as string;

  // 初回のアクセスは Next がルートをコンパイルするので、テスト本体の時間切れを避けるため先に呼んでおく
  await apiCall('GET', '/api/super-admin/exports', superAdminUser.jwt);
  await apiCall('GET', `/api/super-admin/exports/${UNKNOWN_ID}`, superAdminUser.jwt);
}, 120_000);

afterAll(async () => {
  if (gdprRequestId) {
    await supabaseAdmin.from('admin_audit_logs').delete().eq('target_id', gdprRequestId);
    await supabaseAdmin.from('gdpr_deletion_requests').delete().eq('id', gdprRequestId);
  }

  await Promise.all([
    cleanupAuditLogs(superAdminUser.userId),
    cleanupAuditLogs(adminUser.userId),
  ]);

  await Promise.all([
    cleanupTestUser(superAdminUser.userId),
    cleanupTestUser(adminUser.userId),
    cleanupTestUser(subjectUser.userId),
  ]);
}, 30000);

// ─────────────────────────────────────────
// GET / POST / PUT / PATCH / DELETE /api/super-admin/exports
// ─────────────────────────────────────────

describe('/api/super-admin/exports', () => {
  it.each(METHODS)('501 OP_NOT_SUPPORTED for super_admin: %s', async (method) => {
    const res = await apiCall<ErrorBody>(
      method,
      '/api/super-admin/exports',
      superAdminUser.jwt,
      method === 'GET' ? undefined : { export_type: 'audit_logs', format: 'csv', mask_pii: true },
    );
    expect(res.status).toBe(501);
    expect(res.body.error?.code).toBe('OP_NOT_SUPPORTED');
    expect(res.body.error?.message).toContain('準備中（未対応）');
    // 成功に見える応答 (一覧・偽の依頼 ID) を返さない
    expect(res.body.data).toBeUndefined();
  });

  it('501 for super_admin POST even with an invalid body (no validation, no side effects)', async () => {
    const res = await apiCall<ErrorBody>('POST', '/api/super-admin/exports', superAdminUser.jwt, {
      export_type: 'invalid_type',
      format: 'csv',
    });
    expect(res.status).toBe(501);
    expect(res.body.error?.code).toBe('OP_NOT_SUPPORTED');
  });

  it('POST does not create a gdpr_deletion_requests row (the table was used as a stand-in for exports)', async () => {
    const before = await gdprRowCount(superAdminUser.userId);

    const res = await apiCall('POST', '/api/super-admin/exports', superAdminUser.jwt, {
      export_type: 'audit_logs',
      format: 'csv',
    });

    expect(res.status).toBe(501);
    expect(await gdprRowCount(superAdminUser.userId)).toBe(before);
  });

  it.each(METHODS)('403 for admin: %s', async (method) => {
    const res = await apiCall(method, '/api/super-admin/exports', adminUser.jwt, method === 'GET' ? undefined : {});
    expect(res.status).toBe(403);
  });

  it.each(METHODS)('401 for no auth: %s', async (method) => {
    const res = await apiCallNoAuth(method, '/api/super-admin/exports', method === 'GET' ? undefined : {});
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// GET / DELETE ... /api/super-admin/exports/[id]
// ─────────────────────────────────────────

describe('/api/super-admin/exports/[id]', () => {
  it.each(METHODS)('501 OP_NOT_SUPPORTED for super_admin: %s (an existing id)', async (method) => {
    const res = await apiCall<ErrorBody>(
      method,
      `/api/super-admin/exports/${gdprRequestId}`,
      superAdminUser.jwt,
      method === 'GET' || method === 'DELETE' ? undefined : {},
    );
    expect(res.status).toBe(501);
    expect(res.body.error?.code).toBe('OP_NOT_SUPPORTED');
    expect(res.body.data).toBeUndefined();
  });

  it('501 for an id that does not exist or is not a UUID (not 404: the feature itself is not supported)', async () => {
    for (const id of [UNKNOWN_ID, 'not-a-uuid']) {
      const get = await apiCall<ErrorBody>('GET', `/api/super-admin/exports/${id}`, superAdminUser.jwt);
      expect(get.status, `GET ${id}`).toBe(501);
      const del = await apiCall<ErrorBody>('DELETE', `/api/super-admin/exports/${id}`, superAdminUser.jwt);
      expect(del.status, `DELETE ${id}`).toBe(501);
    }
  });

  it("DELETE does not cancel the data subject's real GDPR deletion request (no cancelled_at, no audit log)", async () => {
    const res = await apiCall('DELETE', `/api/super-admin/exports/${gdprRequestId}`, superAdminUser.jwt);
    expect(res.status).toBe(501);

    const row = await gdprRow(gdprRequestId);
    expect(row.cancelled_at).toBeNull();
    expect(row.executed_at).toBeNull();
    expect(await auditLogCount(gdprRequestId)).toBe(0);
  });

  it.each(METHODS)('403 for admin: %s', async (method) => {
    const res = await apiCall(
      method,
      `/api/super-admin/exports/${gdprRequestId}`,
      adminUser.jwt,
      method === 'GET' || method === 'DELETE' ? undefined : {},
    );
    expect(res.status).toBe(403);
    expect((await gdprRow(gdprRequestId)).cancelled_at).toBeNull();
  });

  it.each(METHODS)('401 for no auth: %s', async (method) => {
    const res = await apiCallNoAuth(
      method,
      `/api/super-admin/exports/${gdprRequestId}`,
      method === 'GET' || method === 'DELETE' ? undefined : {},
    );
    expect(res.status).toBe(401);
    expect((await gdprRow(gdprRequestId)).cancelled_at).toBeNull();
  });
});
