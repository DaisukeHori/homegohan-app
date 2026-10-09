/**
 * #1103 (項目 5): PATCH /api/admin/users/[id] の管理ノート (admin_note)
 *
 * 以前は user_profiles.admin_note 列へ UPDATE していたが、その列は本番にもリポジトリにも無く、常に 500 だった。
 * 修正後は admin_user_notes (運営ロールだけが読み書きできる内部メモ) に 1 行追加する。
 *
 * 確かめること:
 *  - user_profiles を UPDATE しない (列を足さない。本人の行は本人が全列読めるため、内部メモを置かない)
 *  - admin_user_notes に { user_id, admin_id = 操作した本人, note = 前後の空白を除いた値 } を 1 行追加する
 *  - 監査ログは admin.user.note_add で、details はノートの ID だけ (本文を入れない)
 *  - 権限 (admin / super_admin)・UUID でない id・存在しないユーザー・空白だけ / 長すぎるノート・壊れた JSON
 *  - DB エラーは汎用の 500 (生のエラー文を返さない)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { ADMIN_NOTE_MAX_LENGTH } from '@/lib/admin/users-schemas';

const mockRequireRole = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
    withUser: () => logger,
  };
  return { createLogger: () => logger, generateRequestId: () => 'req_test' };
});

type QueryResult = { data?: unknown; error?: unknown };
type Call = { table: string; method: string; args: unknown[] };

/** テーブルごとに結果を返す簡易 Supabase モック。チェーンの呼び出しを全部記録する */
function makeClient(tables: Record<string, QueryResult>) {
  const calls: Call[] = [];
  const from = vi.fn((table: string) => {
    const result = tables[table];
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
            if (prop === 'single' || prop === 'maybeSingle') return Promise.resolve(result);
            return builder;
          };
        },
      },
    );
    return builder;
  });
  return { from, calls };
}

let userScopedClient: ReturnType<typeof makeClient>;
let serviceRoleClient: ReturnType<typeof makeClient>;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(userScopedClient),
  getSupabaseAdmin: () => serviceRoleClient,
}));

const route = await import('@/app/api/admin/users/[id]/route');

