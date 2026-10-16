/**
 * GET /api/admin/users/{id}/login-history (#1720 段 D。docs/design/cross/16-auth-history-sessions.md §14.9・§20.2)
 *
 * - support は 403 (requireRole(['admin', 'super_admin']))。DB も監査も触らない
 * - admin は直近 LOGIN_HISTORY_PAGE_SIZE (20) 件を返し、admin.user.view_login_history を 1 行記録する (details は件数だけ)
 * - 行は getSupabaseAdmin() の client で読み、recordAdminAudit には createClient() の client を渡す (service_role の client を渡さない)
 * - 0 件のときは記録しない
 * - UUID でなければ 404 (DB に触れない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError, MfaRequiredError } from '@/lib/auth/errors';
import { LOGIN_HISTORY_PAGE_SIZE } from '@/lib/auth/sessions/constants';
import { LoginHistoryResponseSchema } from '@/lib/auth/sessions/schemas';

const mockRequireRole = vi.hoisted(() => vi.fn());
const mockLoggerError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (...errorArgs: unknown[]) => mockLoggerError(...errorArgs),
    withUser: () => logger,
  };
  return { createLogger: () => logger, generateRequestId: () => 'req_test' };
});

type QueryResult = { data: unknown; error: unknown };
interface CallRecord {
  readonly table: string;
  readonly method: string;
  readonly args: readonly unknown[];
}
interface FakeClient {
  readonly from: ReturnType<typeof vi.fn>;
  readonly calls: CallRecord[];
}

/**
 * from(table) ごとに、テーブルの結果を返す supabase-js の偽物。チェーンのメソッド (select / eq / order / limit / insert) は
 * 呼び出しを記録して自身を返し、await で結果になる。結果の無いテーブルを触ったら例外 (触ってはいけない client の検出)
 */
function makeClient(results: Record<string, QueryResult>): FakeClient {
  const calls: CallRecord[] = [];
  const from = vi.fn((table: string) => {
    const result = results[table];
    if (!result) throw new Error(`unexpected from("${table}")`);
    const builder: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
              Promise.resolve(result).then(onFulfilled, onRejected);
          }
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args });
            return builder;
          };
        },
      },
    );
    return builder;
  });
  return { from, calls };
}

let userScopedClient: FakeClient;
let serviceRoleClient: FakeClient;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(userScopedClient),
  getSupabaseAdmin: () => serviceRoleClient,
}));

const { GET } = await import('@/app/api/admin/users/[id]/login-history/route');

const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const adminActor = { id: ADMIN_ID, email: 'admin@example.com', roles: ['admin'], organization_id: null };
/** 監査の details に混ざってはいけない値 (閲覧した IP・端末名) */
const SECRET_IP = '203.0.113.77';
const SECRET_DEVICE_NAME = 'iPhone 15 Pro (iOS 18.0)';
const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const INSERT_OK: QueryResult = { data: null, error: null };

function sessionId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/** user_sessions_metadata の 1 行 (SessionRowSchema の全列) */
function sessionRow(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: sessionId(index),
    user_id: TARGET_ID,
    ip_address: SECRET_IP,
    ip_network: '203.0.113.0/24',
    user_agent: IPHONE_SAFARI_UA,
    device_name: null,
    device_family: 'ios/safari',
    country_code: 'JP',
    context_source: 'web',
    created_at: '2026-10-15T01:00:00+00:00',
    last_active_at: '2026-10-15T02:00:00+00:00',
    revoked_at: null,
    ended_reason: null,
    is_new_device: false,
    is_new_ip: false,
    is_new_country: false,
    alert_status: 'done',
    alert_claimed_at: null,
    alert_attempts: 0,
    alert_sent_at: null,
    ...overrides,
  };
}

function get(id: string) {
  return GET(new Request(`http://localhost/api/admin/users/${id}/login-history`, { method: 'GET' }), {
    params: Promise.resolve({ id }),
  });
}

function auditInserts(client: FakeClient) {
  return client.calls.filter((c) => c.table === 'admin_audit_logs' && c.method === 'insert');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(adminActor);
  userScopedClient = makeClient({ admin_audit_logs: INSERT_OK });
  serviceRoleClient = makeClient({ user_sessions_metadata: { data: [], error: null } });
});

describe('GET /api/admin/users/{id}/login-history (cross/16 §14.9)', () => {
  it('support は 403 (requireRole に admin / super_admin だけを渡す)。履歴を読まず、監査も記録しない', async () => {
    mockRequireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED'));
    const res = await get(TARGET_ID);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } });
    expect(mockRequireRole).toHaveBeenCalledWith(['admin', 'super_admin']);
    expect(serviceRoleClient.from).not.toHaveBeenCalled();
    expect(userScopedClient.from).not.toHaveBeenCalled();
  });

  it('二段階認証が未完了 (MfaRequiredError) も 403 で、履歴を読まない', async () => {
    mockRequireRole.mockRejectedValue(new MfaRequiredError('AUTH_2FA_REQUIRED'));
    const res = await get(TARGET_ID);
    expect(res.status).toBe(403);
    expect(serviceRoleClient.from).not.toHaveBeenCalled();
  });

  it('未ログインは 401 (nested の本文)', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));
    const res = await get(TARGET_ID);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'AUTH_UNAUTHENTICATED', message: '認証が必要です' } });
    expect(serviceRoleClient.from).not.toHaveBeenCalled();
  });

  it('admin は 20 件を返し admin.user.view_login_history を 1 行記録する (details は返した件数だけ)', async () => {
    const rows = Array.from({ length: LOGIN_HISTORY_PAGE_SIZE }, (_, i) => sessionRow(i + 1));
    serviceRoleClient = makeClient({ user_sessions_metadata: { data: rows, error: null } });

    const res = await get(TARGET_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await res.json();
    const parsed = LoginHistoryResponseSchema.parse(body.data);
    expect(parsed.entries).toHaveLength(LOGIN_HISTORY_PAGE_SIZE);

    // 対象の利用者の行を created_at の降順で 20 件だけ読む
    const reads = serviceRoleClient.calls.filter((c) => c.table === 'user_sessions_metadata');
    expect(reads).toContainEqual({ table: 'user_sessions_metadata', method: 'eq', args: ['user_id', TARGET_ID] });
    expect(reads).toContainEqual({ table: 'user_sessions_metadata', method: 'limit', args: [LOGIN_HISTORY_PAGE_SIZE] });

    const inserts = auditInserts(userScopedClient);
    expect(inserts).toHaveLength(1);
    const row = inserts[0].args[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      actor_id: ADMIN_ID,
      action_type: 'admin.user.view_login_history',
      target_id: TARGET_ID,
      target_type: 'user',
      details: { returned_count: LOGIN_HISTORY_PAGE_SIZE },
      severity: 'info',
    });
    // 閲覧した値 (IP・端末名) は監査の details に入れない
    expect(JSON.stringify(row.details)).not.toContain(SECRET_IP);
  });

  it('行は getSupabaseAdmin() の client で読み、recordAdminAudit には createClient() の client を渡す (service_role の client を渡さない)', async () => {
    serviceRoleClient = makeClient({ user_sessions_metadata: { data: [sessionRow(1)], error: null } });
    const res = await get(TARGET_ID);
    expect(res.status).toBe(200);
    // service_role の client: 履歴を読むだけで、監査の表には触れない
    expect(serviceRoleClient.from.mock.calls.map((c) => c[0])).toEqual(['user_sessions_metadata']);
    expect(auditInserts(serviceRoleClient)).toHaveLength(0);
    // 利用者の client: 監査の 1 行だけで、履歴の表は読まない (RLS では他人の行が見えない)
    expect(userScopedClient.from.mock.calls.map((c) => c[0])).toEqual(['admin_audit_logs']);
    expect(auditInserts(userScopedClient)).toHaveLength(1);
  });

  it('0 件のときは記録しない (200 で entries は空)', async () => {
    const res = await get(TARGET_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { entries: [] } });
    expect(userScopedClient.from).not.toHaveBeenCalled();
  });

  it('UUID でなければ 404。履歴を読まず、監査も記録しない', async () => {
    const res = await get('not-a-uuid');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
    expect(serviceRoleClient.from).not.toHaveBeenCalled();
    expect(userScopedClient.from).not.toHaveBeenCalled();
  });

  it('各行を本人の画面と同じ形にする: device_label は UA から・端末名はそのまま・ended_at は revoked_at・印と alert_sent_at はそのまま', async () => {
    serviceRoleClient = makeClient({
      user_sessions_metadata: {
        data: [
          sessionRow(1, {
            device_name: SECRET_DEVICE_NAME,
            revoked_at: '2026-10-15T03:00:00+00:00',
            ended_reason: 'revoked_by_user',
            is_new_device: true,
            is_new_ip: null,
            is_new_country: false,
            alert_sent_at: '2026-10-15T01:01:00+00:00',
          }),
        ],
        error: null,
      },
    });
    const res = await get(TARGET_ID);
    const body = await res.json();
    expect(body.data.entries).toEqual([
      {
        session_id: sessionId(1),
        created_at: '2026-10-15T01:00:00+00:00',
        last_active_at: '2026-10-15T02:00:00+00:00',
        device_label: 'iPhone・iPad の Safari',
        device_name: SECRET_DEVICE_NAME,
        ip_address: SECRET_IP,
        country_code: 'JP',
        ended_at: '2026-10-15T03:00:00+00:00',
        ended_reason: 'revoked_by_user',
        is_new_device: true,
        is_new_ip: null,
        is_new_country: false,
        alert_sent_at: '2026-10-15T01:01:00+00:00',
      },
    ]);
    // 内部の列 (通知の状態・取り置き・試行回数・UA の生の値) は返さない
    expect(body.data.entries[0]).not.toHaveProperty('alert_status');
    expect(JSON.stringify(body)).not.toContain(IPHONE_SAFARI_UA);
  });

  it('履歴の読み取りが失敗したら 500 (nested・DB の文を本文に出さない)。監査は記録しない', async () => {
    serviceRoleClient = makeClient({
      user_sessions_metadata: { data: null, error: { message: 'relation secret_detail does not exist', code: '42P01' } },
    });
    const res = await get(TARGET_ID);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('secret_detail');
    expect(userScopedClient.from).not.toHaveBeenCalled();
  });

  it('監査の記録が失敗しても閲覧は止めない (200 で entries を返し、失敗はログに残る)', async () => {
    serviceRoleClient = makeClient({ user_sessions_metadata: { data: [sessionRow(1)], error: null } });
    userScopedClient = makeClient({
      admin_audit_logs: { data: null, error: { message: 'permission denied for table admin_audit_logs', code: '42501' } },
    });
    const res = await get(TARGET_ID);
    expect(res.status).toBe(200);
    expect((await res.json()).data.entries).toHaveLength(1);
    expect(mockLoggerError).toHaveBeenCalled();
  });
});