const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOTE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function patchRequest(body: unknown, raw = false): Request {
  return new Request(`http://localhost/api/admin/users/${TARGET_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

function callsOf(client: ReturnType<typeof makeClient>, table: string, method: string) {
  return client.calls.filter((c) => c.table === table && c.method === method);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({ id: ADMIN_ID, roles: ['admin'] });
  serviceRoleClient = makeClient({ user_profiles: { data: { id: TARGET_ID }, error: null } });
  userScopedClient = makeClient({
    admin_user_notes: { data: { id: NOTE_ID }, error: null },
    admin_audit_logs: { data: null, error: null },
  });
});

describe('PATCH /api/admin/users/[id] — 管理ノートの追加 (#1103 項目 5)', () => {
  it('admin_user_notes に 1 行追加し、user_profiles は UPDATE しない (前後の空白は除く)', async () => {
    const res = await route.PATCH(patchRequest({ admin_note: '  要注意ユーザー  ' }), { params: { id: TARGET_ID } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true, note_id: NOTE_ID } });

    expect(callsOf(userScopedClient, 'admin_user_notes', 'insert')).toEqual([
      { table: 'admin_user_notes', method: 'insert', args: [{ user_id: TARGET_ID, admin_id: ADMIN_ID, note: '要注意ユーザー' }] },
    ]);
    // user_profiles には存在確認の SELECT だけ (列の UPDATE をしない)
    expect(serviceRoleClient.calls.filter((c) => c.table === 'user_profiles').map((c) => c.method)).toEqual([
      'select',
      'eq',
      'maybeSingle',
    ]);
    expect(callsOf(serviceRoleClient, 'user_profiles', 'eq')[0].args).toEqual(['id', TARGET_ID]);
    expect(userScopedClient.calls.some((c) => c.table === 'user_profiles')).toBe(false);
  });

  it('監査ログは admin.user.note_add で、details はノートの ID だけ (本文を入れない)', async () => {
    await route.PATCH(patchRequest({ admin_note: '内部メモの本文' }), { params: { id: TARGET_ID } });

    const audits = callsOf(userScopedClient, 'admin_audit_logs', 'insert');
    expect(audits).toHaveLength(1);
    const row = audits[0].args[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      actor_id: ADMIN_ID,
      action_type: 'admin.user.note_add',
      target_id: TARGET_ID,
      target_type: 'user',
      details: { note_id: NOTE_ID },
    });
    expect(JSON.stringify(row)).not.toContain('内部メモの本文');
  });

  it('super_admin も追加できる (requireRole に admin / super_admin を渡す)', async () => {
    mockRequireRole.mockResolvedValue({ id: ADMIN_ID, roles: ['super_admin'] });
    const res = await route.PATCH(patchRequest({ admin_note: 'note' }), { params: { id: TARGET_ID } });
    expect(res.status).toBe(200);
    expect(mockRequireRole).toHaveBeenCalledWith(['admin', 'super_admin']);
  });

  it('未ログインは 401、権限なし (support など) は 403。どちらも DB に触れない', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    const unauth = await route.PATCH(patchRequest({ admin_note: 'x' }), { params: { id: TARGET_ID } });
    expect(unauth.status).toBe(401);

    mockRequireRole.mockRejectedValueOnce(new ForbiddenError('OP_PERMISSION_DENIED'));
    const forbidden = await route.PATCH(patchRequest({ admin_note: 'x' }), { params: { id: TARGET_ID } });
    expect(forbidden.status).toBe(403);

    expect(serviceRoleClient.from).not.toHaveBeenCalled();
    expect(userScopedClient.from).not.toHaveBeenCalled();
  });

  it('id が UUID でなければ 404 (DB に渡さない)', async () => {
    const res = await route.PATCH(patchRequest({ admin_note: 'x' }), { params: { id: 'not-a-uuid' } });
    expect(res.status).toBe(404);
    expect(serviceRoleClient.from).not.toHaveBeenCalled();
  });

  it('対象ユーザーがいなければ 404 で、ノートを追加しない', async () => {
    serviceRoleClient = makeClient({ user_profiles: { data: null, error: null } });
    const res = await route.PATCH(patchRequest({ admin_note: 'x' }), { params: { id: TARGET_ID } });
    expect(res.status).toBe(404);
    expect(userScopedClient.from).not.toHaveBeenCalled();
  });

  it.each([
    ['空文字', ''],
    ['空白だけ', ' \n\t '],
    ['上限を超える長さ', 'あ'.repeat(ADMIN_NOTE_MAX_LENGTH + 1)],
    ['文字列でない', 123],
  ])('admin_note が %s なら 400 VALIDATION_ERROR で、何も書かない', async (_name, value) => {
    const res = await route.PATCH(patchRequest({ admin_note: value }), { params: { id: TARGET_ID } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect(serviceRoleClient.from).not.toHaveBeenCalled();
    expect(userScopedClient.from).not.toHaveBeenCalled();
  });

  it('上限ちょうどの長さは追加できる', async () => {
    const res = await route.PATCH(patchRequest({ admin_note: 'あ'.repeat(ADMIN_NOTE_MAX_LENGTH) }), {
      params: { id: TARGET_ID },
    });
    expect(res.status).toBe(200);
  });

  it('壊れた JSON は 400 INVALID_JSON', async () => {
    const res = await route.PATCH(patchRequest('{', true), { params: { id: TARGET_ID } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_JSON');
  });

  it.each([
    ['対象ユーザーの確認', 'user_profiles'],
    ['ノートの追加', 'admin_user_notes'],
  ])('%s が DB エラーなら汎用の 500 (生のエラー文を返さない)', async (_name, table) => {
    const dbError = { message: 'relation "secret_table" does not exist', code: '42P01' };
    if (table === 'user_profiles') {
      serviceRoleClient = makeClient({ user_profiles: { data: null, error: dbError } });
    } else {
      userScopedClient = makeClient({
        admin_user_notes: { data: null, error: dbError },
        admin_audit_logs: { data: null, error: null },
      });
    }
    const res = await route.PATCH(patchRequest({ admin_note: 'x' }), { params: { id: TARGET_ID } });
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('INTERNAL_ERROR');
    expect(text).not.toContain('secret_table');
    expect(mockLoggerError).toHaveBeenCalled();
    // 失敗したときは監査ログ (note_add) を残さない
    expect(callsOf(userScopedClient, 'admin_audit_logs', 'insert')).toEqual([]);
  });
});
